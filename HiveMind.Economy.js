const RemoteIntel = require('Remote.Intel');
const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const Links = require('Resource.Links');

const STATES = Object.freeze({
    SURVIVAL: 'SURVIVAL',
    RECOVERY: 'RECOVERY',
    STABLE: 'STABLE',
    SURPLUS: 'SURPLUS'
});

const STATE_RANK = Object.freeze({ SURVIVAL: 0, RECOVERY: 1, STABLE: 2, SURPLUS: 3 });
const EXIT_TICKS = Object.freeze({ SURVIVAL: 12, RECOVERY: 40, STABLE: 100 });
const CORE_ROLES = new Set(['Extractor', 'Freighter', 'Foreman']);
const COMBAT_ROLES = new Set(['Ronin', 'Volley', 'Cleric']);
const GROWTH_MODES = Object.freeze({
    MINIMUM: 'GROWTH_MINIMUM',
    NORMAL: 'GROWTH_NORMAL',
    AGGRESSIVE: 'GROWTH_AGGRESSIVE',
    RECOVERY: 'RECOVERY',
    CONTROLLER_EMERGENCY: 'CONTROLLER_EMERGENCY'
});

function energyIn(target) {
    if (!target || !target.store) return 0;
    if (typeof target.store.getUsedCapacity === 'function') {
        return target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }
    return target.store[RESOURCE_ENERGY] || 0;
}

function activeParts(creep, type) {
    if (!creep) return 0;
    if (typeof creep.getActiveBodyparts === 'function') return creep.getActiveBodyparts(type) || 0;
    return (creep.body || []).filter(part => part && part.type === type && part.hits !== 0).length;
}

function bodyParts(body, type) {
    return (body || []).reduce((total, part) => total +
        ((part === type || part && part.type === type) ? 1 : 0), 0);
}

function bodyCost(body) {
    return (body || []).reduce((total, part) => {
        const type = part && part.type || part;
        return total + (typeof BODYPART_COST !== 'undefined' && BODYPART_COST[type] || 0);
    }, 0);
}

function roleReplacementCost(creeps, role, predicate) {
    let cost = 0;
    for (const creep of creeps) {
        if (!creep || !creep.memory || creep.memory.role !== role || predicate && !predicate(creep)) continue;
        cost = Math.max(cost, bodyCost(creep.body));
    }
    return cost;
}

function isRemoteMinerForSource(creep, roomName, info) {
    const memory = creep && creep.memory || {};
    const sourceId = memory.sourceId || memory.targetSourceId || memory.assignedSource;
    return memory.role === 'Extractor' && memory.remoteMining === true &&
        memory.homeRoom === roomName && sourceId === info.sourceId;
}

function remoteIncomeEvidence(roomName, info, sourceMemory) {
    const planned = Math.max(0, info.effectiveEnergyPerTick || 0);
    const harvestPower = typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2;
    let presentWork = 0;
    let stationedWork = 0;
    let hauling = false;
    const sourcePos = sourceMemory && sourceMemory.pos;
    for (const creepName in Game.creeps) {
        const creep = Game.creeps[creepName];
        if (isRemoteMinerForSource(creep, roomName, info) && !creep.spawning &&
            creep.pos && creep.pos.roomName === info.roomName) {
            const work = activeParts(creep, WORK);
            presentWork += work;
            if (!sourcePos || typeof creep.pos.getRangeTo !== 'function' ||
                creep.pos.getRangeTo(sourcePos.x, sourcePos.y) <= 1) stationedWork += work;
        }
        const memory = creep && creep.memory || {};
        if (memory.role === 'Freighter' && memory.homeRoom === roomName &&
            (memory.pickupSourceId === info.sourceId ||
                memory.freighterJob === 'remote' && memory.pickupRoom === info.roomName)) hauling = true;
    }
    const haul = sourceMemory && sourceMemory.haul;
    const observedRecently = !!(haul && haul.lastSeen >= Game.time - 100 &&
        ((haul.amount || 0) > 0 || haul.lastAdvertisedAt >= Game.time - 100));
    const deliveredRecently = !!(haul && haul.lastDeliveryAt >=
        Game.time - Math.max(100, (info.distance || 1) * 3));
    const workIncome = Math.min(planned, stationedWork * harvestPower);
    let realized = 0;
    if (workIncome > 0 && observedRecently) realized = workIncome * (deliveredRecently ? 1 : hauling ? 0.6 : 0.4);
    else if (presentWork > 0) realized = Math.min(planned, presentWork * harvestPower) * 0.25;
    return {
        planned,
        realized: Math.round(realized * 1000) / 1000,
        presentWork,
        stationedWork,
        observedRecently,
        deliveredRecently,
        hauling
    };
}

function remoteEconomy(roomName) {
    const roomMemory = Memory.rooms && Memory.rooms[roomName];
    const planner = roomMemory && roomMemory.remotePlanner;
    const sourceInfos = planner && planner.sourceInfos || {};
    const activeIds = planner && Array.isArray(planner.activeSourceIds) ? planner.activeSourceIds : [];
    let gross = 0;
    let net = 0;
    let backlog = 0;
    let reservedCarry = 0;
    let reservedSources = 0;
    let unreservedSources = 0;
    let requiredCarry = 0;
    let oldestHaulAge = 0;
    let plannedIncome = 0;
    let provenIncome = 0;
    let provenSources = 0;
    let operationalSources = 0;
    for (const id of activeIds) {
        const info = sourceInfos[id];
        if (!info || !info.active || info.operational === false || (info.route && info.route.valid === false)) continue;
        operationalSources++;
        const sourceMemory = Memory.rooms && Memory.rooms[info.roomName] &&
            Memory.rooms[info.roomName].sources && Memory.rooms[info.roomName].sources[id];
        const evidence = remoteIncomeEvidence(roomName, info, sourceMemory);
        plannedIncome += evidence.planned;
        provenIncome += evidence.realized;
        gross += evidence.realized;
        net += evidence.planned > 0 ? Math.max(0, info.currentNetEPT !== undefined ? info.currentNetEPT : info.netIncome || 0) *
            (evidence.realized / evidence.planned) : 0;
        if (evidence.planned > 0 && evidence.realized >= evidence.planned * 0.8) provenSources++;
        const haul = sourceMemory && sourceMemory.haul;
        backlog += haul && Math.max(0, haul.amount || 0) || 0;
        reservedCarry += haul && Math.max(0, haul.reservedCarry || 0) || 0;
        if (haul && haul.lastSeen > 0) oldestHaulAge = Math.max(oldestHaulAge, Game.time - haul.lastSeen);
        const carryCapacity = typeof CARRY_CAPACITY === 'number' ? CARRY_CAPACITY : 50;
        requiredCarry += Math.ceil(Math.max(0, info.effectiveEnergyPerTick || 0) *
            Math.max(1, info.roundTripTicks || info.route && info.route.estimatedRoundTripTicks ||
                (info.distance || 1) * 2) / carryCapacity);
        const reservation = RemoteIntel.getEffectiveReservation(info.roomName);
        if (reservation && reservation.username) reservedSources++;
        else unreservedSources++;
    }
    return { gross, net, plannedIncome, provenIncome, provenSources,
        backlog, reservedCarry, activeSources: operationalSources, operationalSources,
        selectedSources: activeIds.length, portfolioSources: Object.keys(sourceInfos).length,
        candidateSources: Object.keys(sourceInfos).filter(id => sourceInfos[id] && sourceInfos[id].score > 0).length,
        reservedSources, unreservedSources, requiredCarry, oldestHaulAge };
}

function queuedCriticalReplacementCost(queue, roomName) {
    return (queue || []).reduce((largest, request) => {
        const memory = request && request.memory || {};
        const role = request && (request.role || memory.role);
        const localMiner = role === 'Extractor' && memory.remoteMining !== true &&
            (!memory.sourceRoom || memory.sourceRoom === roomName);
        return localMiner || role === 'Freighter' || role === 'Foreman' ?
            Math.max(largest, bodyCost(request.body)) : largest;
    }, 0);
}

function preStorageReserve(room, snapshot, creeps, spawns, queue, costs) {
    const capacity = Math.max(300, room.energyCapacityAvailable || 300);
    const protectedEnergy = Math.max(0, snapshot.protectedStockpileEnergy || 0);
    const attainable = capacity + protectedEnergy;
    const localHealthy = snapshot.harvest.workActive >= Math.max(1, snapshot.harvest.workRequired * 0.9);
    const queuedCritical = queuedCriticalReplacementCost(queue, room.name);
    const economicSpawnInProgress = spawns.some(spawn => {
        const spawning = spawn && spawn.spawning;
        const creep = spawning && Game.creeps[spawning.name];
        return creep && creep.memory && ['Extractor', 'Freighter', 'Foreman'].includes(creep.memory.role);
    });
    let imminent = queuedCritical;
    if (snapshot.replacementRisk > 0 && !economicSpawnInProgress) {
        imminent = Math.max(imminent, costs.localMiner, costs.freighter, costs.foreman);
    }
    /* Healthy rooms protect a recoverable miner floor plus one refill margin, not every future body. */
    const recoveryFloor = localHealthy ? 200 : Math.max(200, costs.localMiner);
    const refillMargin = Math.max(50, Math.round(capacity * 0.1 / 50) * 50);
    const target = Math.max(recoveryFloor + refillMargin, imminent > 0 ? imminent + refillMargin : 0);
    return Math.min(attainable, Math.ceil(target / 50) * 50);
}

function criticalConstruction(room) {
    const criticalTypes = new Set([
        STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_STORAGE,
        STRUCTURE_CONTAINER, STRUCTURE_LINK, STRUCTURE_TERMINAL
    ]);
    const sites = TickIndex.get().constructionSitesByRoom.get(room.name) || [];
    let sitesCount = 0;
    let progressRemaining = 0;
    for (const site of sites) {
        if (!site || site.my === false || !criticalTypes.has(site.structureType)) continue;
        sitesCount++;
        progressRemaining += Math.max(0, (site.progressTotal || 0) - (site.progress || 0));
    }
    return { sites: sitesCount, progressRemaining };
}

/*
 * Before Storage, protect the next recoverable/imminent failure and leave attainable
 * growth headroom. Once Storage exists, retain one realistic replacement wave.
 * Long-run replacement depreciation remains part of the per-tick budget below.
 */
function buildGrowthPolicy(room, snapshot, creeps, spawns) {
    const rcl = room.controller && room.controller.level || 1;
    const capacity = Math.max(300, room.energyCapacityAvailable || 300);
    const localMiner = roleReplacementCost(creeps, 'Extractor', creep => isLocalExtractor(creep, room.name)) ||
        Math.min(capacity, 550);
    const remoteMiner = roleReplacementCost(creeps, 'Extractor', creep => !isLocalExtractor(creep, room.name));
    const freighter = roleReplacementCost(creeps, 'Freighter') || Math.min(capacity, 600);
    const foreman = roleReplacementCost(creeps, 'Foreman') || Math.min(capacity, 400);
    const tech = roleReplacementCost(creeps, 'Tech') || Math.min(capacity, 300);
    const remoteCycle = remoteMiner > 0 ? remoteMiner + freighter : 0;
    const threat = HiveMemory.ensure().threats[room.name];
    const defenseBuffer = threat && threat.harmfulHostileCount > 0 ? capacity * 2 :
        (rcl >= 4 ? capacity : Math.ceil(capacity * 0.5));
    const queue = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].spawn &&
        Memory.rooms[room.name].spawn.queue || [];
    const hasStorage = !!room.storage;
    const reserveTarget = hasStorage ?
        Math.ceil((foreman + localMiner + freighter + tech + remoteCycle + defenseBuffer) / 100) * 100 :
        preStorageReserve(room, snapshot, creeps, spawns, queue, { localMiner, freighter, foreman });
    const storedEnergy = snapshot.storageEnergy + snapshot.terminalEnergy + snapshot.energyAvailable +
        (hasStorage ? 0 : Math.max(0, snapshot.protectedStockpileEnergy || 0));
    const energyAboveReserve = Math.max(0, storedEnergy - reserveTarget);
    const remote = remoteEconomy(room.name);
    remote.availableCarry = Math.max(snapshot.haul.remoteCarry || 0,
        Math.max(0, (snapshot.haul.activeCarry || 0) - (snapshot.haul.requiredCarry || 0)));
    const localGross = snapshot.harvest.actualOrEstimatedIncome || 0;
    const grossIncome = localGross + remote.gross;
    const economicCreeps = creeps.filter(creep => creep && creep.memory &&
        ['Extractor', 'Freighter', 'Foreman', 'Annex'].includes(creep.memory.role));
    const replacementCostPerTick = economicCreeps.reduce((sum, creep) => {
        const life = creep.memory.role === 'Annex' && typeof CREEP_CLAIM_LIFE_TIME !== 'undefined' ?
            CREEP_CLAIM_LIFE_TIME : (typeof CREEP_LIFE_TIME !== 'undefined' ? CREEP_LIFE_TIME : 1500);
        return sum + bodyCost(creep.body) / Math.max(1, life);
    }, 0);
    const construction = criticalConstruction(room);
    const baseInfrastructureBudget = grossIncome * (rcl <= 3 ? 0.12 : 0.08);
    const criticalConstructionBudget = construction.sites > 0 ? Math.min(
        grossIncome * 0.15,
        Math.max(1, Math.min(construction.sites * 2, construction.progressRemaining / 1000))
    ) : 0;
    const infrastructureBudget = baseInfrastructureBudget + criticalConstructionBudget;
    const sustainableNetIncome = Math.max(0, grossIncome - replacementCostPerTick - infrastructureBudget);
    const spawnPressure = Math.min(1, (queue.length + snapshot.spawnPressure.busy * 0.5) /
        Math.max(2, spawns.length * 4));
    const controllerEmergency = room.controller && room.controller.ticksToDowngrade < 5000;
    const localHealthy = snapshot.harvest.workActive >= Math.max(1, snapshot.harvest.workRequired * 0.9);
    const haulingHealthy = snapshot.haul.localCarry >= snapshot.haul.requiredCarry * 0.85 &&
        snapshot.haul.backlog <= Math.max(500, snapshot.haul.activeCarry * 75);
    let mode = GROWTH_MODES.NORMAL;
    let blockedReason = 'CONTROLLER_GROWTH_ACTIVE';
    let utilization = 0.5;
    if (controllerEmergency) {
        mode = GROWTH_MODES.CONTROLLER_EMERGENCY;
        utilization = 0.75;
        blockedReason = 'CONTROLLER_EMERGENCY';
    }
    else if (snapshot.state === STATES.SURVIVAL || !localHealthy) {
        mode = GROWTH_MODES.RECOVERY;
        utilization = 0;
        blockedReason = 'LOCAL_HARVEST_SHORTAGE';
    }
    else if (threat && threat.harmfulHostileCount > 0) {
        mode = GROWTH_MODES.RECOVERY;
        utilization = 0;
        blockedReason = 'DEFENSE_EMERGENCY';
    }
    else if (!haulingHealthy) {
        mode = GROWTH_MODES.MINIMUM;
        utilization = 0.2;
        blockedReason = 'HAUL_SHORTAGE';
    }
    else if (spawnPressure >= 0.75) {
        mode = GROWTH_MODES.MINIMUM;
        utilization = 0.25;
        blockedReason = 'SPAWN_PRESSURE';
    }
    else if (energyAboveReserve <= 0 && rcl > 1) {
        mode = GROWTH_MODES.MINIMUM;
        utilization = snapshot.energyTrend >= 0 ? 0.25 : 0.1;
        blockedReason = 'ENERGY_BELOW_RESERVE';
    }
    else if (energyAboveReserve >= reserveTarget ||
        (!hasStorage && snapshot.spawnFill >= 0.9 &&
            energyAboveReserve >= Math.max(100, reserveTarget * 0.75)) ||
        snapshot.energyTrend >= sustainableNetIncome * 0.2) {
        mode = GROWTH_MODES.AGGRESSIVE;
        utilization = 0.7;
    }
    utilization *= 1 - (spawnPressure * 0.4);
    let budget = sustainableNetIncome * utilization;
    if (rcl === 1 && localHealthy) budget = Math.max(1, budget);
    if (rcl >= 1 && rcl < 8 && mode !== GROWTH_MODES.RECOVERY) budget = Math.max(1, budget);
    if (rcl >= 8) budget = Math.min(15, budget);
    return {
        mode, blockedReason, reserveTarget, storedEnergy, energyAboveReserve,
        localGrossIncome: Math.round(localGross * 100) / 100,
        remoteGrossIncome: Math.round(remote.gross * 100) / 100,
        estimatedNetIncome: Math.round(sustainableNetIncome * 100) / 100,
        replacementCostPerTick: Math.round(replacementCostPerTick * 100) / 100,
        infrastructureBudget: Math.round(infrastructureBudget * 100) / 100,
        criticalConstructionBudget: Math.round(criticalConstructionBudget * 100) / 100,
        criticalConstructionSites: construction.sites,
        criticalConstructionProgress: construction.progressRemaining,
        controllerBudget: Math.round(budget * 100) / 100,
        affordableWork: Math.max(rcl < 8 && mode !== GROWTH_MODES.RECOVERY ? 1 : 0, Math.floor(budget)),
        spawnPressure: Math.round(spawnPressure * 100) / 100,
        remote
    };
}

function isLocalExtractor(creep, roomName) {
    const memory = creep && creep.memory || {};
    if (memory.role !== 'Extractor' || memory.homeRoom && memory.homeRoom !== roomName) return false;
    if (memory.remoteMining === true) return false;
    if (memory.sourceRoom && memory.sourceRoom !== roomName) return false;
    return !memory.targetRoom || memory.targetRoom === roomName;
}

function sourceIdFor(memory) {
    return memory && (memory.sourceId || memory.targetSourceId || memory.assignedSource) || null;
}

function replacementLead(creep, distance) {
    return (creep && creep.body ? creep.body.length * 3 : 0) + Math.max(15, distance || 0) + 10;
}

function getDistance(room, source, dropoff) {
    const roomMemory = HiveMemory.getRoomMemory(room.name);
    if (!roomMemory.cache || typeof roomMemory.cache !== 'object') roomMemory.cache = {};
    if (!roomMemory.cache.economyDistances) roomMemory.cache.economyDistances = {};
    const targetId = dropoff && dropoff.id || 'center';
    const key = source.id + ':' + targetId;
    const cached = roomMemory.cache.economyDistances[key];
    if (cached && cached.version === 1 && cached.distance > 0) return cached.distance;
    let distance = dropoff && source.pos && dropoff.pos && typeof source.pos.getRangeTo === 'function' ?
        Math.max(1, source.pos.getRangeTo(dropoff.pos)) : 25;
    if (dropoff && source.pos && dropoff.pos && typeof room.findPath === 'function') {
        try {
            const route = room.findPath(source.pos, dropoff.pos, {
                ignoreCreeps: true, range: 1, maxOps: 2000, serialize: false
            });
            if (route && route.length > 0) distance = route.length;
        }
        catch (error) {
            /* Range distance remains a safe low-CPU fallback for unusual mocks/shards. */
        }
    }
    roomMemory.cache.economyDistances[key] = { version: 1, distance, tick: Game.time };
    return distance;
}

function sourceBacklog(source) {
    if (!source || !source.pos || typeof source.pos.findInRange !== 'function') {
        return { energy: 0, containerEnergy: 0, droppedEnergy: 0, containers: 0 };
    }
    const structures = source.pos.findInRange(FIND_STRUCTURES, 2, {
        filter: structure => structure.structureType === STRUCTURE_CONTAINER
    }) || [];
    const drops = source.pos.findInRange(FIND_DROPPED_RESOURCES, 3, {
        filter: resource => resource.resourceType === RESOURCE_ENERGY && resource.amount > 0
    }) || [];
    const containerEnergy = structures.reduce((sum, structure) => sum + energyIn(structure), 0);
    const droppedEnergy = drops.reduce((sum, resource) => sum + (resource.amount || 0), 0);
    return {
        energy: containerEnergy + droppedEnergy,
        containerEnergy,
        droppedEnergy,
        containers: structures.length
    };
}

function linkContext(room, index) {
    const byType = index.structuresByRoom.get(room.name);
    const links = byType && byType.get(STRUCTURE_LINK) || [];
    if (links.length === 0) return { roles: { storage: null, controller: null, sources: [] } };
    return { roles: Links.classify(room, links) };
}

function sourceLinkFor(source, context) {
    if (!source || !source.pos || !context || !context.roles) return null;
    return context.roles.sources.filter(link => link && link.pos &&
        typeof link.pos.getRangeTo === 'function' && link.pos.getRangeTo(source.pos) <= 2)
        .sort((a, b) => a.pos.getRangeTo(source.pos) - b.pos.getRangeTo(source.pos) ||
            String(a.id).localeCompare(String(b.id)))[0] || null;
}

/* Estimate only the residual income that still needs creep transport. */
function analyzeSourceTransport(source, expectedIncome, backlog, context) {
    const sourceLink = sourceLinkFor(source, context);
    const receivers = context && context.roles ?
        [context.roles.storage, context.roles.controller].filter(Boolean) : [];
    const routeUsable = !!sourceLink && receivers.some(link => link.id !== sourceLink.id);
    const destinationFree = receivers.reduce((sum, link) =>
        sum + (link.id === (sourceLink && sourceLink.id) ? 0 : Links.free(link)), 0);
    const sourceLinkEnergy = Links.energy(sourceLink);
    const sourceLinkFree = Links.free(sourceLink);
    const cooldown = sourceLink && sourceLink.cooldown || 0;
    const saturated = !!sourceLink && sourceLinkFree <= Math.max(50, expectedIncome * (cooldown + 1));
    const destinationBlocked = routeUsable && destinationFree <= 0;
    const spillIncome = Math.min(expectedIncome, backlog.energy / 50);
    let linkServedIncome = 0;

    if (routeUsable && !(saturated && destinationBlocked)) {
        /* A cooldown is normal Link operation; nearby spill is the residual haul load. */
        linkServedIncome = Math.max(0, expectedIncome - spillIncome);
    }

    const creepIncome = Math.max(0, expectedIncome - linkServedIncome);
    const linkBackpressure = sourceLink ? backlog.energy +
        (saturated && (!routeUsable || destinationBlocked) ? sourceLinkEnergy : 0) : 0;
    let mode = backlog.containers > 0 ? 'SOURCE_CONTAINER' : 'DIRECT';
    if (sourceLink && routeUsable) mode = creepIncome > 0 ? 'HYBRID' : 'SOURCE_LINK';
    else if (sourceLink) mode = 'HYBRID';
    else if (backlog.energy > 0) mode = 'CREEP_HAUL';

    return {
        mode,
        sourceLinkId: sourceLink && sourceLink.id || null,
        routeUsable,
        sourceLinkEnergy,
        sourceLinkFree,
        cooldown,
        destinationFree,
        saturated,
        destinationBlocked,
        linkServedIncome,
        creepIncome,
        linkBackpressure
    };
}

function requestSourceId(request) {
    const memory = request && request.memory || {};
    return request && (request.sourceId || request.targetSourceId || request.assignedSource) ||
        sourceIdFor(memory);
}

function spawningRemaining(name, spawns) {
    const spawn = spawns.find(candidate => candidate && candidate.spawning &&
        candidate.spawning.name === name);
    return spawn && typeof spawn.spawning.remainingTime === 'number' ? spawn.spawning.remainingTime : 0;
}

function sourceReplacementCoverage(source, required, distance, assigned, queue, spawns) {
    const active = assigned.filter(creep => !creep.spawning);
    const healthy = [];
    const dying = [];
    const incoming = [];

    for (const creep of active) {
        const work = activeParts(creep, WORK);
        if (creep.ticksToLive === undefined || creep.ticksToLive > replacementLead(creep, distance)) {
            healthy.push({ work });
        }
        else dying.push({ work, at: Math.max(0, creep.ticksToLive || 0) });
    }
    for (const creep of assigned.filter(candidate => candidate.spawning)) {
        incoming.push({
            work: bodyParts(creep.body, WORK),
            at: spawningRemaining(creep.name, spawns) + distance
        });
    }

    let queueDelay = spawns.reduce((longest, spawn) => Math.max(longest,
        spawn && spawn.spawning && spawn.spawning.remainingTime || 0), 0);
    for (const request of queue) {
        if (!request || request.expiresAt < Game.time) continue;
        const spawnTime = (request && request.body ? request.body.length : 0) * 3;
        queueDelay += spawnTime;
        if ((request.role || request.memory && request.memory.role) === 'Extractor' &&
            requestSourceId(request) === source.id) {
            incoming.push({ work: bodyParts(request.body, WORK), at: queueDelay + distance });
        }
    }

    const healthyWork = healthy.reduce((sum, row) => sum + row.work, 0);
    const dyingWork = dying.reduce((sum, row) => sum + row.work, 0);
    const incomingWork = incoming.reduce((sum, row) => sum + row.work, 0);
    let uncoveredWork = Math.max(0, required - healthyWork - dyingWork);
    for (const loss of dying.slice().sort((a, b) => a.at - b.at)) {
        const remainingDying = dying.filter(row => row.at > loss.at)
            .reduce((sum, row) => sum + row.work, 0);
        const arrived = incoming.filter(row => row.at <= loss.at)
            .reduce((sum, row) => sum + row.work, 0);
        uncoveredWork = Math.max(uncoveredWork,
            Math.max(0, required - healthyWork - remainingDying - arrived));
    }
    if (active.length === 0 && incomingWork === 0) uncoveredWork = Math.max(uncoveredWork, required);

    return {
        healthyWork,
        dyingWork,
        incomingWork,
        replacementPending: incomingWork > 0,
        replacementRisk: uncoveredWork > 0,
        replacementUncoveredWork: uncoveredWork
    };
}

// Job classification shared by live capacity, core floors and spawn recovery.
function isLocalFreighter(item) {
    const memory = item && item.memory || {};
    return !!item && (item.role || memory.role) === 'Freighter' &&
        memory.freighterJob !== 'remote' && memory.freighterJob !== 'remoteDelivery';
}

function pendingLocalParts(roomName, role, partType) {
    const roomMemory = Memory.rooms && Memory.rooms[roomName];
    const queue = roomMemory && roomMemory.spawn && roomMemory.spawn.queue || [];
    let total = 0;
    for (const request of queue) {
        const memory = request && request.memory || {};
        if (!request || (request.role || memory.role) !== role) continue;
        if (memory.homeRoom && memory.homeRoom !== roomName) continue;
        if (role === 'Freighter' && !isLocalFreighter(request)) continue;
        if (role === 'Extractor' && (memory.remoteMining ||
            memory.sourceRoom && memory.sourceRoom !== roomName ||
            memory.targetRoom && memory.targetRoom !== roomName)) continue;
        total += bodyParts(request.body, partType);
    }
    return total;
}

function buildSnapshot(room, previous) {
    const index = TickIndex.get();
    const creeps = (index.creepsByHomeRoom.get(room.name) || []).slice();
    const sources = typeof room.find === 'function' ? room.find(FIND_SOURCES) || [] : [];
    const spawns = index.ownedSpawnsByRoom.get(room.name) || [];
    for (const spawn of spawns) {
        const name = spawn.spawning && spawn.spawning.name;
        const memory = name && Memory.creeps && Memory.creeps[name];
        const work = memory && memory.extractorSpawnWorkParts;
        if (Number.isInteger(work) && work > 0 && work <= 50 && !creeps.some(creep => creep.name === name)) {
            creeps.push({ name, memory, spawning: true,
                body: Array(work).fill({ type: WORK, hits: 100 }) });
        }
    }
    const dropoff = room.storage || spawns[0] || null;
    const queue = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].spawn &&
        Memory.rooms[room.name].spawn.queue || [];
    const transportContext = linkContext(room, index);
    const sourceRows = [];
    let workRequired = 0;
    let workActive = 0;
    let incomeExpected = 0;
    let incomeEstimated = 0;
    let backlog = 0;
    let replacementRisk = 0;
    let creepHaulIncome = 0;
    let linkServedIncome = 0;
    let linkBackpressure = 0;

    for (const source of sources) {
        const capacity = source.energyCapacity || 3000;
        const regeneration = typeof ENERGY_REGEN_TIME !== 'undefined' ? ENERGY_REGEN_TIME : 300;
        const harvestPower = typeof HARVEST_POWER !== 'undefined' ? HARVEST_POWER : 2;
        const required = Math.max(1, Math.ceil((capacity / regeneration) / harvestPower));
        const assigned = creeps.filter(creep => isLocalExtractor(creep, room.name) &&
            sourceIdFor(creep.memory) === source.id);
        const activeAssigned = assigned.filter(creep => !creep.spawning);
        const activeWork = activeAssigned.reduce((sum, creep) => sum + activeParts(creep, WORK), 0);
        const distance = getDistance(room, source, dropoff);
        const stationedWork = activeAssigned.reduce((sum, creep) => {
            if (!creep.pos || creep.pos.roomName !== room.name ||
                typeof creep.pos.getRangeTo !== 'function' || creep.pos.getRangeTo(source.pos) > 1) return sum;
            return sum + activeParts(creep, WORK);
        }, 0);
        const sourceIncome = capacity / regeneration;
        const estimated = Math.min(sourceIncome, stationedWork * harvestPower);
        const rowBacklog = sourceBacklog(source);
        const transport = analyzeSourceTransport(source, sourceIncome, rowBacklog, transportContext);
        const coverage = sourceReplacementCoverage(source, required, distance, assigned, queue, spawns);
        workRequired += required;
        workActive += activeWork;
        incomeExpected += sourceIncome;
        incomeEstimated += estimated;
        backlog += rowBacklog.energy;
        creepHaulIncome += transport.creepIncome;
        linkServedIncome += transport.linkServedIncome;
        linkBackpressure += transport.linkBackpressure;
        if (coverage.replacementRisk) replacementRisk++;
        sourceRows.push({
            id: source.id,
            energy: source.energy || 0,
            capacity,
            regeneration,
            distance,
            assigned: assigned.length,
            workRequired: required,
            workActive: activeWork,
            stationedWork,
            workSpawning: assigned.filter(creep => creep.spawning)
                .reduce((sum, creep) => sum + bodyParts(creep.body, WORK), 0),
            workQueued: queue.filter(request => request && !(request.expiresAt < Game.time) && requestSourceId(request) === source.id &&
                isLocalExtractor({ memory: { ...request.memory, role: request.role } }, room.name))
                .reduce((sum, request) => sum + bodyParts(request.body, WORK), 0),
            expectedIncome: Math.round(sourceIncome * 100) / 100,
            estimatedIncome: Math.round(estimated * 100) / 100,
            backlog: rowBacklog.energy,
            transport,
            ...coverage
        });
    }

    /* Unassigned local Extractors still matter during the few ticks before they claim a source. */
    const localExtractors = creeps.filter(creep => isLocalExtractor(creep, room.name));
    const unassignedWork = localExtractors.filter(creep => !creep.spawning && !sourceIdFor(creep.memory))
        .reduce((sum, creep) => sum + activeParts(creep, WORK), 0);
    const spawningWork = localExtractors.filter(creep => creep.spawning)
        .reduce((sum, creep) => sum + bodyParts(creep.body, WORK), 0);
    const queuedWork = sourceRows.reduce((sum, row) => sum + row.workQueued, 0);
    // Useful capacity is capped per source; an uncovered source cannot be offset
    // by extra miners at another source (or miners without an assignment).
    workActive = sourceRows.reduce((sum, row) => sum + Math.min(row.workRequired, row.workActive), 0);

    const freighters = creeps.filter(creep => creep && creep.memory && creep.memory.role === 'Freighter' &&
        (!creep.memory.homeRoom || creep.memory.homeRoom === room.name));
    const healthyFreighters = freighters.filter(creep => creep.ticksToLive === undefined ||
        creep.ticksToLive > replacementLead(creep, 25));
    const activeCarry = healthyFreighters.reduce((sum, creep) => sum + activeParts(creep, CARRY), 0);
    const remoteCarry = healthyFreighters.filter(creep => !isLocalFreighter(creep))
        .reduce((sum, creep) => sum + activeParts(creep, CARRY), 0);
    const localCarry = Math.max(0, activeCarry - remoteCarry);
    const requiredCarry = Math.ceil(sourceRows.reduce((sum, source) =>
        sum + source.transport.creepIncome * Math.max(2, source.distance * 2 + 4) / 50, 0) * 1.15);

    const storageEnergy = energyIn(room.storage);
    const terminalEnergy = energyIn(room.terminal);
    const energyAvailable = room.energyAvailable || 0;
    const energyCapacity = Math.max(1, room.energyCapacityAvailable || 300);
    const liquidEnergy = energyAvailable + storageEnergy + terminalEnergy + backlog;
    const previousTick = previous && previous.sampleTick;
    const elapsed = previousTick === undefined ? 0 : Math.max(1, Game.time - previousTick);
    const immediateTrend = previous && typeof previous.liquidEnergy === 'number' ?
        (liquidEnergy - previous.liquidEnergy) / elapsed : 0;
    const oldTrend = previous && typeof previous.energyTrend === 'number' ? previous.energyTrend : immediateTrend;
    const energyTrend = Math.round((oldTrend * 0.8 + immediateTrend * 0.2) * 100) / 100;
    const remoteCommitments = creeps.filter(creep => creep && creep.memory &&
        (creep.memory.remoteMining === true || creep.memory.freighterJob === 'remote' ||
            creep.memory.freighterJob === 'remoteDelivery' ||
            creep.memory.remoteWorkTargetId)).length;
    const busySpawns = spawns.filter(spawn => spawn && spawn.spawning).length;
    const usefulCarry = creeps.reduce((sum, creep) => sum + (!creep.spawning ? activeParts(creep, CARRY) : 0), 0);
    const selfDeliverWork = localExtractors.reduce((sum, creep) => sum +
        (!creep.spawning && activeParts(creep, CARRY) > 0 ? activeParts(creep, WORK) : 0), 0);
    const storedForRecovery = storageEnergy + terminalEnergy + backlog;
    const recoverableStoredEnergy = usefulCarry > 0 ? storedForRecovery : 0;
    const extractorFloor = 200;
    const floorReachable = energyAvailable >= extractorFloor || selfDeliverWork > 0 ||
        energyAvailable + recoverableStoredEnergy >= extractorFloor;

    const snapshot = {
        roomName: room.name,
        sampleTick: Game.time,
        state: previous && previous.state || STATES.RECOVERY,
        stateSince: previous && previous.stateSince || Game.time,
        stateChangedAt: previous && previous.stateChangedAt || Game.time,
        healthyTicks: previous && previous.healthyTicks || 0,
        reason: previous && previous.reason || 'initial economy sample',
        spawnFill: Math.round(energyAvailable / energyCapacity * 1000) / 1000,
        energyAvailable,
        energyCapacity,
        storageEnergy,
        terminalEnergy,
        liquidEnergy,
        energyTrend,
        harvest: {
            expectedIncome: Math.round(incomeExpected * 100) / 100,
            actualOrEstimatedIncome: Math.round(incomeEstimated * 100) / 100,
            workRequired,
            workActive,
            unassignedWork,
            stationedWork: sourceRows.reduce((sum, row) => sum + Math.min(row.workRequired, row.stationedWork), 0),
            workQueued: queuedWork,
            workSpawning: spawningWork,
            workIncoming: queuedWork + spawningWork,
            sources: sourceRows
        },
        haul: {
            requiredCarry,
            creepRequiredCarry: requiredCarry,
            activeCarry,
            localCarry,
            queuedCarry: pendingLocalParts(room.name, 'Freighter', CARRY),
            remoteCarry,
            backlog,
            creepHaulIncome: Math.round(creepHaulIncome * 100) / 100,
            linkServedIncome: Math.round(linkServedIncome * 100) / 100,
            linkBackpressure
        },
        bootstrap: {
            extractorFloor,
            floorReachable,
            recoverableStoredEnergy,
            usefulCarry,
            selfDeliverWork,
            unrecoverable: !floorReachable
        },
        replacementRisk,
        remoteCommitments,
        protectedStockpileEnergy: protectedSpawnStockpileEnergy(room),
        spawnPressure: { queued: queue.length, busy: busySpawns }
    };
    snapshot.growth = buildGrowthPolicy(room, snapshot, creeps, spawns);
    return snapshot;
}

function rawState(snapshot) {
    const harvest = snapshot.harvest;
    const haul = snapshot.haul;
    const harvestRatio = harvest.workRequired > 0 ? harvest.workActive / harvest.workRequired : 1;
    const incomeRatio = harvest.expectedIncome > 0 ?
        harvest.actualOrEstimatedIncome / harvest.expectedIncome : 1;
    const haulRatio = haul.requiredCarry > 0 ? haul.localCarry / haul.requiredCarry : 1;
    const reserves = snapshot.storageEnergy + snapshot.terminalEnergy;
    const capacityExists = harvest.workActive +
        (harvest.workIncoming === undefined ? harvest.workQueued || 0 : harvest.workIncoming) > 0;
    const energyFlowing = harvest.actualOrEstimatedIncome > 0;

    if (!capacityExists) {
        if (snapshot.bootstrap && snapshot.bootstrap.unrecoverable) {
            return { state: STATES.SURVIVAL, reason: 'bootstrap energy floor not reachable' };
        }
        return { state: STATES.SURVIVAL, reason: 'zero functional local source miners' };
    }
    if (!energyFlowing && snapshot.spawnFill < 0.15 && reserves < 500) {
        return { state: STATES.SURVIVAL, reason: 'no local source energy flowing at critical reserves' };
    }
    if (snapshot.spawnFill < 0.15 && reserves < 500 && incomeRatio < 0.45) {
        return { state: STATES.SURVIVAL, reason: 'spawn energy critically low and harvest income below replacement level' };
    }
    if (harvestRatio < 0.9 || incomeRatio < 0.65 || (harvest.sources || []).some(row =>
        row.workActive < row.workRequired * 0.9 || row.estimatedIncome < row.expectedIncome * 0.65)) {
        return { state: STATES.RECOVERY, reason: 'harvesting below sustainable local demand' };
    }
    if (haulRatio < 0.85 || haul.backlog > Math.max(500, haul.activeCarry * 75) ||
        (haul.linkBackpressure || 0) > 500) {
        return { state: STATES.RECOVERY, reason: 'harvest restored, logistics below demand' };
    }
    if (snapshot.spawnFill < 0.45 && reserves < 2000 &&
        !(snapshot.spawnPressure.busy > 0 && incomeRatio >= 0.9 && haulRatio >= 0.85)) {
        return { state: STATES.RECOVERY, reason: 'spawn fill recovering' };
    }
    if (snapshot.replacementRisk > 0 && reserves < 5000) {
        return { state: STATES.RECOVERY, reason: 'critical economy replacement at risk' };
    }
    if (reserves >= 100000 && snapshot.spawnFill >= 0.9 && snapshot.energyTrend >= -1) {
        return { state: STATES.SURPLUS, reason: 'storage reserves high and core economy satisfied' };
    }
    return { state: STATES.STABLE, reason: 'local income and logistics sustainable' };
}

function protectedSpawnStockpileEnergy(room) {
    if (!room) return 0;
    const spawns = TickIndex.get().ownedSpawnsByRoom.get(room.name) || [];
    if (!spawns.length) return 0;
    const drops = TickIndex.get().droppedResourcesByRoom.get(room.name) || [];
    return drops.reduce((sum, resource) => {
        if (!resource || resource.resourceType !== RESOURCE_ENERGY || !(resource.amount > 0) || !resource.pos) {
            return sum;
        }
        const protectedDrop = spawns.some(spawn => spawn && spawn.pos && resource.pos.getRangeTo(spawn) <= 3);
        return sum + (protectedDrop ? resource.amount : 0);
    }, 0);
}

function applyHysteresis(snapshot, previous) {
    const raw = rawState(snapshot);
    if (!previous || !STATE_RANK.hasOwnProperty(previous.state)) {
        snapshot.state = raw.state;
        snapshot.rawState = raw.state;
        snapshot.reason = raw.reason;
        snapshot.healthyTicks = 0;
        snapshot.stateSince = Game.time;
        snapshot.stateChangedAt = Game.time;
        return snapshot;
    }
    const oldState = previous && STATE_RANK.hasOwnProperty(previous.state) ? previous.state : STATES.RECOVERY;
    const oldRank = STATE_RANK[oldState];
    const rawRank = STATE_RANK[raw.state];
    let state = oldState;
    let healthyTicks = previous && previous.healthyTicks || 0;
    let reason = raw.reason;

    if (rawRank < oldRank) {
        state = raw.state;
        healthyTicks = 0;
    }
    else if (rawRank > oldRank) {
        healthyTicks++;
        if (healthyTicks >= (EXIT_TICKS[oldState] || 1)) {
            state = Object.keys(STATE_RANK).find(name => STATE_RANK[name] === oldRank + 1) || raw.state;
            healthyTicks = 0;
            reason = 'sustained improvement: ' + raw.reason;
        }
        else {
            reason = 'holding ' + oldState + ' for recovery confirmation: ' + raw.reason;
        }
    }
    else {
        healthyTicks = 0;
    }

    snapshot.state = state;
    snapshot.healthyTicks = healthyTicks;
    snapshot.reason = reason;
    snapshot.stateSince = previous && previous.state === state ? previous.stateSince : Game.time;
    snapshot.stateChangedAt = previous && previous.state === state ? previous.stateChangedAt : Game.time;
    snapshot.rawState = raw.state;
    return snapshot;
}

function heapEconomy() {
    if (!global.__sushiEconomy || global.__sushiEconomy.tick !== Game.time) {
        global.__sushiEconomy = { tick: Game.time, rooms: {} };
    }
    return global.__sushiEconomy;
}

function previousSnapshot(persistent) {
    if (!persistent) return null;
    return {
        ...persistent,
        sampleTick: persistent.lastSampleTick,
        liquidEnergy: persistent.lastLiquidEnergy
    };
}

function savePersistent(roomName, snapshot) {
    const persistent = HiveMemory.getRoomEconomyMemory(roomName);
    persistent.state = snapshot.state;
    persistent.rawState = snapshot.rawState;
    persistent.stateSince = snapshot.stateSince;
    persistent.stateChangedAt = snapshot.stateChangedAt;
    persistent.healthyTicks = snapshot.healthyTicks;
    persistent.reason = snapshot.reason;
    persistent.lastSampleTick = snapshot.sampleTick;
    persistent.lastLiquidEnergy = snapshot.liquidEnergy;
    persistent.energyTrend = snapshot.energyTrend;
    persistent.protectedStockpileEnergy = snapshot.protectedStockpileEnergy;
    persistent.growth = snapshot.growth;
    return persistent;
}

function updateRoom(room) {
    if (!room || !room.controller || !room.controller.my) return null;
    const persistent = HiveMemory.getRoomEconomyMemory(room.name);
    const previous = previousSnapshot(persistent);
    const snapshot = applyHysteresis(buildSnapshot(room, previous), previous);
    heapEconomy().rooms[room.name] = snapshot;
    savePersistent(room.name, snapshot);
    return snapshot;
}

function run() {
    const result = {};
    for (const room of TickIndex.get().ownedSpawnRooms) result[room.name] = updateRoom(room);
    return result;
}

function get(roomOrName) {
    const roomName = typeof roomOrName === 'string' ? roomOrName : roomOrName && roomOrName.name;
    if (!roomName) return null;
    const heap = heapEconomy();
    return heap.rooms[roomName] || Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].economy || null;
}

function categoryForRequest(request) {
    const memory = request && request.memory || {};
    const role = request && (request.role || memory.role);
    if (request && request.economyCategory) return request.economyCategory;
    if (memory.economyCategory) return memory.economyCategory;
    if (memory.remoteMining === true || memory.remoteWorkTargetId ||
        memory.sourceRoom && memory.homeRoom && memory.sourceRoom !== memory.homeRoom) {
        return memory.remoteLifecycle === 'BOOTSTRAPPING' ? 'remoteBootstrap' : 'remoteMaintenance';
    }
    if (CORE_ROLES.has(role)) return role === 'Extractor' ? 'harvest' : 'logistics';
    if (COMBAT_ROLES.has(role)) {
        const targetRoom = memory.defendedRoom || memory.targetRoom || request && request.targetRoom;
        const target = targetRoom && Game.rooms[targetRoom];
        if (memory.defenseRequest === true && target && target.controller && target.controller.my) {
            return 'emergencyDefense';
        }
        return 'combat';
    }
    if (role === 'Tech') {
        if (memory.controllerEmergency) return 'controllerSafety';
        if (memory.controllerGrowthFloor) return 'controllerGrowth';
        return 'upgradeSurplus';
    }
    if (role === 'Artificer') return memory.criticalMaintenance ? 'criticalMaintenance' : 'construction';
    if (role === 'Scout') return memory.scoutMode === 'expansion' ? 'expansion' : 'remoteIntel';
    if (role === 'Annex' || role === 'Pioneer') return 'expansion';
    if (role === 'MineralMiner' || role === 'ResourceCourier') return 'resources';
    if (role === 'ThoriumMiner' || role === 'ThoriumHauler' || role === 'ReactorClaimer') return 'special';
    return 'discretionary';
}

function checkSpend(roomOrName, category) {
    const snapshot = get(roomOrName);
    if (!snapshot) return { allowed: true, reason: 'no economy snapshot' };
    if (category === 'emergencyDefense') return { allowed: true, reason: 'owned-room emergency defense' };
    if (['harvest', 'logistics', 'spawnFill'].includes(category)) {
        return { allowed: true, reason: 'core economy' };
    }
    if (category === 'controllerGrowth' && snapshot.harvest && snapshot.harvest.workRequired > 0 &&
        localHarvestCoverage(snapshot).status !== 'HEALTHY') {
        return { allowed: false, reason: 'local harvest must recover before controller growth' };
    }
    if (snapshot.state === STATES.SURVIVAL) {
        const allowed = ['controllerSafety', 'criticalController', 'criticalMaintenance'].includes(category);
        return { allowed, reason: allowed ? 'critical survival exception' : 'blocked during SURVIVAL' };
    }
    if (snapshot.state === STATES.RECOVERY) {
        const allowed = ['defense', 'controllerSafety', 'criticalController', 'controllerGrowth',
            'criticalMaintenance', 'criticalInfrastructure', 'remoteIncome', 'remoteMaintenance',
            'remoteBootstrap', 'remoteIntel'].includes(category);
        if (['remoteIncome', 'remoteMaintenance', 'remoteBootstrap'].includes(category) &&
            snapshot.harvest && snapshot.harvest.workActive < Math.max(1, snapshot.harvest.workRequired * 0.9)) {
            return { allowed: false, reason: 'local harvest must recover before remote income spending' };
        }
        return { allowed, reason: allowed ? 'recovery exception' : 'blocked during RECOVERY' };
    }
    return { allowed: true, reason: snapshot.state + ' permits spending' };
}

function canSpend(roomOrName, category) {
    return checkSpend(roomOrName, category).allowed;
}

// Current health comes from the Economy snapshot. Incoming capacity never
// satisfies the active floor, and excess WORK on one source cannot cover another.
function localHarvestCoverage(snapshot) {
    const harvest = snapshot && snapshot.harvest || {};
    const requiredWork = harvest.workRequired || 0;
    const activeWork = harvest.workActive || 0;
    const spawningWork = harvest.workSpawning || 0;
    const queuedWork = harvest.workQueued || 0;
    const sources = harvest.sources || [];
    const activeRatio = requiredWork > 0 ? activeWork / requiredWork : 0;
    const incomeRatio = harvest.expectedIncome > 0 ?
        (harvest.actualOrEstimatedIncome || 0) / harvest.expectedIncome : 0;
    const healthy = activeRatio >= 0.9 && incomeRatio >= 0.65 &&
        sources.every(row => row.workActive >= row.workRequired * 0.9 && row.estimatedIncome >= row.expectedIncome * 0.65);
    const incomingCovered = sources.length ? sources.every(row =>
        row.workActive + (row.workSpawning || 0) + (row.workQueued || 0) >= row.workRequired * 0.9) :
        activeWork + spawningWork + queuedWork >= requiredWork * 0.9;
    return { activeWork, spawningWork, queuedWork, requiredWork, activeRatio,
        incomingWork: spawningWork + queuedWork,
        status: healthy ? 'HEALTHY' : requiredWork > 0 && incomingCovered ? 'RECOVERING' : 'MISSING' };
}

// Re-evaluate only source-targeted local requests. Earlier queued reservations
// count; this request and later duplicates do not. No persisted emergency flag.
function localRecoveryRequest(room, request, queue) {
    const memory = request.memory || {};
    const role = request.role || memory.role;
    const snapshot = get(room.name);
    const local = isLocalExtractor({ memory: { ...memory, role } }, room.name);
    const localHaulerMatches = item => {
        const m = item.memory || {};
        return isLocalFreighter(item) && !m.remoteMining && !m.remoteSourceId && !m.remoteWorkTargetId &&
            (!m.homeRoom || m.homeRoom === room.name) &&
            (!m.sourceRoom || m.sourceRoom === room.name) && (!m.targetRoom || m.targetRoom === room.name);
    };
    const localHauler = localHaulerMatches(request);
    if (!local && !localHauler) return { mandatory: false };
    const sourceId = sourceIdFor(memory);
    const rows = snapshot && snapshot.harvest && snapshot.harvest.sources;
    const source = local && rows && rows.find(row => row.id === sourceId);
    if (local && rows && rows.length && (!sourceId || !source)) return { mandatory: false, obsolete: true, reason: 'invalid local source assignment' };
    if (local && !source || localHauler && !(snapshot && snapshot.haul)) return { mandatory: false };
    const part = local ? WORK : CARRY;
    const matches = item => {
        const m = item.memory || {};
        return local ? isLocalExtractor({ memory: { ...m, role: item.role || m.role } }, room.name) && sourceIdFor(m) === sourceId :
            localHaulerMatches(item);
    };
    const index = TickIndex.get();
    let covered = 0;
    const seen = new Set();
    for (const creep of index.creepsByHomeRoom.get(room.name) || []) {
        if (!matches(creep)) continue;
        seen.add(creep.name);
        if (creep.spawning || creep.ticksToLive === undefined || creep.ticksToLive > replacementLead(creep, source && source.distance || 25)) {
            covered += creep.spawning ? bodyParts(creep.body, part) : activeParts(creep, part);
        }
    }
    for (const spawn of index.ownedSpawnsByRoom.get(room.name) || []) {
        const name = spawn.spawning && spawn.spawning.name;
        const m = name && Memory.creeps && Memory.creeps[name];
        const parts = m && (local ? m.extractorSpawnWorkParts : m.freighterSpawnCarryParts);
        if (Number.isInteger(parts) && parts > 0 && parts <= 50 && !seen.has(name) && matches({ memory: m })) covered += parts;
    }
    for (const pending of queue || []) {
        if (!pending) continue;
        if (pending === request || request.requestId && pending.requestId === request.requestId) break;
        if (matches(pending) && !(pending.expiresAt < Game.time)) covered += bodyParts(pending.body, part);
    }
    const required = local ? source.workRequired : snapshot.haul.requiredCarry;
    const missing = Math.max(0, required - covered);
    return { mandatory: missing > 0, missing, obsolete: local && missing === 0,
        reason: missing > 0 ? 'mandatory local economy recovery' : 'local source already covered' };
}

function canSpawnRequest(room, request) {
    const category = categoryForRequest(request);
    const spend = checkSpend(room, category);
    if (!spend.allowed || category !== 'remoteIntel') return spend;
    const scout = require('Scout.Economy').status(room);
    return { allowed: scout.allowed, reason: scout.blockedReason || 'economic intel floor established' };
}

function shouldBootstrapSelfDeliver(roomOrName) {
    const snapshot = get(roomOrName);
    return !!snapshot && snapshot.state === STATES.SURVIVAL &&
        (!snapshot.haul || snapshot.haul.localCarry + snapshot.haul.queuedCarry < 1);
}

module.exports = {
    isLocalFreighter,
    localHarvestCoverage,
    localRecoveryRequest,
    STATES,
    GROWTH_MODES,
    run,
    updateRoom,
    get,
    rawState,
    applyHysteresis,
    canSpend,
    checkSpend,
    canSpawnRequest,
    categoryForRequest,
    shouldBootstrapSelfDeliver,
    buildGrowthPolicy,
    remoteEconomy,
    buildSnapshot,
    analyzeSourceTransport,
    sourceReplacementCoverage,
    protectedSpawnStockpileEnergy
};
