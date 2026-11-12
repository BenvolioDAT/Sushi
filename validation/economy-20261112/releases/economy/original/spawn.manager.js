/*
 * spawn.manager.js
 *
 * Basic Sushi spawn queue manager.
 *
 * Job:
 * - main.js asks for creep counts
 * - this file adds missing creeps to a room queue
 * - this file tries to spawn queued creeps
 *
 * This is intentionally simple.
 *
 * Teaching split:
 * - spawn.request.manager.js decides what the room needs.
 * - this file owns the queue mechanics and spawnCreep return handling.
 */

var spawnUtility = require('utility.spawn');
var creepBodyConfig = require('role.creepBodyConfig');
var Economy = require('HiveMind.Economy');
var HiveMemory = require('HiveMind.Memory');
var SpawnArbiter = require('Spawn.Arbiter');
var SpawnIntents = require('Spawn.Intents');

var getBodyCost = creepBodyConfig.getBodyCost;

function countBodyParts(body, partType) {
    var count = 0;

    if (!body) {
        return count;
    }

    for (var index = 0; index < body.length; index++) {
        if (body[index] === partType) {
            count++;
        }
    }

    return count;
}

/**
 * Select the strongest body for this role that current room energy can afford.
 *
 * spawn.request.manager.js decides what roles are needed, but queued Memory can
 * become stale because spawning takes many ticks. spawn.manager.js is the last
 * chance to choose the best body before room energy is spent.
 *
 * This helper changes only request.body. It never rebuilds request.memory, so
 * source assignments, remote mining targets, and other job details survive.
 *
 * @param {StructureSpawn} spawn
 * @param {object} request
 * @returns {object}
 */
function selectAffordableQueuedBodyForSpawn(spawn, request) {
    if (!spawn || !spawn.room || !request || !request.role) {
        return {
            changed: false,
            affordable: false,
            reason: 'missing spawn or request'
        };
    }

    var energyAvailable = Math.min(spawn.room.energyAvailable, require('Harvest.Planning').energyCapacity(spawn.room));
    var bodyRoom = Object.create(spawn.room, { energyAvailable: { value: energyAvailable } });
    var bestBody;

    if (request.bodyRequirements && request.bodyRequirements.fixed === true) {
        bestBody = getBodyCost(request.body) <= energyAvailable ? request.body.slice() : null;
    }
    else if (request.bodyProfile && request.role !== 'Extractor') {
        var profile = Object.assign({}, request.bodyProfile, { energyCapacity: energyAvailable,
            energyAvailable: energyAvailable });
        if (request.role === 'Tech' && spawn.room.controller && spawn.room.controller.ticksToDowngrade < 5000)
            profile.urgency = 'EMERGENCY';
        var selected = require('BodyProfiles').build(request.role, profile);
        bestBody = selected && selected.body;
    }
    else if (request.role === 'Extractor') {
        var requestedExtractorWork = request.requestedWorkParts ||
            request.maxWorkParts || countBodyParts(request.body, WORK);
        bestBody = creepBodyConfig.getExtractorBodyForAvailableEnergy(
            bodyRoom,
            requestedExtractorWork
        );
    }
    else if (request.role === 'Tech') {
        /*
         * Tech requests are sized to a missing WORK amount. Preserve that cap
         * while still allowing the body to shrink when current energy is low.
         * Reading request.body also keeps old queued Tech requests compatible.
         */
        var requestedWork = request.maxWorkParts || countBodyParts(request.body, WORK);
        bestBody = creepBodyConfig.getTechBodyForAvailableEnergy(
            bodyRoom,
            requestedWork
        );
    }
    else if (request.role === 'Artificer') {
        /* Artificer requests also carry a WORK shortage cap. */
        var requestedArtificerWork = request.requestedWorkParts ||
            request.maxWorkParts || countBodyParts(request.body, WORK);
        bestBody = creepBodyConfig.getArtificerBodyForAvailableEnergy(
            bodyRoom,
            requestedArtificerWork
        );
    }
    else if (request.role === 'Freighter') {
        /* Preserve the requested CARRY shortage while shrinking for energy. */
        var requestedCarry = request.requestedCarryParts ||
            request.maxCarryParts || countBodyParts(request.body, CARRY);
        bestBody = creepBodyConfig.getFreighterBodyForAvailableEnergy(
            bodyRoom,
            requestedCarry
        );
    }
    else {
        bestBody = creepBodyConfig.getBestBodyForAvailableEnergy(
            request.role,
            bodyRoom
        );
    }

    if (!bestBody || bestBody.length === 0 || request.minimumWorkParts > countBodyParts(bestBody, WORK) ||
        request.minimumCarryParts > countBodyParts(bestBody, CARRY)) {
        return {
            changed: false,
            affordable: false,
            energyAvailable: energyAvailable,
            reason: request.minimumCarryParts > 1 ? 'insufficient current energy for consolidated hauling body' :
                request.minimumWorkParts > 1 ? 'insufficient current energy for productive replacement' : 'no affordable body for current energy'
        };
    }

    var oldCost = getBodyCost(request.body);
    var newCost = getBodyCost(bestBody);

    request.body = bestBody;
    request.bodyMetrics = require('BodyProfiles').metrics(bestBody, request.memory || {});

    return {
        changed: oldCost !== newCost,
        affordable: true,
        oldCost: oldCost,
        newCost: newCost,
        energyAvailable: energyAvailable,
        reason: newCost < oldCost ? 'downgraded to affordable body' :
            newCost > oldCost ? 'upgraded to affordable body' :
            'kept affordable body'
    };
}

/**
 * Evaluate an affordable body without changing the queued request. Candidate
 * scanning must not resize requests that are not ultimately selected.
 */
function minimumQueuedBodyCost(room, request) {
    if (request.bodyRequirements && request.bodyRequirements.fixed) return getBodyCost(request.body);
    if (request.role === 'Freighter' && request.minimumCarryParts > 1) {
        return request.minimumCarryParts * 100; // Conservative one CARRY / one MOVE.
    }
    if (request.role === 'Extractor' || request.bodyProfile) {
        const minimum = request.minimumWorkParts || 1;
        const profile = request.role === 'Extractor' ? { desiredWork: minimum, maxWork: minimum } : { ...request.bodyProfile };
        if (request.role === 'Tech' && room.controller && room.controller.ticksToDowngrade < 5000) profile.urgency = 'EMERGENCY';
        const generated = require('BodyProfiles').build(request.role, { ...profile, maxUnits: request.role === 'Extractor' ? minimum : 1,
            energyCapacity: room.energyCapacityAvailable, energyAvailable: room.energyCapacityAvailable });
        return generated && generated.cost;
    }
    return creepBodyConfig.minimumBodyCost(request.role, request);
}

function previewAffordableQueuedBodyForSpawn(spawn, request) {
    const signature = JSON.stringify([spawn.room.energyAvailable, require('Harvest.Planning').energyCapacity(spawn.room),
        request.role, request.requestedWorkParts, request.maxWorkParts, request.minimumWorkParts,
        request.minimumCarryParts,
        request.requestedCarryParts, request.maxCarryParts, request.bodyProfile,
        !!request.bodyRequirements?.fixed, request.body, spawn.room.controller?.ticksToDowngrade < 5000]);
    if (request.affordableBodyCache?.signature === signature) return request.affordableBodyCache.preview;
    var preview = Object.assign({}, request);
    var selection = selectAffordableQueuedBodyForSpawn(spawn, preview);

    const result = {
        body: selection.affordable ? preview.body : null,
        selection: selection
    };
    request.affordableBodyCache = { signature, preview: result };
    return result;
}

/**
 * Make sure the room memory and spawn queue exist.
 *
 * Queue path:
 * Memory.rooms[roomName].spawn.queue
 *
 * @param {string} roomName
 * @returns {array|null}
 */
function getSpawnQueue(roomName) {
    /*
     * A room name is required because each room keeps its own queue under
     * Memory.rooms[roomName].spawn.queue.
     */
    if (!roomName) {
        return null;
    }

    /*
     * Memory is persistent between ticks. The schema accessor owns this shape.
     */
    return HiveMemory.getRoomSpawnMemory(roomName).queue;
}

/**
 * Count alive creeps that belong to this room and role.
 *
 * This checks:
 * - creep.memory.role
 * - creep.memory.homeRoom
 *
 * If homeRoom is missing, it falls back to creep.room.name.
 * That helps early simple creeps still count.
 *
 * @param {string} roomName
 * @param {string} role
 * @returns {number}
 */
function countAliveRole(roomName, role) {
    var TickIndex = require('HiveMind.Index');
    var count = 0;

    /*
     * Game.creeps is all living owned creeps. Looping by name lets us inspect
     * each creep's memory and decide if it belongs to this count.
     */
    var creeps = TickIndex.get().creepsByHomeRoom.get(roomName) || [];
    for (var creepIndex = 0; creepIndex < creeps.length; creepIndex++) {
        var creep = creeps[creepIndex];

        if (!creep || !creep.memory) {
            continue;
        }

        if (creep.memory.role !== role) {
            continue;
        }

        var creepHomeRoom = creep.memory.homeRoom || creep.room.name;

        if (creepHomeRoom !== roomName) {
            continue;
        }

        count++;
    }

    return count;
}

/**
 * Count queued creeps for this room and role.
 *
 * This stops main.js from adding the same request every tick.
 *
 * @param {string} roomName
 * @param {string} role
 * @returns {number}
 */
function countQueuedRole(roomName, role) {
    var queue = getSpawnQueue(roomName);

    /*
     * If the queue cannot be created or found, there are zero queued requests
     * for this role.
     */
    if (!queue) {
        return 0;
    }

    var count = 0;

    for (var index = 0; index < queue.length; index++) {
        var request = queue[index];

        /*
         * Each request is a plain object saved in Memory. Bad or empty entries
         * are skipped so one damaged queue item does not crash the count.
         */
        if (!request) {
            continue;
        }

        if (request.role === role) {
            count++;
        }
    }

    return count;
}

/**
 * Ask the spawn manager to maintain a desired number of creeps.
 *
 * Example:
 * requestRoleCount("W1N1", "Veinseeker", 2, [WORK, CARRY, MOVE], 20);
 *
 * If alive + queued is less than desiredCount, this adds missing creeps
 * to the room spawn queue.
 *
 * @param {string} roomName
 * @param {string} role
 * @param {number} desiredCount
 * @param {array} body
 * @param {number} priority
 * @param {object} extraMemory
 * @returns {object}
 */
function requestRoleCount(roomName, role, desiredCount, body, priority, extraMemory) {
    var queue = getSpawnQueue(roomName);

    /*
     * Validate important inputs before writing to Memory. Returning an object
     * instead of throwing keeps the caller able to report what happened.
     */
    if (!queue || !role || !body || desiredCount <= 0) {
        return {
            ok: false,
            added: 0,
            reason: 'Invalid spawn request'
        };
    }

    var aliveCount = countAliveRole(roomName, role);
    var queuedCount = countQueuedRole(roomName, role);
    var totalPlanned = aliveCount + queuedCount;
    var missingCount = desiredCount - totalPlanned;
    var added = 0;

    /*
     * Nothing missing, so do not add anything.
     */
    if (missingCount <= 0) {
        return {
            ok: true,
            added: 0,
            alive: aliveCount,
            queued: queuedCount,
            desired: desiredCount
        };
    }

    for (var missingIndex = 0; missingIndex < missingCount; missingIndex++) {
        /*
         * This memory object will become creep.memory when spawnCreep succeeds.
         * role drives main.js dispatch, and homeRoom lets counting stay room-aware.
         */
        var memory = {
            role: role,
            homeRoom: roomName
        };

        /*
         * Add optional memory fields.
         * This lets main.js pass things like targetRoom later.
         */
        if (extraMemory) {
            for (var key in extraMemory) {
                if (extraMemory.hasOwnProperty(key)) {
                    memory[key] = extraMemory[key];
                }
            }
        }

        queue.push({
            role: role,
            body: body,
            priority: priority || 0,
            memory: memory,
            requestedAt: Game.time
        });

        /*
         * queue.push writes the new request into Memory.rooms[roomName].spawnQueue.
         * The actual creep is not spawned yet; runRoom will process it later.
         */
        added++;
    }

    /*
     * Sort highest priority first.
     * If priorities match, older request goes first.
     */
    queue.sort(function(a, b) {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }

        return a.requestedAt - b.requestedAt;
    });

    return {
        ok: true,
        added: added,
        alive: aliveCount,
        queued: queuedCount,
        desired: desiredCount
    };
}

/**
 * Find an idle spawn in this room.
 *
 * @param {string} roomName
 * @returns {StructureSpawn|null}
 */
function findIdleSpawn(roomName) {
    /*
     * Game.spawns contains every spawn you own, keyed by spawn name.
     * This loop finds the first spawn in the requested room that is not busy.
     */
    for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) {
            continue;
        }

        var spawn = Game.spawns[spawnName];

        if (!spawn || !spawn.room) {
            continue;
        }

        if (spawn.room.name !== roomName) {
            continue;
        }

        if (spawn.spawning || SpawnIntents.get().used.has(spawn.name)) {
            continue;
        }

        return spawn;
    }

    return null;
}

/**
 * Try to spawn the first creep in this room's queue.
 *
 * Important behavior:
 * - OK: remove the request from queue
 * - ERR_NOT_ENOUGH_ENERGY: keep request in queue and try again later
 * - ERR_BUSY: keep request in queue
 * - ERR_NAME_EXISTS: try a new generated name next tick
 *
 * @param {string} roomName
 * @returns {object}
 */
function runRoomInternal(roomName, decision, selectedSpawn) {
    var queue = getSpawnQueue(roomName);
    SpawnArbiter.pruneRoom(roomName, decision);

    /*
     * Empty queue is a normal success state. Nothing is wrong; there is simply
     * no creep request to process this tick.
     */
    if (!queue || queue.length === 0) {
        const rejected = Object.values(Memory.rooms[roomName]?.sources || {}).map(s => s.harvestPlanning)
            .find(p => p?.tick === Game.time && p.admissionAllowed === false);
        if (rejected && !decision.blocked) Object.assign(decision, { stage: 'admission',
            selectedRole: 'Extractor', arbiterAllowed: false, arbiterReason: rejected.admissionReason,
            blockSource: rejected.blockSource, configPath: rejected.configPath,
            blocked: { role: 'Extractor', reason: rejected.admissionReason } });
        const harvest = Economy.get(roomName)?.harvest;
        const constrained = harvest?.sources?.find(s => s.constraint && s.constraint !== 'COVERED');
        if (constrained) {
            decision.harvestConstraint = constrained.constraint;
            decision.recommendedAction = constrained.recommendedAction;
        }
        return {
            ok: true,
            result: null,
            reason: decision.blocked ? decision.blocked.reason : constrained ?
                constrained.planningReason + '; ' + constrained.recommendedAction : 'Queue empty'
        };
    }

    var spawn = selectedSpawn || findIdleSpawn(roomName);
    decision.spawnName = spawn && spawn.name || null;
    decision.idle = !!spawn;

    /*
     * Spawns can only create one creep at a time. If none are idle, keep the
     * request in queue and try again on a future tick.
     */
    if (!spawn) {
        return {
            ok: false,
            result: ERR_BUSY,
            reason: 'No idle spawn found'
        };
    }

    /*
     * Highest priority request should already be first because requestRoleCount()
     * sorts the queue. We sort again just in case something else added to queue.
     */
    const urgentRequests = new Set(queue.filter(q => {
        if (!q) return false;
        const recovery = Economy.localRecoveryRequest(spawn.room, q, queue);
        return recovery.mandatory && (!q.minerUpgrade || recovery.lifetimeReplacement) ||
            require('Spawn.Policy').isImminentOwnedDefense(q) ||
            ['controllerSafety', 'criticalController'].includes(Economy.categoryForRequest(q));
    }));
    queue.sort(function(a, b) {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }

        return a.requestedAt - b.requestedAt;
    });
    // Keep established recovery priorities. Only move urgent work ahead of an
    // earlier discretionary upgrade, rather than reordering the whole economy.
    for (const urgent of queue.filter(q => urgentRequests.has(q))) {
        const index = queue.indexOf(urgent);
        const upgrade = queue.findIndex((q, i) => i < index && q.minerUpgrade);
        if (upgrade >= 0) {
            queue.splice(index, 1);
            queue.splice(upgrade, 0, urgent);
        }
    }

    var request = null;
    var requestIndex = -1;
    var bodySelection = null;
    var blockedReasons = {};
    var unaffordableRoles = [];
    var waitingPriority = null;
    const availableEnergy = SpawnIntents.available(spawn.room);
    const previewSpawn = { room: Object.create(spawn.room, { energyAvailable: { value: availableEnergy } }) };

    for (var queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        var candidate = queue[queueIndex];
        const details = { selectedRole: candidate && candidate.role || 'unknown',
            selectedRequestId: candidate && candidate.requestId || null,
            priority: candidate && candidate.priority || 0,
            bodyCost: candidate && Array.isArray(candidate.body) ? getBodyCost(candidate.body) : null };
        if (!candidate || !candidate.role || !Array.isArray(candidate.body) || !candidate.body.length ||
            !candidate.memory || candidate.memory.role !== candidate.role) {
            Object.assign(decision, details, { stage: 'request', reason: 'invalid request body or role memory' });
            decision.blocked = { role: details.selectedRole, reason: decision.reason };
            queue.splice(queueIndex--, 1);
            continue;
        }
        var finalAdmission = SpawnArbiter.revalidate(spawn.room, candidate);
        details.arbiterAllowed = finalAdmission.allowed;
        details.arbiterReason = finalAdmission.reason;
        details.blockSource = finalAdmission.blockSource || null;
        details.configPath = finalAdmission.configPath || null;
        if (!finalAdmission.allowed) {
            if (!decision.blocked) Object.assign(decision, details, { stage: 'arbiter',
                blocked: { role: candidate.role, reason: finalAdmission.reason } });
            blockedReasons[candidate && candidate.role || 'unknown'] = finalAdmission.reason;
            if (finalAdmission.obsolete || finalAdmission.reason === 'request expired' || finalAdmission.reason === 'operation is terminal') {
                queue.splice(queueIndex, 1);
                queueIndex--;
            }
            continue;
        }
        // The job can change while queued. A once-discretionary upgrade must
        // preserve income when its predecessor is dying or has already died.
        if (finalAdmission.lifetimeReplacement) {
            candidate.minerUpgrade = false;
            candidate.minimumWorkParts = finalAdmission.minimumWorkParts;
        }
        if (candidate.minerConsolidation && !finalAdmission.minerConsolidation) {
            delete candidate.minerConsolidation;
            candidate.requestedWorkParts = Math.max(1, finalAdmission.localMissingWork || 1);
            candidate.maxWorkParts = candidate.requestedWorkParts;
            if (candidate.bodyProfile) candidate.bodyProfile.desiredWork = candidate.bodyProfile.maxWork = candidate.requestedWorkParts;
        }
        var policy = Economy.canSpawnRequest(spawn.room, candidate);
        details.economyAllowed = policy.allowed;
        details.economyReason = policy.reason;
        if (!policy.allowed) {
            blockedReasons[candidate && candidate.role || 'unknown'] = policy.reason;
            continue;
        }

        const category = Economy.categoryForRequest(candidate);
        const memory = candidate.memory || {};
        const localCore = ['Foreman', 'Extractor', 'Freighter'].includes(candidate.role) &&
            (candidate.role !== 'Freighter' || Economy.isLocalFreighter(candidate)) &&
            !memory.remoteMining && !memory.remoteSourceId && !memory.remoteWorkTargetId &&
            (!memory.sourceRoom || memory.sourceRoom === roomName) &&
            (!memory.targetRoom || memory.targetRoom === roomName);
        const coreContext = localCore && require('Spawn.Context').snapshot(roomName, 50);
        const missingCore = coreContext && (coreContext.byRole[candidate.role] || 0) <=
            coreContext.queue.filter(q => q && q.role === candidate.role).length;
        const survival = finalAdmission.mandatoryEconomy && !candidate.minerUpgrade || missingCore ||
            ['controllerSafety', 'criticalController'].includes(category) ||
            require('Spawn.Policy').isImminentOwnedDefense(candidate);
        if (waitingPriority !== null && (candidate.priority || 0) < waitingPriority && !survival) continue;

        /* Select malformed allowed work so the existing cleanup path removes it. */
        if (!candidate || !candidate.role || !candidate.body) {
            request = candidate;
            requestIndex = queueIndex;
            break;
        }

        var bodyCandidate = candidate;
        if (finalAdmission.localMissingWork > 0) {
            bodyCandidate = Object.assign({}, candidate, { requestedWorkParts: Math.min(
                candidate.requestedWorkParts || candidate.maxWorkParts || countBodyParts(candidate.body, WORK),
                finalAdmission.localMissingWork) });
        }
        if (finalAdmission.missingCarry > 0 && !candidate.bodyRequirements?.fixed) {
            const carry = Math.min(candidate.requestedCarryParts || candidate.maxCarryParts ||
                countBodyParts(candidate.body, CARRY), finalAdmission.missingCarry);
            bodyCandidate = Object.assign({}, candidate, { requestedCarryParts: carry, maxCarryParts: carry });
            bodyCandidate.minimumCarryParts = finalAdmission.minimumCarryParts || 0;
            if (candidate.bodyProfile) bodyCandidate.bodyProfile = { ...candidate.bodyProfile, desiredCarry: carry };
        }
        var preview = previewAffordableQueuedBodyForSpawn(previewSpawn, bodyCandidate);
        candidate.affordableBodyCache = bodyCandidate.affordableBodyCache;
        const sizing = require('Spawn.Sizing').evaluate(spawn.room, candidate, preview, survival);
        details.sizingReason = sizing.reason;
        details.energyCapacity = sizing.capacity;
        details.preferredCost = sizing.preferredCost;
        details.selectedBody = preview.body;
        if (sizing.wait) {
            waitingPriority = Math.max(waitingPriority === null ? -Infinity : waitingPriority, candidate.priority || 0);
            if (!decision.waitingForEnergy) Object.assign(decision, details, { stage: 'body',
                waitingForEnergy: candidate.requestId || candidate.role, requiredEnergy: sizing.preferredCost,
                blocked: { role: candidate.role, reason: sizing.reason } });
            unaffordableRoles.push(candidate.role);
            continue;
        }
        if (!preview.selection.affordable) {
            if (!decision.blocked) Object.assign(decision, details, { stage: 'body',
                blocked: { role: candidate.role, reason: sizing.reason === 'insufficient maximum spawning capacity' ?
                    sizing.reason : preview.selection.reason } });
            unaffordableRoles.push(candidate.role);
            // Reserve future refills only for a body this room can actually build.
            const atCapacity = { room: Object.create(spawn.room, {
                energyAvailable: { value: spawn.room.energyCapacityAvailable } }) };
            const future = previewAffordableQueuedBodyForSpawn(atCapacity, bodyCandidate);
            if (sizing.reserve && future.selection.affordable && future.body.length <= 50 && getBodyCost(future.body) > 0) {
                waitingPriority = Math.max(waitingPriority === null ? -Infinity : waitingPriority, candidate.priority || 0);
                decision.waitingForEnergy = candidate.requestId || candidate.role;
                decision.requiredEnergy = minimumQueuedBodyCost(spawn.room, bodyCandidate) || getBodyCost(future.body);
            }
            continue;
        }

        request = candidate;
        requestIndex = queueIndex;
        request.body = preview.body;
        delete decision.waitingForEnergy;
        delete decision.blocked;
        decision.requiredEnergy = getBodyCost(request.body);
        bodySelection = preview.selection;
        Object.assign(decision, details, { emergencyReplacement: !!finalAdmission.mandatoryEconomy, stage: 'name', bodyCost: getBodyCost(request.body),
            work: countBodyParts(request.body, WORK) });
        break;
    }

    if (!request) {
        if (unaffordableRoles.length > 0) {
            return {
                ok: false,
                result: ERR_NOT_ENOUGH_ENERGY,
                reason: 'No economy-allowed request has an affordable body',
                unaffordable: unaffordableRoles,
                blocked: blockedReasons
            };
        }
        return {
            ok: false,
            result: null,
            reason: decision.blocked ? decision.blocked.reason : 'All queued requests blocked',
            blocked: blockedReasons
        };
    }

    if (!request || !request.role || !request.body) {
        /*
         * Bad request. Remove it so it does not block the queue forever.
         */
        queue.splice(requestIndex, 1);

        return {
            ok: false,
            result: ERR_INVALID_ARGS,
            reason: 'Removed bad spawn request'
        };
    }

    var creepName = spawnUtility.genCreepName(request.role);

    /*
     * genCreepName reads Game.creeps and Memory.creeps to avoid collisions.
     * If it returns null, this request stays queued until a name frees up.
     */
    if (!creepName) {
        return {
            ok: false,
            result: ERR_NAME_EXISTS,
            reason: 'No free creep name available for ' + request.role
        };
    }

    /*
     * A successful spawn is removed from the queue before the new creep is
     * guaranteed to appear in Game.creeps. Keep the final affordable body's
     * WORK count with the ordinary scalar creep memory so Artificer demand can
     * account for that in-progress production through spawn.spawning.name.
     */
    if (request.role === 'Artificer') {
        request.memory = request.memory || {};
        request.memory.artificerSpawnWorkParts = countBodyParts(request.body, WORK);
        if (!request.memory.artificerWorkCategory && request.economyCategory) {
            request.memory.artificerWorkCategory = request.economyCategory;
        }
    }
    if (request.role === 'Extractor') request.memory.extractorSpawnWorkParts = countBodyParts(request.body, WORK);
    if (request.role === 'Freighter' && request.freighterRenewal && !finalAdmission?.freighterRenewal) {
        // A recovery fallback must not keep claiming the abandoned cohort.
        delete request.memory.freighterPredecessors;
        delete request.freighterRenewal;
        delete request.replacementFor;
    }
    if (finalAdmission?.freighterRenewal) request.memory.freighterPredecessors = finalAdmission.freighterPredecessors;
    if (finalAdmission?.remoteHaulRelief) request.memory.remoteHaulRelief = {
        spawnedAt: Game.time, projectedCpu: finalAdmission.remoteHaulRelief.projectedCpu,
        ceiling: finalAdmission.remoteHaulRelief.ceiling
    };
    else delete request.memory.remoteHaulRelief;
    if (finalAdmission?.remoteRestart) request.memory.remoteRestart = {
        spawnedAt: Game.time, projectedCpu: finalAdmission.remoteRestart.projectedCpu, ceiling: finalAdmission.remoteRestart.ceiling
    };
    else delete request.memory.remoteRestart;
    request.memory.spawnCapability = { work: countBodyParts(request.body, WORK), carry: countBodyParts(request.body, CARRY),
        claim: countBodyParts(request.body, CLAIM) };
    if (['Tech','Artificer'].includes(request.role)) {
        const predecessors = (Array.isArray(request.replacementFor) ? request.replacementFor : []).slice(0,50).map(name => Game.creeps[name]).filter(c =>
            c && c.memory.role === request.role && c.memory.homeRoom === roomName && c.ticksToLive > 0 && c.ticksToLive <= 150);
        const work = request.memory.spawnCapability.work;
        delete request.memory.workerPredecessors; delete request.memory.workerReplacementWork;
        if (predecessors.length && work > 0) {
            request.memory.workerPredecessors = predecessors.map(c => ({name:c.name,deathAt:Game.time+c.ticksToLive}));
            request.memory.workerReplacementWork = Math.min(work,predecessors.reduce((sum,c) => sum +
                (c.body || []).filter(p => (p.type || p) === WORK && p.hits !== 0).length,0));
        }
    }
    if (request.role === 'Freighter') request.memory.freighterSpawnCarryParts = countBodyParts(request.body, CARRY);

    /*
     * spawn.spawnCreep is the Screeps API call that starts spawning a creep.
     * The body controls parts, creepName is the unique name, and memory becomes
     * the new creep's creep.memory when it exists.
     */
    decision.stage = 'spawnCreep';
    var result = spawn.spawnCreep(
        request.body,
        creepName,
        {
            memory: request.memory
        }
    );

    /*
     * spawnCreep returns OK when spawning is scheduled.
     * If there is not enough energy, leave the request in queue.
     */
    if (result === OK) {
        SpawnIntents.record(spawn, creepName, request, getBodyCost(request.body), availableEnergy);
        require('Remote.Accounting').recordSpawn(spawn.room.name, request, request.body);
        queue.splice(requestIndex, 1);

        try { console.log(
            'Spawning ' + creepName +
            ' as ' + request.role +
            ' in ' + roomName +
            (bodySelection.reason === 'downgraded to affordable body' ?
                ' after downgrading body from ' + bodySelection.oldCost +
                ' to ' + bodySelection.newCost + ' energy' :
                ' using affordable body cost ' + bodySelection.newCost)
        ); } catch (loggingError) { /* The accepted spawn remains successful. */ }

        return {
            ok: true,
            result: result,
            name: creepName,
            role: request.role,
            bodySelection: bodySelection
        };
    }

    /*
     * Not enough energy is normal.
     * Leave the request in the queue.
     */
    if (result === ERR_NOT_ENOUGH_ENERGY) {
        return {
            ok: false,
            result: result,
            role: request.role,
            reason: 'Not enough energy yet'
        };
    }

    /*
     * Busy is also normal, though findIdleSpawn should avoid it.
     * Leave the request in the queue.
     */
    if (result === ERR_BUSY) {
        return {
            ok: false,
            result: result,
            role: request.role,
            reason: 'Spawn is busy'
        };
    }

    /*
     * Name exists should be rare because genCreepName checks names.
     * Leave the request in queue so it can try again next tick.
     */
    if (result === ERR_NAME_EXISTS) {
        return {
            ok: false,
            result: result,
            role: request.role,
            reason: 'Generated name already exists'
        };
    }

    /*
     * Other errors probably mean the request is bad.
     * Remove it so the queue does not get stuck forever.
     */
    queue.splice(requestIndex, 1);

    return {
        ok: false,
        result: result,
        role: request.role,
        reason: 'Spawn request failed and was removed'
    };
}

function runRoom(roomName) {
    const memory = HiveMemory.getRoomSpawnMemory(roomName);
    const room = Game.rooms && Game.rooms[roomName];
    const idle = findIdleSpawn(roomName);
    const decision = { tick: Game.time, spawnName: idle && idle.name || null,
        idle: !!idle, queueLength: memory.queue.length,
        energyAvailable: room && room.energyAvailable || 0, stage: 'queue' };
    // Persist even if a malformed legacy request or API wrapper throws.
    memory.lastDecision = decision;
    try {
        const idleSpawns = Object.values(Game.spawns).filter(spawn => spawn && spawn.room &&
            spawn.room.name === roomName && !spawn.spawning && !SpawnIntents.get().used.has(spawn.name));
        const attempts = [];
        const spawned = [];
        let result;
        for (const spawn of idleSpawns.length ? idleSpawns : [null]) {
            const attempt = { tick: Game.time, stage: 'queue', queueLength: memory.queue.length };
            let outcome;
            try { outcome = runRoomInternal(roomName, attempt, spawn); }
            catch (error) { Object.assign(decision, attempt); throw error; }
            attempts.push({ ...attempt, result: outcome.result, reason: outcome.reason || 'spawn started' });
            if (!result || outcome.result === OK && result.result !== OK) {
                result = outcome;
                Object.assign(decision, attempt);
            }
            if (outcome.result === OK) spawned.push({ name: outcome.name, role: outcome.role, spawnName: spawn.name,
                cost: attempt.bodyCost, emergency: !!attempt.emergencyReplacement });
            if (!memory.queue.length || outcome.result === ERR_NOT_ENOUGH_ENERGY) break;
        }
        decision.attempts = attempts;
        result.spawned = spawned;
        decision.result = result.result;
        decision.reason = result.reason || 'spawn started';
        decision.queueRemaining = memory.queue.length;
        decision.status = result.result === OK ? 'BUSY' : !decision.idle ? 'BUSY' :
            result.ok && !decision.blocked ? 'IDLE' : decision.stage === 'spawnCreep' || decision.stage === 'name' ? 'ERROR' : 'BLOCK';
        const Diagnostics = require('Diagnostics');
        if (spawned.length) for (const unit of spawned) Diagnostics.record('SPAWNING', 'INFO', unit.emergency ? 'SPAWN_EMERGENCY_REPLACEMENT' : 'SPAWN_STARTED', roomName,
            { role: unit.role, creep: unit.name, spawn: unit.spawnName, cost: unit.cost });
        else if (decision.status === 'ERROR' || decision.status === 'BLOCK') Diagnostics.record('SPAWNING',
            decision.status === 'ERROR' ? 'ERROR' : 'WARN', decision.waitingForEnergy ? 'SPAWN_WAITING_ENERGY' : 'SPAWN_REJECTED',
            roomName, { role: decision.selectedRole, reason: decision.blocked && decision.blocked.reason || decision.reason,
                available: decision.energyAvailable, required: decision.requiredEnergy || decision.bodyCost });
        else if (decision.idle && memory.queue.length) Diagnostics.record('SPAWNING', 'WARN', 'SPAWN_IDLE_WITH_DEMAND',
            roomName, { queue: memory.queue.length, reason: decision.reason });
        for (const unit of spawned) {
            const claims = Memory.creeps?.[unit.name]?.freighterPredecessors;
            if (unit.role === 'Freighter' && Array.isArray(claims) && claims.length > 1) {
                Diagnostics.record('SPAWNING', 'INFO', 'FREIGHTER_RENEWAL_STARTED', roomName,
                    { creep: unit.name, cost: unit.cost, workers: claims.length,
                        through: Math.max(...claims.map(p => p.deathAt)), predecessors: claims.map(p => p.name).join(',') });
            }
        }
        return result;
    } catch (error) {
        decision.status = 'ERROR';
        decision.reason = String(error.message || error).slice(0, 160);
        throw error;
    }
}

module.exports = {
    getBodyCost: getBodyCost,
    selectAffordableQueuedBodyForSpawn: selectAffordableQueuedBodyForSpawn,
    previewAffordableQueuedBodyForSpawn: previewAffordableQueuedBodyForSpawn,
    getSpawnQueue: getSpawnQueue,
    countAliveRole: countAliveRole,
    countQueuedRole: countQueuedRole,
    requestRoleCount: requestRoleCount,
    findIdleSpawn: findIdleSpawn,
    runRoom: runRoom
};
