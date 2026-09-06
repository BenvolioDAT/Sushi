const HiveMemory = require('HiveMind.Memory');
const Operations = require('HiveMind.Operations');
const CombatPolicy = require('Combat.Policy');
const CombatMath = require('Combat.Math');
const Utility = require('HiveMind.Utility');
const TickIndex = require('HiveMind.Index');

const OFFENSIVE_TYPES = Object.freeze(['ATTACK_PLAYER', 'RAID_REMOTE', 'CONTEST_REACTOR']);
const OBJECTIVES = Object.freeze([
    'REMOTE_DEFENSE', 'REMOTE_DENIAL', 'REACTOR_CONTEST', 'HARASSMENT',
    'TOWER_SIEGE', 'DISMANTLE_BREACH'
]);
const HARD_FAILURES = new Set([
    'ALLY_TARGET', 'NO_DIRECTIVE', 'OUTHEALED', 'UNBREAKABLE',
    'UNSURVIVABLE', 'NO_RETREAT_PATH'
]);

function safeFind(room, constant) {
    if (!room || typeof room.find !== 'function' || constant === undefined) return [];
    try {
        return room.find(constant) || [];
    }
    catch (error) {
        return [];
    }
}

function ownerName(subject) {
    if (typeof subject === 'string') return subject;
    return subject && subject.owner && subject.owner.username || null;
}

function operationDirective(operation) {
    if (operation.season11 && ['disabled', 'observe'].includes(HiveMemory.getConfig('season11').mode)) return false;
    if (operation.season11 && operation.type === 'CONTEST_REACTOR' && operation.season11RecaptureApproved) {
        return CombatPolicy.mayLaunchOffense(operation.targetOwner, operation.manualDirective === true);
    }
    if (operation.manualDirective === true) return true;
    return !!(operation.type === 'CONTEST_REACTOR' && operation.season11 &&
        HiveMemory.getConfig('season11').recaptureMode === 'manual' && HiveMemory.getConfig('season11').recapture === true);
}

function roomSnapshot(operation) {
    const room = operation.targetRoom && Game.rooms && Game.rooms[operation.targetRoom];
    if (!room) return { visible: false };
    const index = TickIndex.get();
    const hostileCreeps = index.hostilesByRoom.get(room.name) || safeFind(room,
        typeof FIND_HOSTILE_CREEPS !== 'undefined' ? FIND_HOSTILE_CREEPS : undefined);
    const byType = index.structuresByRoom.get(room.name);
    const indexedStructures = byType ? Array.from(byType.values()).flat() : [];
    const hostileStructures = indexedStructures.length ? indexedStructures.filter(structure => structure.my === false) :
        safeFind(room, typeof FIND_HOSTILE_STRUCTURES !== 'undefined' ? FIND_HOSTILE_STRUCTURES : undefined);
    const towerType = typeof STRUCTURE_TOWER !== 'undefined' ? STRUCTURE_TOWER : 'tower';
    const rampartType = typeof STRUCTURE_RAMPART !== 'undefined' ? STRUCTURE_RAMPART : 'rampart';
    const wallType = typeof STRUCTURE_WALL !== 'undefined' ? STRUCTURE_WALL : 'constructedWall';
    const towers = hostileStructures.filter(structure => structure.structureType === towerType &&
        (!structure.store || (structure.store[RESOURCE_ENERGY] || 0) > 0));
    const barriers = hostileStructures.filter(structure =>
        structure.structureType === rampartType || structure.structureType === wallType);
    const hostileAnalyses = hostileCreeps.map(creep => CombatMath.analyzeBody(creep));
    const enemyDamage = hostileAnalyses.reduce((sum, analysis) => sum + analysis.melee + analysis.ranged, 0);
    const enemyHealing = hostileAnalyses.reduce((sum, analysis) => sum + analysis.heal, 0);
    const repairPower = typeof REPAIR_POWER !== 'undefined' && Number.isFinite(REPAIR_POWER) ? REPAIR_POWER : 100;
    const enemyRepair = hostileCreeps.reduce((sum, creep) => {
        if (!creep || !Array.isArray(creep.body)) return sum;
        return sum + creep.body.filter(part => part && part.hits > 0 &&
            part.type === (typeof WORK !== 'undefined' ? WORK : 'work')).length * repairPower;
    }, 0);
    const targetPosition = operation.targetPosition && new RoomPosition(
        operation.targetPosition.x, operation.targetPosition.y, operation.targetPosition.roomName || operation.targetRoom
    );
    const sampleTarget = { pos: targetPosition || new RoomPosition(25, 25, operation.targetRoom) };
    const towerDamage = towers.reduce((sum, tower) => sum + CombatMath.towerDamage(tower, sampleTarget), 0);
    const controllerSafeMode = room.controller && Math.max(0, room.controller.safeMode || 0);
    return {
        visible: true,
        room,
        hostileStructures,
        hostileCreeps,
        towers,
        barriers,
        enemyDamage,
        enemyHealing,
        enemyRepair,
        towerDamage,
        controllerSafeMode,
        minimumBarrierHits: barriers.length ? Math.min(...barriers.map(barrier => barrier.hits || 0)) : 0
    };
}

function retreatRouteAvailable(operation) {
    const destination = operation.retreatRoom || operation.originRoom;
    if (!operation.targetRoom || !destination || operation.targetRoom === destination) return true;
    if (!Game.map || typeof Game.map.findRoute !== 'function') return true;
    if (!global.__sushiOffenseRoutes) global.__sushiOffenseRoutes = {};
    const key = `${operation.targetRoom}>${destination}`;
    const cached = global.__sushiOffenseRoutes[key];
    if (cached && cached.expires >= Game.time) return cached.available;
    try {
        const route = Game.map.findRoute(operation.targetRoom, destination);
        const noPath = typeof ERR_NO_PATH !== 'undefined' ? ERR_NO_PATH : -2;
        const available = Array.isArray(route) && route !== noPath;
        global.__sushiOffenseRoutes[key] = { available, expires: Game.time + 100 };
        return available;
    }
    catch (error) {
        global.__sushiOffenseRoutes[key] = { available: false, expires: Game.time + 25 };
        return false;
    }
}

function countBoostUnits(operation) {
    let units = 0;
    const requirements = operation.boostRequirements || {};
    for (const list of Object.values(requirements)) {
        for (const requirement of list || []) {
            units += (typeof requirement === 'object' && requirement.parts || 1) * 30;
        }
    }
    return units;
}

function evaluate(operation) {
    if (!operation || !OFFENSIVE_TYPES.includes(operation.type)) {
        return { allowed: false, viable: false, code: 'NOT_OFFENSE', reason: 'Not an offensive operation' };
    }
    const directive = operationDirective(operation);
    const snapshot = roomSnapshot(operation);
    let targetOwner = operation.targetOwner || null;
    if (!targetOwner && snapshot.visible) {
        targetOwner = ownerName(snapshot.hostileStructures[0]) || ownerName(snapshot.hostileCreeps[0]) ||
            ownerName(snapshot.room.controller);
    }
    const subject = targetOwner || operation.targetOwner || null;
    if (subject && CombatPolicy.isAlly(subject)) {
        return { allowed: false, viable: false, code: 'ALLY_TARGET', reason: `${subject} is configured as an ally`, targetOwner };
    }
    if (!directive) {
        return { allowed: false, viable: false, code: 'NO_DIRECTIVE', reason: 'Offense requires an explicit directive', targetOwner };
    }
    if (subject && !CombatPolicy.mayLaunchOffense(subject, true)) {
        return { allowed: false, viable: false, code: 'POLICY_REJECTED', reason: 'Diplomacy policy rejected target', targetOwner };
    }
    const desired = operation.desiredCapabilities || {};
    const expectedDamage = Math.max(0, desired.damage || desired.ranged || desired.melee || 0);
    const expectedDismantle = Math.max(0, desired.dismantle || 0);
    const expectedHealing = Math.max(0, desired.healing || 0);
    const distance = operation.originRoom && operation.targetRoom && Game.map &&
        typeof Game.map.getRoomLinearDistance === 'function' ?
        Game.map.getRoomLinearDistance(operation.originRoom, operation.targetRoom) : 0;
    const metrics = {
        targetOwner,
        targetValue: Utility.normalize(operation.targetValue || 50),
        travelTime: Math.max(0, distance * 50),
        expectedDamage,
        expectedDismantle,
        expectedHealing,
        boostMineralCost: countBoostUnits(operation),
        enemyTowers: snapshot.towers && snapshot.towers.length || 0,
        enemyTowerDamage: snapshot.towerDamage || 0,
        enemyCreepDamage: snapshot.enemyDamage || 0,
        enemyHealing: snapshot.enemyHealing || 0,
        enemyRepair: snapshot.enemyRepair || 0,
        minimumBarrierHits: snapshot.minimumBarrierHits || 0,
        safeModeTicks: snapshot.controllerSafeMode || 0,
        visible: snapshot.visible,
        retreatRouteAvailable: retreatRouteAvailable(operation)
    };
    metrics.expectedLossPressure = Math.max(0,
        metrics.enemyTowerDamage + metrics.enemyCreepDamage - expectedHealing);
    const utility = Utility.score({
        urgency: operation.priority || 50,
        expectedValue: metrics.targetValue,
        strategicValue: operation.type === 'CONTEST_REACTOR' ? 85 : 50,
        energyCost: Utility.normalize(metrics.boostMineralCost / 30),
        spawnCost: operation.preferredSquadType === 'SIEGE_QUAD' ? 55 : 40,
        travelTime: Utility.normalize(distance * 5),
        risk: Utility.normalize(metrics.expectedLossPressure / 20 + metrics.enemyHealing / 10),
        opportunityCost: Utility.normalize(operation.opportunityCost || 10)
    });
    if (!snapshot.visible) {
        return { allowed: true, viable: true, wait: true, code: 'NEEDS_INTEL', reason: 'Target room is not visible; await scout intel', metrics, utility };
    }
    if (metrics.safeModeTicks > 0) {
        return { allowed: true, viable: true, wait: true, code: 'SAFE_MODE', reason: `Target safe mode has ${metrics.safeModeTicks} ticks remaining`, metrics, utility };
    }
    if (!metrics.retreatRouteAvailable) {
        return { allowed: true, viable: false, code: 'NO_RETREAT_PATH', reason: 'No route from target to the configured retreat room', metrics, utility };
    }
    if (snapshot.hostileCreeps.length && expectedDamage > 0 && expectedDamage <= metrics.enemyHealing) {
        return { allowed: true, viable: false, code: 'OUTHEALED', reason: `Expected damage ${expectedDamage} cannot beat healing ${metrics.enemyHealing}`, metrics, utility };
    }
    if (metrics.minimumBarrierHits > 0 && expectedDamage + expectedDismantle <= metrics.enemyRepair) {
        return { allowed: true, viable: false, code: 'UNBREAKABLE', reason: `Breach power ${expectedDamage + expectedDismantle} cannot beat repair ${metrics.enemyRepair}`, metrics, utility };
    }
    if (metrics.enemyTowerDamage > 0 && expectedHealing > 0 && metrics.enemyTowerDamage > expectedHealing * 4) {
        return { allowed: true, viable: false, code: 'UNSURVIVABLE', reason: `Tower damage ${metrics.enemyTowerDamage} overwhelms healing ${expectedHealing}`, metrics, utility };
    }
    return { allowed: true, viable: true, wait: false, code: 'APPROVED', reason: 'Explicit offensive directive passes diplomacy and viability policy', metrics, utility };
}

function applyAssessment(operation, assessment) {
    operation.offensiveAssessment = {
        tick: Game.time,
        allowed: assessment.allowed,
        viable: assessment.viable,
        wait: assessment.wait === true,
        code: assessment.code,
        reason: assessment.reason,
        metrics: assessment.metrics || null,
        utility: assessment.utility || null
    };
    operation.policyApproved = assessment.allowed && assessment.viable && !assessment.wait;
    operation.updatedTick = Game.time;
    if (assessment.utility) operation.utility = assessment.utility;
    if (HARD_FAILURES.has(assessment.code)) {
        Operations.abort(operation.id, assessment.reason);
    }
    else if (assessment.wait && operation.state === 'ACTIVE') {
        Operations.transition(operation, 'RECOVERING', assessment.reason);
    }
    else if (!assessment.wait && assessment.allowed && assessment.viable && operation.state === 'RECOVERING') {
        Operations.transition(operation, 'ACTIVE', assessment.reason);
    }
    return assessment;
}

function run() {
    const results = {};
    for (const operation of Object.values(HiveMemory.ensure().operations)) {
        if (!operation || !OFFENSIVE_TYPES.includes(operation.type) ||
            operation.state === 'COMPLETE' || operation.state === 'ABORTED') continue;
        results[operation.id] = applyAssessment(operation, evaluate(operation));
    }
    return results;
}

function createManual(type, options = {}) {
    if (!OFFENSIVE_TYPES.includes(type)) {
        return { ok: false, reason: `Expected one of ${OFFENSIVE_TYPES.join(', ')}` };
    }
    if (!options.targetRoom) return { ok: false, reason: 'A targetRoom is required' };
    if (options.targetOwner && CombatPolicy.isAlly(options.targetOwner)) {
        return { ok: false, reason: `${options.targetOwner} is configured as an ally` };
    }
    const objective = OBJECTIVES.includes(options.objective) ? options.objective :
        type === 'CONTEST_REACTOR' ? 'REACTOR_CONTEST' : 'HARASSMENT';
    const preferredSquadType = options.squadType === 'SIEGE_QUAD' ? 'SIEGE_QUAD' : 'RANGED_QUAD';
    const operation = Operations.create(type, {
        ...options,
        id: options.id || `manual:${type.toLowerCase()}:${options.targetRoom}`,
        state: 'PENDING',
        priority: Number.isFinite(options.priority) ? options.priority : 75,
        desiredCapabilities: options.desiredCapabilities || (preferredSquadType === 'SIEGE_QUAD' ?
            { melee: 240, dismantle: 0, healing: 144, damage: 240 } :
            { ranged: 100, healing: 144, damage: 100 }),
        debugReason: `Manual ${objective.toLowerCase().replace(/_/g, ' ')} directive`
    });
    operation.manualDirective = true;
    operation.objective = objective;
    operation.targetOwner = options.targetOwner || null;
    operation.targetValue = Number.isFinite(options.targetValue) ? options.targetValue : 50;
    operation.preferredSquadType = preferredSquadType;
    operation.requestedSquadSize = 4;
    operation.retreatRoom = options.retreatRoom || options.originRoom || null;
    operation.minimumSquadComposition = preferredSquadType === 'SIEGE_QUAD' ?
        { striker: 2, healer: 2 } : { ranged: 2, healer: 2 };
    operation.boostRequirements = options.boostRequirements || {};
    operation.policyApproved = false;
    return { ok: true, operation };
}

function setManualTarget(operationId, target) {
    const operation = Operations.get(operationId);
    if (!operation || !OFFENSIVE_TYPES.includes(operation.type)) return false;
    operation.targetId = typeof target === 'string' ? target : target && target.id || null;
    const pos = target && target.pos;
    if (pos) operation.targetPosition = { x: pos.x, y: pos.y, roomName: pos.roomName };
    operation.updatedTick = Game.time;
    operation.debugReason = 'Manual target directive updated';
    return true;
}

module.exports = {
    OFFENSIVE_TYPES,
    OBJECTIVES,
    evaluate,
    run,
    createManual,
    setManualTarget,
    roomSnapshot
};
