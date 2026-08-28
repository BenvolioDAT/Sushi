const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');

const STATES = Object.freeze([
    'IDLE', 'LOADING_INPUTS', 'REACTING', 'UNLOADING',
    'PREPARING_BOOSTS', 'BOOSTING_SQUAD', 'CLEANING', 'ERROR'
]);

function roomState(roomName) {
    const labs = HiveMemory.ensure().resources.labs;
    if (!labs[roomName]) {
        labs[roomName] = {
            state: 'IDLE', stateStartTick: Game.time, reactionGoal: null,
            inputLabIds: [], outputLabIds: [], jobs: [], debugReason: 'No reaction goal'
        };
    }
    return labs[roomName];
}

function transition(state, next, reason) {
    if (!STATES.includes(next) || state.state === next) return false;
    state.state = next;
    state.stateStartTick = Game.time;
    state.updatedTick = Game.time;
    state.debugReason = reason;
    return true;
}

function configureReaction(roomName, product, targetAmount = 3000, options = {}) {
    if (!roomName || !product) return null;
    const state = roomState(roomName);
    state.reactionGoal = {
        product,
        targetAmount: Math.max(5, Math.floor(targetAmount)),
        priority: Number.isFinite(options.priority) ? options.priority : 50,
        operationId: options.operationId || null,
        configuredTick: Game.time
    };
    if (state.state === 'IDLE') transition(state, 'LOADING_INPUTS', `Preparing ${product}`);
    return state.reactionGoal;
}

function clearReaction(roomName) {
    const state = roomState(roomName);
    state.reactionGoal = null;
    if (state.state !== 'IDLE') transition(state, 'CLEANING', 'Reaction goal cleared');
}

function normalizeRequirements(requirements) {
    const result = {};
    for (const [slot, list] of Object.entries(requirements || {})) {
        result[slot] = (Array.isArray(list) ? list : []).map(item => typeof item === 'string' ?
            { compound: item, parts: 1 } : { compound: item.compound, parts: Math.max(1, item.parts || 1) })
            .filter(item => item.compound);
    }
    return result;
}

function requestBoost(squadId, roomName, requirements, options = {}) {
    if (!squadId || !roomName) return null;
    const boosts = HiveMemory.ensure().resources.boosts;
    boosts[squadId] = {
        squadId,
        roomName,
        requirements: normalizeRequirements(requirements),
        state: boosts[squadId] && boosts[squadId].state || 'PENDING',
        priority: Number.isFinite(options.priority) ? options.priority : 80,
        acceptPartial: options.acceptPartial === true,
        requestedTick: boosts[squadId] && boosts[squadId].requestedTick || Game.time,
        updatedTick: Game.time,
        labsBySlot: boosts[squadId] && boosts[squadId].labsBySlot || {},
        debugReason: 'Waiting for boost preparation'
    };
    return boosts[squadId];
}

function amount(store, resourceType) {
    if (!store) return 0;
    if (typeof store.getUsedCapacity === 'function') return store.getUsedCapacity(resourceType) || 0;
    return store[resourceType] || 0;
}

function labMineralType(lab) {
    if (!lab) return null;
    if (lab.mineralType) return lab.mineralType;
    if (lab.store) return Object.keys(lab.store).find(type => type !== RESOURCE_ENERGY && typeof lab.store[type] === 'number' && lab.store[type] > 0) || null;
    return null;
}

function labAmount(lab, resourceType) {
    if (lab.store) return amount(lab.store, resourceType);
    return lab.mineralType === resourceType ? lab.mineralAmount || 0 : 0;
}

function labsInRoom(roomName) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return (byType && byType.get(STRUCTURE_LAB) || []).filter(lab => lab && lab.my !== false)
        .slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function identifyCluster(roomName) {
    const labs = labsInRoom(roomName);
    if (labs.length < 3) return { inputs: [], outputs: [], all: labs };
    let best = null;
    for (let i = 0; i < labs.length; i++) {
        for (let j = i + 1; j < labs.length; j++) {
            const outputs = labs.filter((lab, index) => index !== i && index !== j &&
                lab.pos.getRangeTo(labs[i]) <= 2 && lab.pos.getRangeTo(labs[j]) <= 2);
            if (!best || outputs.length > best.outputs.length) best = { inputs: [labs[i], labs[j]], outputs };
        }
    }
    return best && best.outputs.length ? { ...best, all: labs } : { inputs: [], outputs: [], all: labs };
}

function ingredientsFor(product) {
    if (typeof REACTIONS !== 'object' || !REACTIONS) return null;
    for (const first of Object.keys(REACTIONS).sort()) {
        const row = REACTIONS[first];
        if (!row || typeof row !== 'object') continue;
        for (const second of Object.keys(row).sort()) if (row[second] === product) return [first, second];
    }
    return null;
}

function roomResourceAmount(room, resourceType) {
    return amount(room.storage && room.storage.store, resourceType) +
        amount(room.terminal && room.terminal.store, resourceType);
}

function sourceFor(room, resourceType, minimum = 1) {
    return [room.terminal, room.storage].filter(Boolean)
        .sort((a, b) => amount(b.store, resourceType) - amount(a.store, resourceType))
        .find(structure => amount(structure.store, resourceType) >= minimum) || null;
}

function depositFor(room, resourceType) {
    return [room.terminal, room.storage].filter(Boolean).find(structure => !structure.store ||
        typeof structure.store.getFreeCapacity !== 'function' || structure.store.getFreeCapacity(resourceType) > 0) || null;
}

function fillJob(room, lab, resourceType, amountNeeded, priority, reason) {
    const source = sourceFor(room, resourceType);
    if (!source || amountNeeded <= 0) return null;
    return {
        id: `lab-fill:${lab.id}:${resourceType}`,
        type: 'TRANSFER', roomName: room.name, resourceType,
        amount: Math.min(amountNeeded, amount(source.store, resourceType)),
        sourceId: source.id, targetId: lab.id, priority, reason
    };
}

function unloadJob(room, lab, priority, reason) {
    const resourceType = labMineralType(lab);
    const target = resourceType && depositFor(room, resourceType);
    if (!resourceType || !target) return null;
    return {
        id: `lab-empty:${lab.id}:${resourceType}`,
        type: 'TRANSFER', roomName: room.name, resourceType,
        amount: labAmount(lab, resourceType), sourceId: lab.id, targetId: target.id,
        priority, reason
    };
}

function labEnergyJob(room, lab, priority) {
    const wanted = 1000;
    return fillJob(room, lab, RESOURCE_ENERGY, Math.max(0, wanted - labAmount(lab, RESOURCE_ENERGY)), priority, 'Lab energy');
}

function setJobs(state, jobs) {
    state.jobs = jobs.filter(Boolean).map(job => ({ ...job }));
    state.updatedTick = Game.time;
    return state.jobs;
}

function runReactionState(room, state, cluster) {
    const goal = state.reactionGoal;
    if (!goal) {
        const jobs = cluster.all.map(lab => unloadJob(room, lab, 50, 'Clear unused reaction labs'));
        transition(state, jobs.some(Boolean) ? 'CLEANING' : 'IDLE',
            jobs.some(Boolean) ? 'No reaction goal remains' : 'Labs idle and clean');
        return setJobs(state, jobs);
    }
    const ingredients = ingredientsFor(goal.product);
    if (!ingredients) {
        transition(state, 'ERROR', `No reaction ingredients found for ${goal.product}`);
        return setJobs(state, []);
    }
    if (!cluster.inputs.length || !cluster.outputs.length) {
        transition(state, 'ERROR', 'Three mutually compatible labs are required');
        return setJobs(state, []);
    }
    state.inputLabIds = cluster.inputs.map(lab => lab.id);
    state.outputLabIds = cluster.outputs.map(lab => lab.id);
    const productAmount = roomResourceAmount(room, goal.product) +
        cluster.all.reduce((sum, lab) => sum + labAmount(lab, goal.product), 0);
    if (productAmount >= goal.targetAmount) {
        transition(state, 'UNLOADING', `${goal.product} target reached`);
    }
    const contamination = cluster.inputs.some((lab, index) => labMineralType(lab) && labMineralType(lab) !== ingredients[index]) ||
        cluster.outputs.some(lab => labMineralType(lab) && labMineralType(lab) !== goal.product);
    if (contamination) transition(state, 'CLEANING', 'Lab contamination detected');

    if (state.state === 'CLEANING' || state.state === 'UNLOADING') {
        const jobs = cluster.all.map(lab => unloadJob(room, lab, 75, state.debugReason));
        if (!jobs.some(Boolean) && state.state === 'CLEANING') transition(state, 'LOADING_INPUTS', `Labs clean for ${goal.product}`);
        else if (!jobs.some(Boolean)) {
            state.reactionGoal = null;
            transition(state, 'IDLE', 'Reaction product unloaded');
        }
        return setJobs(state, jobs);
    }
    if (state.state === 'LOADING_INPUTS') {
        const jobs = [];
        cluster.inputs.forEach((lab, index) => {
            jobs.push(fillJob(room, lab, ingredients[index], Math.max(0, 500 - labAmount(lab, ingredients[index])), goal.priority, `Reaction input ${ingredients[index]}`));
            jobs.push(labEnergyJob(room, lab, goal.priority - 1));
        });
        for (const output of cluster.outputs) jobs.push(labEnergyJob(room, output, goal.priority - 1));
        const ready = cluster.inputs.every((lab, index) => labAmount(lab, ingredients[index]) >=
            (typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5));
        if (ready) transition(state, 'REACTING', `Inputs ready for ${goal.product}`);
        return setJobs(state, jobs);
    }
    if (state.state === 'REACTING') {
        const results = [];
        for (const output of cluster.outputs) {
            if (output.cooldown > 0 || typeof output.runReaction !== 'function') continue;
            results.push({ labId: output.id, result: output.runReaction(cluster.inputs[0], cluster.inputs[1]) });
        }
        state.lastReactionResults = results;
        const emptyInput = cluster.inputs.some((lab, index) => labAmount(lab, ingredients[index]) <
            (typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5));
        if (emptyInput) transition(state, 'LOADING_INPUTS', 'Reaction input needs replenishment');
        return setJobs(state, []);
    }
    return setJobs(state, []);
}

function activeBoost(roomName) {
    return Object.values(HiveMemory.ensure().resources.boosts).filter(request =>
        request && request.roomName === roomName && request.state !== 'COMPLETE' && request.state !== 'ABORTED')
        .sort((a, b) => b.priority - a.priority || a.requestedTick - b.requestedTick || a.squadId.localeCompare(b.squadId))[0] || null;
}

function allBoostItems(request) {
    const items = [];
    for (const [slot, requirements] of Object.entries(request.requirements || {})) {
        for (const requirement of requirements) items.push({ slot, ...requirement });
    }
    return items;
}

function liveSquadMember(request, slot) {
    return (TickIndex.get().creepsBySquadId.get(request.squadId) || []).find(creep =>
        creep.memory && creep.memory.squadSlot === slot) || null;
}

function hasBoosts(creep, requirements) {
    if (!creep) return false;
    return (requirements || []).every(requirement => creep.body.filter(part =>
        part.hits > 0 && part.boost === requirement.compound).length >= requirement.parts);
}

function runBoostState(room, state, cluster, request) {
    if (!request) return false;
    const items = allBoostItems(request);
    if (!items.length) {
        request.state = 'COMPLETE';
        transition(state, 'IDLE', 'Boost request required no compounds');
        return true;
    }
    if (cluster.all.length < items.length) {
        state.debugReason = `Need ${items.length} labs for requested compounds; have ${cluster.all.length}`;
        request.debugReason = state.debugReason;
        if (Game.time - request.requestedTick > 500 && !request.acceptPartial) request.state = 'ABORTED';
        return true;
    }
    if (!['PREPARING_BOOSTS', 'BOOSTING_SQUAD'].includes(state.state)) {
        transition(state, 'CLEANING', `Cleaning labs for squad ${request.squadId}`);
    }
    const assigned = items.map((item, index) => ({ ...item, lab: cluster.all[index] }));
    request.labsBySlot = {};
    for (const item of assigned) {
        if (!request.labsBySlot[item.slot]) request.labsBySlot[item.slot] = [];
        request.labsBySlot[item.slot].push({ compound: item.compound, labId: item.lab.id, pos: { x: item.lab.pos.x, y: item.lab.pos.y, roomName: room.name } });
    }
    const contaminated = assigned.some(item => labMineralType(item.lab) && labMineralType(item.lab) !== item.compound) ||
        cluster.all.slice(assigned.length).some(lab => labMineralType(lab));
    if (state.state === 'CLEANING') {
        const jobs = cluster.all.map(lab => unloadJob(room, lab, 95, 'Prepare clean boost labs'));
        if (!jobs.some(Boolean)) transition(state, 'PREPARING_BOOSTS', `Loading boosts for ${request.squadId}`);
        setJobs(state, jobs);
        return true;
    }
    if (contaminated) {
        transition(state, 'CLEANING', 'Boost lab contamination detected');
        setJobs(state, cluster.all.map(lab => unloadJob(room, lab, 95, state.debugReason)));
        return true;
    }
    if (state.state === 'PREPARING_BOOSTS') {
        const jobs = [];
        const mineralPerPart = typeof LAB_BOOST_MINERAL === 'number' ? LAB_BOOST_MINERAL : 30;
        const energyPerPart = typeof LAB_BOOST_ENERGY === 'number' ? LAB_BOOST_ENERGY : 20;
        for (const item of assigned) {
            jobs.push(fillJob(room, item.lab, item.compound,
                Math.max(0, item.parts * mineralPerPart - labAmount(item.lab, item.compound)), 100, `Boost ${item.slot}`));
            jobs.push(fillJob(room, item.lab, RESOURCE_ENERGY,
                Math.max(0, item.parts * energyPerPart - labAmount(item.lab, RESOURCE_ENERGY)), 99, `Boost energy ${item.slot}`));
        }
        const ready = assigned.every(item => labAmount(item.lab, item.compound) >= item.parts * mineralPerPart &&
            labAmount(item.lab, RESOURCE_ENERGY) >= item.parts * energyPerPart);
        if (ready) {
            transition(state, 'BOOSTING_SQUAD', `Boost labs ready for ${request.squadId}`);
            request.state = 'READY';
        }
        else if (request.acceptPartial && Game.time - request.requestedTick > 100) {
            transition(state, 'BOOSTING_SQUAD', `Partial boost stock accepted for ${request.squadId}`);
            request.state = 'PARTIAL_READY';
        }
        else if (!jobs.some(Boolean) && Game.time - request.requestedTick > 500) {
            request.state = 'ABORTED';
            request.debugReason = 'Required boost compounds or energy remained unavailable';
            transition(state, 'ERROR', request.debugReason);
        }
        else request.state = 'LOADING';
        setJobs(state, jobs);
        return true;
    }
    if (state.state === 'BOOSTING_SQUAD') {
        for (const item of assigned) {
            const member = liveSquadMember(request, item.slot);
            if (!member || item.lab.pos.getRangeTo(member) > 1 || typeof item.lab.boostCreep !== 'function') continue;
            item.lab.boostCreep(member, item.parts);
        }
        const complete = Object.entries(request.requirements).every(([slot, requirements]) =>
            hasBoosts(liveSquadMember(request, slot), requirements));
        if (complete || request.acceptPartial && Game.time - request.requestedTick > 125) {
            request.state = 'COMPLETE';
            request.completedTick = Game.time;
            request.partial = !complete;
            request.debugReason = complete ? 'All requested body-part boosts verified' : 'Available partial boosts explicitly accepted';
            transition(state, 'CLEANING', `Boosting complete for ${request.squadId}`);
        }
        else request.state = 'BOOSTING';
        setJobs(state, []);
        return true;
    }
    return true;
}

function boostStockAvailable(room, request, cluster) {
    const mineralPerPart = typeof LAB_BOOST_MINERAL === 'number' ? LAB_BOOST_MINERAL : 30;
    return allBoostItems(request).every(item => {
        const inLabs = cluster.all.reduce((sum, lab) => sum + labAmount(lab, item.compound), 0);
        return roomResourceAmount(room, item.compound) + inLabs >= item.parts * mineralPerPart;
    });
}

function getBoostPositions(squadId, slot) {
    const request = HiveMemory.ensure().resources.boosts[squadId];
    return request && request.labsBySlot && request.labsBySlot[slot] || [];
}

function run(room) {
    const state = roomState(room.name);
    const cluster = identifyCluster(room.name);
    const boost = activeBoost(room.name);
    const reactionNeededFirst = boost && state.reactionGoal && !boostStockAvailable(room, boost, cluster) &&
        !['READY', 'BOOSTING'].includes(boost.state);
    if (boost && !reactionNeededFirst && runBoostState(room, state, cluster, boost)) return { state, jobs: state.jobs, boost };
    if (reactionNeededFirst) boost.state = 'WAITING_RESOURCES';
    if (!boost && (state.state === 'PREPARING_BOOSTS' || state.state === 'BOOSTING_SQUAD')) {
        transition(state, 'CLEANING', 'Boost request ended');
    }
    if (state.state === 'ERROR' && cluster.inputs.length && (!state.reactionGoal || ingredientsFor(state.reactionGoal.product))) {
        transition(state, state.reactionGoal ? 'CLEANING' : 'IDLE', 'Lab configuration recovered');
    }
    if (state.state === 'IDLE' && state.reactionGoal) transition(state, 'LOADING_INPUTS', `Preparing ${state.reactionGoal.product}`);
    runReactionState(room, state, cluster);
    return { state, jobs: state.jobs, boost: null };
}

module.exports = {
    STATES,
    roomState,
    transition,
    configureReaction,
    clearReaction,
    requestBoost,
    identifyCluster,
    ingredientsFor,
    getBoostPositions,
    run,
    amount,
    labMineralType,
    hasBoosts
};
