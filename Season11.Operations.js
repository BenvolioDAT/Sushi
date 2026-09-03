const HiveMemory = require('HiveMind.Memory');
const Operations = require('HiveMind.Operations');
const Utility = require('HiveMind.Utility');
const TickIndex = require('HiveMind.Index');
const CombatPolicy = require('Combat.Policy');
const SquadController = require('Squad.Controller');
const Season11 = require('Logic.Season11');

const STATES = Object.freeze([
    'DISCOVERING', 'SELECTING', 'MUSTERING', 'CLAIMING', 'HARVESTING',
    'HAULING', 'SUPPLYING', 'HOLDING', 'CONTESTING', 'RECOVERING',
    'DEPLETED', 'COMPLETE', 'ABORTED'
]);
const TERMINAL = new Set(['COMPLETE', 'ABORTED']);
const INACTIVE = new Set(['DEPLETED', 'COMPLETE', 'ABORTED']);
const TRANSITIONS = {
    DISCOVERING: new Set(['SELECTING', 'MUSTERING', 'RECOVERING', 'ABORTED']),
    SELECTING: new Set(['DISCOVERING', 'MUSTERING', 'HARVESTING', 'RECOVERING', 'ABORTED']),
    MUSTERING: new Set(['CLAIMING', 'HARVESTING', 'HAULING', 'CONTESTING', 'RECOVERING', 'ABORTED']),
    CLAIMING: new Set(['SUPPLYING', 'HOLDING', 'CONTESTING', 'RECOVERING', 'ABORTED']),
    HARVESTING: new Set(['HAULING', 'SUPPLYING', 'DEPLETED', 'RECOVERING', 'ABORTED']),
    HAULING: new Set(['HARVESTING', 'SUPPLYING', 'HOLDING', 'DEPLETED', 'RECOVERING', 'ABORTED']),
    SUPPLYING: new Set(['HAULING', 'HOLDING', 'CONTESTING', 'DEPLETED', 'RECOVERING', 'ABORTED']),
    HOLDING: new Set(['SUPPLYING', 'CONTESTING', 'RECOVERING', 'DEPLETED', 'COMPLETE', 'ABORTED']),
    CONTESTING: new Set(['MUSTERING', 'CLAIMING', 'SUPPLYING', 'HOLDING', 'RECOVERING', 'ABORTED']),
    RECOVERING: new Set([
        'DISCOVERING', 'SELECTING', 'MUSTERING', 'CLAIMING', 'HARVESTING',
        'HAULING', 'SUPPLYING', 'HOLDING', 'CONTESTING', 'DEPLETED',
        'COMPLETE', 'ABORTED'
    ]),
    DEPLETED: new Set(['HARVESTING', 'HAULING', 'RECOVERING', 'COMPLETE', 'ABORTED'])
};
const DELIVERY_WINDOW = 100;
const MAX_DELIVERY_EVENTS = 100;
const SCORE_INTERVAL = 17;

function now() {
    return typeof Game !== 'undefined' && Number.isFinite(Game.time) ? Game.time : 0;
}

function cpuUsed() {
    return typeof Game !== 'undefined' && Game.cpu && typeof Game.cpu.getUsed === 'function' ?
        Game.cpu.getUsed() : 0;
}

function ensureSeasonMemory() {
    const season = HiveMemory.ensure().season;
    if (!Array.isArray(season.activeOperationIds)) season.activeOperationIds = [];
    if (!Array.isArray(season.deliveryEvents)) season.deliveryEvents = [];
    if (!season.stats || typeof season.stats !== 'object') season.stats = {};
    if (!season.dashboard || typeof season.dashboard !== 'object') season.dashboard = {};
    return season;
}

function setIfChanged(target, key, value) {
    if (target[key] !== value) target[key] = value;
}

function transition(operationOrId, nextState, reason, guard = () => true) {
    const operation = typeof operationOrId === 'string' ?
        HiveMemory.ensure().operations[operationOrId] : operationOrId;
    if (!operation || TERMINAL.has(operation.state) || !STATES.includes(nextState) || !guard(operation)) {
        return false;
    }
    if (operation.state === nextState) {
        if (reason && operation.debugReason !== reason) operation.debugReason = reason;
        return true;
    }
    const allowed = TRANSITIONS[operation.state];
    if (!allowed || !allowed.has(nextState)) return false;
    operation.state = nextState;
    operation.stateStartTick = now();
    operation.updatedTick = now();
    operation.debugReason = reason || `Season 11 transition to ${nextState}`;
    if (nextState === 'COMPLETE') operation.completedTick = now();
    if (nextState === 'ABORTED') operation.abortedTick = now();
    return true;
}

function createOrUpdate(type, options) {
    const hive = HiveMemory.ensure();
    let operation = hive.operations[options.id];
    if (!operation || TERMINAL.has(operation.state)) {
        operation = Operations.create(type, options);
    }
    operation.season11 = true;
    setIfChanged(operation, 'type', type);
    setIfChanged(operation, 'originRoom', options.originRoom || null);
    setIfChanged(operation, 'respondingColony', options.originRoom || null);
    setIfChanged(operation, 'targetRoom', options.targetRoom || null);
    setIfChanged(operation, 'targetId', options.targetId || null);
    setIfChanged(operation, 'priority', options.priority);
    if (options.targetPosition) operation.targetPosition = options.targetPosition;
    if (options.desiredCapabilities) operation.desiredCapabilities = options.desiredCapabilities;
    if (options.spawnDemands) operation.spawnDemands = options.spawnDemands;
    if (operation.state !== options.state) {
        if (!transition(operation, options.state, options.debugReason, options.guard)) {
            transition(operation, 'RECOVERING', `Invalidated before ${options.state}`);
        }
    }
    else if (options.debugReason && operation.debugReason !== options.debugReason) {
        operation.debugReason = options.debugReason;
    }
    return operation;
}

function normalizeDistance(distance, scale = 5) {
    return Utility.normalize(Number.isFinite(distance) ? distance * scale : 100);
}

function agingMetrics(routeDistance, tileThorium) {
    const routeTiles = Math.max(0, Number(routeDistance) || 0) * 50;
    const estimate = Number.isFinite(tileThorium) ? {
        total: Math.max(0, Math.floor(tileThorium)),
        multiplier: Season11.thoriumAgingMultiplier(tileThorium),
        observable: true,
        source: 'providedTileTotal'
    } : Season11.observeTileThorium(null);
    const agingMultiplier = estimate.multiplier;
    const agingFactor = Math.max(1, agingMultiplier);
    const effectiveLifetime = Math.max(1, Math.floor(1500 / agingFactor));
    const estimatedLoadedLifeUsed = Math.min(effectiveLifetime, routeTiles) * agingFactor;
    const agingLoss = Utility.normalize(estimatedLoadedLifeUsed / 15);
    return {
        routeTiles,
        agingMultiplier,
        agingThorium: estimate.total,
        agingEstimateSource: estimate.source,
        effectiveLifetime,
        estimatedLoadedLifeUsed,
        agingLoss,
        estimatedAgingLoss: agingLoss
    };
}

function utilityFor(context = {}) {
    const remaining = Math.max(0, Number(context.remaining) || 0);
    const buffer = Math.max(0, Number(context.buffer) || 0);
    const continuousWork = Math.max(0, Number(context.continuousWork) || 0);
    const scoreRate = Season11.scoreRate(continuousWork);
    const distance = Number.isFinite(context.routeDistance) ? context.routeDistance : null;
    const aging = agingMetrics(distance, context.tileThorium);
    const threat = Math.max(0, Number(context.threatParts) || 0);
    const maintenance = Utility.normalize((distance || 0) * 3 + aging.agingLoss * 0.25);
    const continuity = Utility.normalize(scoreRate * 18 + Math.log10(continuousWork + 1) * 12);
    const starvation = context.starving ? 100 : Utility.normalize(100 - Math.min(100, buffer / 5));
    const components = {
        urgency: context.kind === 'reactor' ? starvation : context.depleted ? 0 : 25,
        expectedValue: Utility.normalize(Math.log10(remaining + buffer + 1) * 22),
        strategicValue: context.currentReactor ? Math.max(continuity, 30) :
            Utility.normalize(20 + (context.northernBias || 0)),
        energyCost: Utility.normalize((distance || 0) * 1.5),
        spawnCost: Utility.normalize(10 + aging.agingLoss * 0.35),
        travelTime: normalizeDistance(distance),
        risk: Utility.normalize(threat * 6 + (context.contested ? 30 : 0)),
        opportunityCost: context.currentReactor ? 0 : Utility.normalize(continuity * 0.75)
    };
    return {
        score: Utility.score(components),
        metrics: {
            finiteSupply: remaining,
            routeDistance: distance,
            routeTiles: aging.routeTiles,
            agingMultiplier: aging.agingMultiplier,
            agingThorium: aging.agingThorium,
            agingEstimateSource: aging.agingEstimateSource,
            effectiveLoadedLifetime: aging.effectiveLifetime,
            estimatedAgingLoss: aging.agingLoss,
            routeMaintenanceCost: maintenance,
            reactorBuffer: buffer,
            ticksUntilInterruption: buffer,
            continuousWork,
            scoreRate,
            continuityValue: continuity,
            projectedScoreValue: Math.round((remaining + buffer) * Math.max(1, scoreRate)),
            expectedNetValue: 0
        }
    };
}

function applyUtility(operation, calculation) {
    const last = operation.seasonMetrics || {};
    const materiallyChanged = Math.abs((last.finiteSupply || 0) - calculation.metrics.finiteSupply) >= 25 ||
        last.scoreRate !== calculation.metrics.scoreRate || last.reactorBuffer !== calculation.metrics.reactorBuffer;
    if (!operation.lastScoredTick || now() - operation.lastScoredTick >= SCORE_INTERVAL || materiallyChanged) {
        calculation.metrics.expectedNetValue = calculation.score.total;
        operation.utility = calculation.score;
        operation.seasonMetrics = calculation.metrics;
        operation.lastScoredTick = now();
        operation.updatedTick = now();
    }
}

function deliveryThroughput(window = DELIVERY_WINDOW) {
    const events = ensureSeasonMemory().deliveryEvents;
    const start = now() - Math.max(1, window) + 1;
    let amount = 0;
    let deliveries = 0;
    for (const event of events) {
        if (event && event.tick >= start) {
            amount += Math.max(0, Number(event.amount) || 0);
            deliveries++;
        }
    }
    return {
        window,
        amount,
        deliveries,
        perTick: Math.round((amount / Math.max(1, window)) * 1000) / 1000
    };
}

function noteDelivery(amount, details = {}) {
    const delivered = Math.max(0, Math.floor(Number(amount) || 0));
    if (!delivered) return false;
    const season = ensureSeasonMemory();
    season.deliveryEvents.push({
        tick: now(),
        amount: delivered,
        creepName: details.creepName || null,
        sourceRoom: details.sourceRoom || null,
        reactorId: details.reactorId || null,
        reactorRoom: details.reactorRoom || null
    });
    if (season.deliveryEvents.length > MAX_DELIVERY_EVENTS) {
        season.deliveryEvents.splice(0, season.deliveryEvents.length - MAX_DELIVERY_EVENTS);
    }
    return true;
}

function matchingReactorRank(memory, reactor) {
    return (memory.assignments.rankedReactors || []).find(item => item && item.id === reactor.id) || {};
}

function assignCreeps(operation) {
    const index = TickIndex.get();
    const direct = index.creepsByOperationId.get(operation.id) || [];
    const assignmentKey = operation.id.startsWith('season11:') ? operation.id.slice(9) : null;
    const legacy = assignmentKey ? index.allCreeps.filter(creep =>
        creep && creep.memory && creep.memory.season11AssignmentKey === assignmentKey) : [];
    operation.assignedCreeps = Array.from(new Set(direct.concat(legacy)
        .map(creep => creep && creep.name).filter(Boolean))).sort();
}

function syncMiningOperations(memory, diagnostics, activeIds) {
    for (const assignment of Object.values(memory.assignments.mining || {})) {
        if (!assignment || !assignment.key || !assignment.roomName) continue;
        const id = `season11:${assignment.key}`;
        const staging = assignment.stagingId && typeof Game.getObjectById === 'function' ?
            Game.getObjectById(assignment.stagingId) : null;
        const stored = Season11.getStoreAmount(staging, Season11.getThoriumResourceType());
        const depleted = assignment.depleted === true || assignment.remaining <= 0;
        const state = depleted ? (stored > 0 ? 'HAULING' : 'DEPLETED') :
            assignment.ready ? 'HARVESTING' : 'RECOVERING';
        const reason = depleted ? (stored > 0 ? 'Draining finite Thorium staging reserve' : 'Finite deposit exhausted') :
            assignment.ready ? 'Extractor and staging route are ready' : `Mining prerequisite missing: ${assignment.reason || 'unknown'}`;
        const calculation = utilityFor({
            kind: 'deposit',
            remaining: assignment.remaining,
            buffer: stored,
            routeDistance: assignment.routeDistance,
            threatParts: memory.rooms[assignment.roomName] && memory.rooms[assignment.roomName].threatParts,
            depleted
        });
        const maintenanceNeeded = calculation.metrics.routeMaintenanceCost >= 60;
        const operation = createOrUpdate('HARVEST_THORIUM', {
            id,
            state,
            priority: state === 'HAULING' ? 65 : 40,
            originRoom: assignment.homeRoom,
            targetRoom: assignment.roomName,
            targetId: assignment.mineralId,
            targetPosition: Number.isFinite(memory.rooms[assignment.roomName] && memory.rooms[assignment.roomName].thorium && memory.rooms[assignment.roomName].thorium.x) ? {
                x: memory.rooms[assignment.roomName].thorium.x,
                y: memory.rooms[assignment.roomName].thorium.y,
                roomName: assignment.roomName
            } : null,
            desiredCapabilities: {
                harvest: depleted ? 0 : 1,
                hauling: stored > 0 || !depleted ? 1 : 0,
                maintenance: maintenanceNeeded ? 1 : 0
            },
            spawnDemands: maintenanceNeeded && assignment.homeRoom === assignment.roomName ? [{
                id: `${id}:maintenance`,
                role: 'Artificer',
                count: 1,
                priority: 32,
                targetRoom: assignment.roomName,
                memory: { season11SupportRoom: assignment.roomName },
                reason: 'Season 11 road/container maintenance estimate'
            }] : [],
            debugReason: reason
        });
        applyUtility(operation, calculation);
        assignCreeps(operation);
        activeIds.add(id);
        const roomIntel = memory.rooms[assignment.roomName];
        if (roomIntel && roomIntel.thorium) roomIntel.thorium.operationMetrics = operation.seasonMetrics;

        const reactor = diagnostics.selectedReactor;
        if (!reactor || !assignment.stagingId) continue;
        const haulId = `season11:haul:${assignment.roomName}:${reactor.id}`;
        const lost = !reactor.my && !!reactor.owner;
        const canContest = lost && memory.config.recapture === true && CombatPolicy.mayLaunchOffense({ owner: { username: reactor.owner } }, true);
        const haulState = lost ? (canContest ? 'CONTESTING' : 'RECOVERING') :
            depleted && stored <= 0 ? 'DEPLETED' :
                reactor.thorium <= memory.config.starvationWarningTicks ? 'SUPPLYING' : 'HAULING';
        const haulCalculation = utilityFor({
            kind: 'reactor',
            remaining: assignment.remaining,
            buffer: reactor.thorium,
            routeDistance: Season11.getRouteDistance(assignment.roomName, reactor.roomName),
            threatParts: reactor.threatParts,
            continuousWork: reactor.continuousWork,
            currentReactor: reactor.my,
            starving: reactor.thorium <= memory.config.starvationWarningTicks,
            contested: lost,
            depleted
        });
        const haulOperation = createOrUpdate('SUPPLY_REACTOR', {
            id: haulId,
            state: haulState,
            priority: haulState === 'SUPPLYING' ? 82 : haulState === 'CONTESTING' ? 90 : 55,
            originRoom: assignment.homeRoom,
            targetRoom: reactor.roomName,
            targetId: reactor.id,
            desiredCapabilities: { hauling: haulState === 'RECOVERING' || haulState === 'DEPLETED' ? 0 : 1 },
            spawnDemands: [],
            debugReason: lost ? (canContest ? 'Reactor ownership lost; manual recapture policy permits contest' : 'Reactor ownership lost; preserve Thorium') :
                haulState === 'SUPPLYING' ? 'Projected fuel interruption raises delivery urgency' : 'Maintain Reactor supply route'
        });
        applyUtility(haulOperation, haulCalculation);
        assignCreeps(haulOperation);
        activeIds.add(haulId);
    }
}

function reactorState(memory, diagnostics) {
    const reactor = diagnostics.selectedReactor;
    if (!reactor) return Object.keys(memory.reactors || {}).length ? 'SELECTING' : 'DISCOVERING';
    const depleted = diagnostics.knownThoriumRemaining <= 0 && diagnostics.deliverableReserve <= 0 && reactor.thorium <= 0;
    if (depleted) return 'DEPLETED';
    if (reactor.my) {
        return reactor.thorium <= Math.max(memory.config.starvationWarningTicks, memory.config.reactorSafetyStock) ?
            'SUPPLYING' : 'HOLDING';
    }
    if (reactor.owner) {
        return memory.config.recapture === true && CombatPolicy.mayLaunchOffense({ owner: { username: reactor.owner } }, true) ?
            'CONTESTING' : 'RECOVERING';
    }
    return diagnostics.deliverableReserve >= memory.config.startupReserve ? 'CLAIMING' : 'MUSTERING';
}

function syncReactorOperation(memory, diagnostics, activeIds) {
    const reactor = diagnostics.selectedReactor;
    const state = reactorState(memory, diagnostics);
    const id = reactor ? `season11:reactor:${reactor.id}` : 'season11:discover';
    const rank = reactor ? matchingReactorRank(memory, reactor) : {};
    const ownerSubject = reactor && reactor.owner ? { owner: { username: reactor.owner } } : null;
    const contested = state === 'CONTESTING';
    const operation = createOrUpdate(reactor ?
        (contested ? 'CONTEST_REACTOR' : reactor.my ? 'HOLD_REACTOR' : 'CAPTURE_REACTOR') : 'SCOUT_INTEL', {
        id,
        state,
        priority: state === 'CONTESTING' ? 96 : state === 'SUPPLYING' ? 88 : state === 'HOLDING' ? 72 : 45,
        originRoom: rank.homeRoom || null,
        targetRoom: reactor && reactor.roomName || null,
        targetId: reactor && reactor.id || null,
        desiredCapabilities: {
            scout: reactor ? 0 : 1,
            claim: ['CLAIMING', 'CONTESTING'].includes(state) ? 1 : 0,
            guardDamage: reactor && (reactor.threatParts > 0 || contested) ? Math.max(1, reactor.threatParts || 1) : 0,
            guardHealing: reactor && (reactor.threatParts > 0 || contested) ? Math.max(1, Math.ceil((reactor.threatParts || 1) / 2)) : 0
        },
        spawnDemands: !reactor && diagnostics.operating ? [{
            id: 'season11:discover:scout',
            role: 'Scout',
            count: 1,
            priority: 28,
            validUntil: now() + 25,
            memory: { season11Scout: true },
            reason: 'Discover Thorium deposits and Reactors'
        }] : [],
        debugReason: state === 'DISCOVERING' ? 'No Reactor intel; continue bounded observer/scout discovery' :
            state === 'SELECTING' ? 'Known Reactors exist but none is currently selected' :
                state === 'MUSTERING' ? 'Accumulate startup Thorium reserve before claiming' :
                    state === 'CLAIMING' ? 'Reserve and route prerequisites permit an unowned Reactor claim' :
                        state === 'SUPPLYING' ? 'Protect continuous score growth from fuel interruption' :
                            state === 'HOLDING' ? 'Owned Reactor buffer is stable' :
                                state === 'CONTESTING' ? 'Ownership loss is actionable under explicit recapture policy' :
                                    state === 'DEPLETED' ? 'Known finite Thorium and deliverable reserve exhausted' :
                                        ownerSubject && CombatPolicy.isAlly(ownerSubject) ? 'Ally owns Reactor; contest prohibited' :
                                            'Reactor unavailable; preserve logistics and await policy/intel change'
    });
    applyUtility(operation, utilityFor({
        kind: 'reactor',
        remaining: diagnostics.knownThoriumRemaining,
        buffer: reactor && reactor.thorium || 0,
        routeDistance: rank.routeDistance,
        threatParts: reactor && reactor.threatParts || 0,
        continuousWork: reactor && reactor.continuousWork || 0,
        currentReactor: reactor && reactor.my,
        starving: state === 'SUPPLYING',
        contested
    }));
    assignCreeps(operation);
    activeIds.add(id);

    const heavyContest = reactor && (reactor.threatParts || 0) >= 20;
    operation.manualDirective = contested && memory.config.recapture === true;
    operation.targetOwner = reactor && reactor.owner || null;
    operation.preferredSquadType = heavyContest ? 'RANGED_QUAD' : null;
    operation.requestedSquadSize = heavyContest ? 4 : 2;

    if (!heavyContest && reactor && (contested || reactor.my && (reactor.threatParts > 0 || reactor.hostileCreeps > 0)) && rank.homeRoom) {
        SquadController.createDuo({
            id: `duo:${id}`,
            operationId: id,
            originRoom: rank.homeRoom,
            targetRoom: reactor.roomName,
            expectedTravelTime: Number.isFinite(rank.routeDistance) ? rank.routeDistance * 50 : 100,
            debugReason: contested ? 'Explicit Reactor recapture escort' : 'Reactor logistics defense'
        });
    }
}

function retireMissing(activeIds) {
    for (const operation of Object.values(HiveMemory.ensure().operations)) {
        if (!operation || !operation.season11 || activeIds.has(operation.id) || TERMINAL.has(operation.state)) continue;
        if (operation.state === 'DEPLETED') transition(operation, 'COMPLETE', 'Season 11 finite-source record retired');
        else transition(operation, 'RECOVERING', 'Season assignment disappeared; awaiting fresh planning');
        if (operation.state === 'RECOVERING' && now() - (operation.stateStartTick || 0) > 250) {
            transition(operation, 'COMPLETE', 'Season assignment remained invalid for 250 ticks');
        }
        operation.spawnDemands = [];
    }
}

function updateDashboard(activeIds, diagnostics, elapsed) {
    const season = ensureSeasonMemory();
    const active = Array.from(activeIds).map(id => HiveMemory.ensure().operations[id]).filter(Boolean);
    const throughput = deliveryThroughput();
    const reactorOperation = active.find(operation => operation.id.startsWith('season11:reactor:')) ||
        active.find(operation => operation.id === 'season11:discover') || null;
    const harvest = active.filter(operation => operation.type === 'HARVEST_THORIUM' && !INACTIVE.has(operation.state)).length;
    const haul = active.filter(operation => operation.type === 'SUPPLY_REACTOR' && !INACTIVE.has(operation.state)).length;
    const contest = active.filter(operation => operation.state === 'CONTESTING').length;
    const dashboard = {
        tick: now(),
        activeOperations: active.filter(operation => !INACTIVE.has(operation.state)).length,
        reactorOperationId: reactorOperation && reactorOperation.id || null,
        reactorState: reactorOperation && reactorOperation.state || 'INERT',
        harvestOperations: harvest,
        haulOperations: haul,
        throughput,
        contestThreat: contest + (diagnostics.selectedReactor && diagnostics.selectedReactor.threatParts || 0),
        operationCpu: Math.round(elapsed * 1000) / 1000
    };
    season.dashboard = dashboard;
    const sortedIds = Array.from(activeIds).sort();
    if (JSON.stringify(season.activeOperationIds) !== JSON.stringify(sortedIds)) season.activeOperationIds = sortedIds;
    return dashboard;
}

function recordCpu(elapsed) {
    const previous = global.__sushiSeason11Ops || { samples: 0, averageCpu: 0, lastCpu: 0 };
    previous.samples++;
    previous.lastCpu = elapsed;
    previous.averageCpu += (elapsed - previous.averageCpu) / Math.min(previous.samples, 100);
    previous.tick = now();
    global.__sushiSeason11Ops = previous;
    const season = ensureSeasonMemory();
    if (season.stats.operationCpu === undefined || now() % 100 === 0) {
        season.stats.operationCpu = {
            tick: now(),
            last: Math.round(previous.lastCpu * 1000) / 1000,
            average: Math.round(previous.averageCpu * 1000) / 1000
        };
    }
}

function run(diagnostics) {
    const started = cpuUsed();
    const memory = Season11.ensureMemory();
    const snapshot = diagnostics || Season11.getDiagnostics();
    if (!Season11.isApiAvailable() || !snapshot.operating) {
        return { enabled: false, reason: 'Season API unavailable or operation mode inactive' };
    }
    ensureSeasonMemory();
    const activeIds = new Set();
    syncMiningOperations(memory, snapshot, activeIds);
    syncReactorOperation(memory, snapshot, activeIds);
    retireMissing(activeIds);
    const elapsed = Math.max(0, cpuUsed() - started);
    recordCpu(elapsed);
    return updateDashboard(activeIds, snapshot, elapsed);
}

function getDashboard() {
    const season = ensureSeasonMemory();
    const heap = global.__sushiSeason11Ops;
    return {
        ...(season.dashboard || {}),
        operationCpu: heap ? Math.round(heap.lastCpu * 1000) / 1000 : season.dashboard.operationCpu || 0,
        averageOperationCpu: heap ? Math.round(heap.averageCpu * 1000) / 1000 :
            season.stats.operationCpu && season.stats.operationCpu.average || 0
    };
}

function resetForTests() {
    delete global.__sushiSeason11Ops;
}

module.exports = {
    STATES,
    TRANSITIONS,
    ensureSeasonMemory,
    transition,
    utilityFor,
    agingMetrics,
    deliveryThroughput,
    noteDelivery,
    run,
    getDashboard,
    resetForTests
};
