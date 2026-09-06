const HiveMemory = require('HiveMind.Memory');
const Economy = require('HiveMind.Economy');
const ColonyState = require('HiveMind.ColonyState');
const Context = require('Spawn.Context');
const Bodies = require('role.creepBodyConfig');
const Capacity = require('HiveMind.Capacity');

function maxCreeps(room, policy) {
    const rcl = room && room.controller && room.controller.level || 1;
    const capacity = room && Capacity.get().rooms[room.name];
    if (capacity) return capacity.population.softCap;
    return policy.maxCreepsPerRoomByRcl && policy.maxCreepsPerRoomByRcl[`RCL${rcl}`] || 10;
}

function isOwnedDefense(request) {
    const memory = request.memory || {};
    const targetName = memory.defendedRoom || request.defendedRoom || request.targetRoom;
    const target = targetName && Game.rooms[targetName];
    return memory.defenseRequest === true && target && target.controller && target.controller.my;
}

function economyRoleCap(room, role, request, policy) {
    const configured = policy.roleCaps && policy.roleCaps[role];
    if (['Tech', 'Artificer'].includes(role) && request.maxWorkParts > 0) {
        const view = Capacity.get().rooms[room.name];
        return view && ['NORMAL', 'SURPLUS', 'EXPAND'].includes(view.mode) ?
            Math.max(configured || 0, role === 'Tech' ? 5 : 8) : configured;
    }
    if (role === 'Annex') {
        const planner = Memory.rooms[room.name] && Memory.rooms[room.name].remotePlanner || {};
        const rooms = new Set((planner.activeSourceIds || []).map(id => (planner.sourceInfos || {})[id])
            .filter(info => info && info.active && info.operational !== false && (!info.route || info.route.valid !== false))
            .map(info => info.roomName).filter(name => {
                const controller = require('Remote.Intel').controller(name);
                const spawn = (require('HiveMind.Index').get().ownedSpawnsByRoom.get(room.name) || [])[0];
                const username = HiveMemory.ensure().identity.username || spawn && spawn.owner && spawn.owner.username;
                return controller && !controller.my && !controller.owner &&
                    (!controller.reservation || controller.reservation.username === username);
            }));
        return Math.min(6, Math.max(configured || 0, rooms.size));
    }
    if (!['Extractor', 'Freighter'].includes(role)) return configured;
    const memory = Memory.rooms[room.name] || {};
    const planner = memory.remotePlanner || {};
    const active = (planner.activeSourceIds || []).map(id => (planner.sourceInfos || {})[id]).filter(info =>
        info && info.active && info.operational !== false && (!info.route || info.route.valid !== false));
    const economy = Economy.get(room.name) || {};
    let required;
    if (role === 'Extractor') {
        const body = request.body || Bodies.getExtractorBody(room) || [];
        const work = Math.max(1, body.filter(part => (part.type || part) === WORK).length);
        const localSources = Object.values(memory.sources || {});
        const local = localSources.length ? localSources.reduce((sum, source) => sum + Math.max(1,
            Math.min(source.seatCount || source.seats && source.seats.length || Infinity,
                Math.ceil((source.requiredWork || 5) / work))), 0) :
            (typeof room.find === 'function' ? room.find(FIND_SOURCES) || [] : []).length;
        required = local + active.reduce((sum, info) => sum + Math.max(1, Math.ceil((info.requiredWork || work) / work)), 0);
    } else {
        const body = request.body || Bodies.getFreighterBody(room) || [];
        const carry = Math.max(1, body.filter(part => (part.type || part) === CARRY).length);
        const requiredCarry = (economy.haul && economy.haul.requiredCarry || 0) +
            active.reduce((sum, info) => sum + (info.requiredCarry || 0), 0);
        required = Math.ceil(requiredCarry / carry);
    }
    const hard = policy.economyRoleHardCaps && policy.economyRoleHardCaps[role] || (role === 'Extractor' ? 32 : 64);
    return Math.min(hard, Math.max(configured || 0, required + 1)); // One replacement handoff.
}

function evaluate(room, request, context, options = {}) {
    if (!room || !request) return { allowed: false, reason: 'missing room or request' };
    const operation = request.operationId && HiveMemory.ensure().operations[request.operationId];
    if (operation && ['COMPLETE', 'ABORTED'].includes(operation.state)) {
        return { allowed: false, reason: 'operation is terminal' };
    }
    if (request.expiresAt && request.expiresAt < Game.time) return { allowed: false, reason: 'request expired' };
    const economy = Economy.canSpawnRequest(room, request);
    if (!economy.allowed) return { allowed: false, reason: economy.reason };
    const recovery = Economy.localRecoveryRequest(room, request, context.queue);
    if (recovery.obsolete) return { allowed: false, obsolete: true, reason: recovery.reason };
    const lifecycle = ColonyState.get(room.name);
    const category = Economy.categoryForRequest(request);
    const controllerGrowthFloor = category === 'controllerGrowth' && request.memory &&
        request.memory.controllerGrowthFloor === true;
    const protectedWork = ['harvest', 'logistics', 'spawnFill', 'controllerSafety',
        'criticalController', 'controllerGrowth'].includes(category);
    if (controllerGrowthFloor) {
        const floorCoveredOnlyByThisRequest = lifecycle && lifecycle.growthAllowed &&
            lifecycle.baselineTechWork > 0 && (context.byRole.Tech || 0) <= (options.revalidate ? 1 : 0);
        if (!lifecycle || !lifecycle.growthAllowed ||
            (!lifecycle.baselineTechRequired && !floorCoveredOnlyByThisRequest)) {
            return { allowed: false, reason: lifecycle && lifecycle.blockedReason || 'baseline controller growth is not required' };
        }
    }
    const economicScout = category === 'remoteIntel' && (request.role || request.memory && request.memory.role) === 'Scout';
    if (economicScout && lifecycle && (lifecycle.alert === 'SIEGE' || lifecycle.nextMandatoryRole)) {
        return { allowed: false, reason: lifecycle.blockedReason || 'mandatory local floor pending' };
    }
    if (lifecycle && ['OWNED_NO_SPAWN', 'BOOTSTRAP'].includes(lifecycle.phase) && !protectedWork && !isOwnedDefense(request) && !economicScout) {
        return { allowed: false, reason: `blocked during ${lifecycle.phase}` };
    }
    const policy = HiveMemory.getConfig('spawn');
    if (policy.enabled === false) return { allowed: true, reason: 'spawn policy disabled' };
    const role = request.role || request.memory && request.memory.role;
    const ownedDefense = isOwnedDefense(request);
    if (ownedDefense) {
        const hasAnchor = (context.byRole.Extractor || 0) > 0 && (context.byRole.Freighter || 0) > 0;
        if (!hasAnchor) return { allowed: false, reason: 'protected survival economy anchor missing' };
        const combatQueued = context.queue.filter(item => {
            const itemRole = item && (item.role || item.memory && item.memory.role);
            return ['Ronin', 'Volley', 'Cleric'].includes(itemRole);
        }).length;
        const shareLimit = Math.max(1, Math.ceil((policy.maxQueueLengthPerRoom || 8) *
            Math.max(0.1, Math.min(1, policy.combatSpawnShare || 0.5))));
        if (!request.emergency && combatQueued >= shareLimit) {
            return { allowed: false, reason: 'combat spawn-share budget exhausted' };
        }
    }
    const localEconomicRole = recovery.missing !== undefined;
    const survivalBypass = recovery.mandatory || !localEconomicRole &&
        options.emergency === true && options.bypassRoleCap === true && protectedWork;
    const defenseBypass = ownedDefense && request.emergency === true;
    const seasonId = request.memory && (request.memory.season11ReactorGuard || request.memory.season11ReactorId);
    const seasonEmergency = seasonId &&
        HiveMemory.ensure().season && HiveMemory.ensure().season.season11 &&
        HiveMemory.ensure().season.season11.reactorPortfolio &&
        HiveMemory.ensure().season.season11.reactorPortfolio.reactors[seasonId];
    const capacity = Capacity.evaluate(room, request, context, survivalBypass || defenseBypass ||
        !!(seasonEmergency && seasonEmergency.owned && seasonEmergency.threat && seasonEmergency.threat.claimThreat > 0), options.revalidate);
    if (!capacity.allowed) return capacity;
    const roleCap = economyRoleCap(room, role, request, policy);
    const ownQueued = options.revalidate && context.queue.includes(request) ? 1 : 0;
    const mandatoryFloorBypass = controllerGrowthFloor && lifecycle && lifecycle.growthAllowed &&
        (context.byRole.Tech || 0) <= (options.revalidate ? 1 : 0) &&
        context.nonCombatTotal <= (policy.maxCreepsPerRoomByRcl['RCL' + room.controller.level] || 10) + (options.revalidate ? 1 : 0);
    if (typeof roleCap === 'number' && (context.byRole[role] || 0) - ownQueued - (capacity.replacementCount || 0) >= roleCap && !survivalBypass && !mandatoryFloorBypass) {
        return { allowed: false, reason: 'role cap reached' };
    }
    // Capacity owns the population ceiling; RCL remains a baseline and role guardrail.
    if (!options.revalidate && context.queue.length >= policy.maxQueueLengthPerRoom && !survivalBypass && !defenseBypass) {
        return { allowed: false, reason: 'spawn queue full' };
    }
    const admitted = context.queue.filter(item => item && item.requestedAt === Game.time).length;
    if (!options.revalidate && admitted >= policy.maxNewRequestsPerRoomPerTick && !survivalBypass && !defenseBypass && !economicScout) {
        return { allowed: false, reason: 'new request cap reached' };
    }
    return { allowed: true, reason: recovery.mandatory ? recovery.reason : options.revalidate ? 'revalidated' : 'admitted',
        localMissingWork: (request.role || request.memory && request.memory.role) === 'Extractor' ? recovery.missing : undefined,
        mandatoryEconomy: recovery.mandatory, mandatoryFloorBypass: mandatoryFloorBypass || recovery.mandatory &&
            context.nonCombatTotal - ownQueued >= maxCreeps(room, policy) };
}

module.exports = { economyRoleCap, evaluate, isOwnedDefense, maxCreeps };
