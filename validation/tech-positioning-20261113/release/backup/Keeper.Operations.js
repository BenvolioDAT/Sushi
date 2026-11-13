const HiveMemory = require('HiveMind.Memory');
const Intel = require('Keeper.Intel');
const Combat = require('Keeper.Combat');
const Policy = require('NPC.Policy');
const Index = require('HiveMind.Index');
const Remote = require('Planner.Remote');
const Economy = require('HiveMind.Economy');
const Board = require('Spawn.DemandBoard');
const RemoteIntel = require('Remote.Intel');
const MathCombat = require('Combat.Math');

const ACTIVE = new Set(['ASSEMBLE', 'CLEAR', 'GUARD', 'MINE', 'HAUL', 'SUSPENDED']);
function body() { return [...Array(20).fill(MOVE), ...Array(10).fill(RANGED_ATTACK), ...Array(10).fill(HEAL)]; }
function settings() { return HiveMemory.getConfig('combat').keepers; }
function setPhase(op, phase, reason) {
    if (op.phase !== phase) {
        if (['MINE', 'HAUL'].includes(op.phase) && !['MINE', 'HAUL'].includes(phase)) {
            op.commissioned = false; op.secureSince = null; op.haulingStarted = false;
        }
        op.phase = phase; op.phaseSince = Game.time;
    }
    op.reason = reason; op.updatedAt = Game.time;
}
function cancel(op) {
    for (const id of op.lairIds || []) Board.cancel(op.id + ':' + id);
}
function cooling(op, reason) {
    op.failures = (op.failures || 0) + 1;
    op.retryAt = Game.time + Math.min(24000, 1500 * Math.pow(2, op.failures - 1));
    op.funded = false; op.secureSince = null;
    setPhase(op, op.failures >= 3 ? 'ABANDONED' : 'COOLDOWN', reason); cancel(op);
}
function roster(op) {
    return Index.get().allCreeps.filter(c => c.memory && c.memory.keeperOperationId === op.id);
}
function recordLosses(op, creeps) {
    op.guards = op.guards || {};
    const living = new Map(creeps.map(c => [c.name, c.id]));
    let lost = false;
    for (const [name, old] of Object.entries(op.guards)) {
        if (living.get(name) !== old.id) {
            if (Number.isFinite(old.deathAt) && old.deathAt > Game.time + 5) lost = true;
            delete op.guards[name];
        }
    }
    for (const c of creeps) if (!c.spawning && Number.isFinite(c.ticksToLive)) op.guards[c.name] = {
        id: c.id, deathAt: Game.time + c.ticksToLive, lairId: c.memory.keeperLairId };
    return lost;
}
function homeCandidates(roomName) {
    return Index.get().ownedSpawnRooms.filter(home => home.name !== roomName &&
        Game.map.getRoomLinearDistance(home.name, roomName) <= HiveMemory.getConfig('remote').maxRoomRange)
        .sort((a, b) => (b.energyCapacityAvailable || 0) - (a.energyCapacityAvailable || 0) ||
            Game.map.getRoomLinearDistance(a.name, roomName) - Game.map.getRoomLinearDistance(b.name, roomName) || a.name.localeCompare(b.name));
}
function budget(op, home, estimate, creeps) {
    const economy = Economy.get(home.name);
    if (!economy || !['STABLE', 'SURPLUS'].includes(economy.state)) return 'HOME_ECONOMY_RECOVERING';
    if (!Economy.canSpend(home.name, 'combat') || !Economy.canSpend(home.name, 'remoteMaintenance')) return 'HOME_SPENDING_PAUSED';
    const growth = economy.growth || {}, currentRemote = growth.remote || {};
    if (!op.economyStarted && (currentRemote.requiredCarry || 0) > (currentRemote.availableCarry || 0)) return 'EXISTING_REMOTE_HAULING_SHORTFALL';
    const guards = (op.lairIds || []).filter(id => creeps.some(c => c.memory.keeperLairId === id &&
        (c.spawning || c.ticksToLive > 250 + 120 + (op.travelTicks || 0)))).length;
    const workers = Index.get().creepsByHomeRoom.get(home.name) || [];
    const miners = op.sourceIds.filter(id => workers.some(c => c.memory && c.memory.sourceId === id &&
        (c.spawning || c.ticksToLive > (op.travelTicks || 0) + 50))).length;
    const carry = workers.filter(c => c.memory && (c.memory.pickupRoom === op.roomName || c.memory.remoteDeliveryRoom === op.roomName))
        .reduce((sum, c) => sum + (MathCombat.analyzeBody(c).parts[CARRY] || 0), 0);
    const startup = Math.max(0, op.lairIds.length - guards) * 5000 + Math.max(0, op.sourceIds.length - miners) * 950 +
        Math.max(0, estimate.carry - carry) * 100;
    op.remainingSetupCost = startup;
    return (growth.energyAboveReserve || 0) >= startup ? null : 'INSUFFICIENT_OPERATION_RESERVE';
}
function advance(op, busyHomes) {
    op.updatedAt = Game.time; op.funded = false;
    const intel = Intel.get(op.roomName), homes = homeCandidates(op.roomName);
    const existingHome = homes.find(h => h.name === op.originRoom);
    const home = existingHome || homes[0];
    if (!home) { setPhase(op, 'DEFERRED', 'NO_HOME_IN_RANGE'); cancel(op); return; }
    op.originRoom = home.name;
    const signature = home.energyCapacityAvailable + ':' + home.controller.level;
    if (op.capabilitySignature !== signature) {
        op.capabilitySignature = signature; op.failures = 0; op.retryAt = 0;
        if (['COOLDOWN', 'ABANDONED'].includes(op.phase)) setPhase(op, 'ASSESS', 'CAPABILITY_CHANGED');
    }
    const creeps = roster(op);
    if (recordLosses(op, creeps)) { cooling(op, 'GUARD_DIED_EARLY'); return; }
    if (!Policy.enabled()) { setPhase(op, 'DEFERRED', 'DISABLED'); cancel(op); return; }
    if (op.phase === 'ABANDONED' || op.retryAt > Game.time) { cancel(op); return; }
    if (home.energyCapacityAvailable < 5000) { setPhase(op, 'DEFERRED', 'GUARD_BODY_UNAFFORDABLE'); cancel(op); return; }
    if (Object.values(Memory.rooms).some(m => m.npcCoreOperation && m.npcCoreOperation.originRoom === home.name &&
        ['ASSEMBLE', 'CLEAR'].includes(m.npcCoreOperation.phase))) {
        setPhase(op, 'DEFERRED', 'CORE_OPERATION_USING_COMBAT_BUDGET'); cancel(op); return;
    }
    if (busyHomes.has(home.name) && busyHomes.get(home.name) !== op.id) { setPhase(op, 'DEFERRED', 'ANOTHER_KEEPER_OPERATION'); cancel(op); return; }
    if (!intel || intel.observedAt !== Game.time || !Game.rooms[op.roomName]) {
        RemoteIntel.request(op.roomName, 'KEEPER_OPERATION_NEEDS_VISION', 85);
        setPhase(op, ACTIVE.has(op.phase) ? 'SUSPENDED' : 'ASSESS', 'NEEDS_VISION'); cancel(op); return;
    }
    if (intel.core || intel.otherHostiles) { setPhase(op, 'SUSPENDED', intel.core ? 'INVADER_CORE_PRESENT' : 'NON_KEEPER_THREAT'); cancel(op); return; }
    const unsupported = (Index.get().hostilesByRoom.get(op.roomName) || []).some(c => {
        const b = MathCombat.analyzeBody(c);
        return b.ranged > 100 || b.melee > 300 || b.heal > 0 || b.effectiveHits > 5000;
    });
    if (unsupported) { setPhase(op, 'DEFERRED', 'KEEPER_PROFILE_UNSUPPORTED'); cancel(op); return; }
    const economy = Economy.get(home.name);
    const homeThreat = HiveMemory.ensure().threats[home.name];
    if (homeThreat && homeThreat.dangerousHostileCount > 0) {
        setPhase(op, 'SUSPENDED', 'HOME_UNDER_ATTACK'); cancel(op); return;
    }
    if (!economy || !['STABLE', 'SURPLUS'].includes(economy.state)) {
        setPhase(op, 'SUSPENDED', 'HOME_ECONOMY_RECOVERING'); cancel(op); return;
    }
    if (!op.plan || Game.time - op.plan.at > 1500 || op.plan.at > Game.time) {
        if (op.lastPlanAttempt <= Game.time && Game.time - op.lastPlanAttempt < 75) return;
        op.lastPlanAttempt = Game.time;
        const plan = Remote.prepareKeeperOperation(home.name, op.roomName);
        if (!plan.ready) { setPhase(op, 'ASSESS', plan.reason); cancel(op); return; }
        op.plan = plan; op.sourceIds = plan.sourceIds; op.lairIds = plan.lairIds; op.travelTicks = plan.travelTicks;
    }
    const spawnCount = (Index.get().ownedSpawnsByRoom.get(home.name) || []).length;
    const ownQueued = (Memory.rooms[home.name].spawn?.queue || []).filter(q => q.memory?.keeperOperationId === op.id).length;
    const ownBusy = (Index.get().ownedSpawnsByRoom.get(home.name) || []).filter(s => s.spawning &&
        Memory.creeps[s.spawning.name]?.keeperOperationId === op.id).length;
    const pressure = Math.max(0, (economy.growth && economy.growth.spawnPressure || 0) -
        (ownQueued + ownBusy * 0.5) / Math.max(2, spawnCount * 4));
    const estimate = Combat.economics(op.roomName, { travelTicks: op.travelTicks, uptime: settings().expectedUptime,
        minerTravelTicks: op.plan.minerTravelTicks, roundTripTicks: op.plan.haulRoundTripTicks,
        infrastructureCost: op.plan.infrastructureCost, energyCapacity: home.energyCapacityAvailable,
        spawnBudget: Math.max(0, spawnCount * settings().spawnShare - pressure) });
    op.economics = estimate;
    if (!estimate.viable || estimate.net <= (op.plan.displacedNet || 0) + 2) {
        setPhase(op, 'DEFERRED', estimate.viable ? 'KEEPER_PORTFOLIO_NO_GAIN' : estimate.reason); cancel(op); return;
    }
    const blocked = budget(op, home, estimate, creeps);
    if (blocked) { setPhase(op, ACTIVE.has(op.phase) ? 'SUSPENDED' : 'DEFERRED', blocked); cancel(op); return; }
    op.funded = true; busyHomes.set(home.name, op.id);
    const assembled = op.lairIds.every(id => creeps.some(c => c.memory.keeperLairId === id && c.memory.keeperPatrolState !== 'RETREAT' && Policy.guardCapable(c)));
    if (!assembled) {
        if (!Number.isFinite(op.assemblyStartedAt) || op.assemblyStartedAt > Game.time ||
            !['ASSEMBLE', 'SUSPENDED'].includes(op.phase)) op.assemblyStartedAt = Game.time;
        setPhase(op, 'ASSEMBLE', 'ASSEMBLING_FULL_FORCE');
        if (Game.time - (op.assemblyStartedAt || Game.time) > 1000) { cooling(op, 'ASSEMBLY_TIMED_OUT'); return; }
    } else if (!Policy.coverage(op.roomName, home.name)) { setPhase(op, 'CLEAR', 'FORCE_DEPLOYING'); op.secureSince = null; }
    else {
        const active = op.lairIds.some(id => intel.lairs[id] && intel.lairs[id].keeperIds.length > 0);
        if (!op.commissioned) {
            if (active) { setPhase(op, 'CLEAR', 'CLEARING_KEEPERS'); op.secureSince = null; }
            else {
                if (!Number.isFinite(op.secureSince)) op.secureSince = Game.time;
                setPhase(op, Game.time - op.secureSince >= settings().secureTicks ? 'MINE' : 'GUARD', 'VERIFYING_GUARD_COVERAGE');
                if (op.phase === 'MINE') { op.commissioned = true; op.economyStarted = true; }
            }
        } else {
            const minersReady = op.sourceIds.every(id => Index.get().allCreeps.some(c => c.memory && c.memory.role === 'Extractor' &&
                c.memory.sourceId === id && !c.spawning && c.room.name === op.roomName &&
                MathCombat.rangeBetween(c, intel.resources[id].pos) <= 1 && MathCombat.analyzeBody(c).parts[WORK] >= 7));
            if (minersReady) op.haulingStarted = true;
            setPhase(op, op.haulingStarted ? 'HAUL' : 'MINE', op.haulingStarted ? 'GUARDED_MINING_AND_HAULING' : 'SETTING_UP_MINERS');
        }
    }
    if (op.phase === 'CLEAR') {
        const hitTotal = intel.keepers.filter(k => op.lairIds.some(id => intel.lairs[id]?.keeperIds.includes(k.id)))
            .reduce((sum, k) => sum + k.hits, 0);
        const distanceTotal = op.lairIds.reduce((sum, id) => {
            const lair = intel.lairs[id], resource = intel.resources[lair.resourceIds[0]];
            const nearest = Math.min(50, ...creeps.filter(c => c.memory.keeperLairId === id)
                .map(c => MathCombat.rangeBetween(c, resource.pos)));
            return sum + nearest;
        }, 0);
        const metric = hitTotal + distanceTotal * 100;
        if (!op.progress || op.progress.tick > Game.time || metric < op.progress.metric)
            op.progress = { metric, tick: Game.time };
        if (Game.time - op.progress.tick > Math.max(150, op.travelTicks * 2 + 100)) {
            cooling(op, 'KEEPER_CLEAR_STALLED'); return;
        }
    } else delete op.progress;
    for (const lairId of op.lairIds) Board.emit({ id: op.id + ':' + lairId, role: 'Volley', count: 1,
        originRoom: home.name, preferredSpawnRoom: home.name, targetRoom: op.roomName,
        bodyRequirements: { fixed: true, body: body() }, priority: 55, economyCategory: 'combat',
        replacementBuffer: 250 + op.travelTicks + 20, validUntil: Game.time + 5, producer: 'keeperOperations',
        memory: { role: 'Volley', homeRoom: home.name, targetRoom: op.roomName, keeperPatrolRoom: op.roomName,
            keeperOperationId: op.id, keeperLairId: lairId }, reason: 'Staged Keeper protection' });
}
function run() {
    const rooms = Object.keys(Memory.rooms || {}).filter(name => Intel.known(name));
    const busy = new Map();
    rooms.sort((a, b) => Number(ACTIVE.has(Policy.keeper(b)?.phase)) - Number(ACTIVE.has(Policy.keeper(a)?.phase)) || a.localeCompare(b));
    for (const name of rooms) {
        const memory = Memory.rooms[name];
        const op = memory.keeperOperation || (memory.keeperOperation = { id: 'keeper:' + name, roomName: name,
            phase: 'DISCOVERED', phaseSince: Game.time, sourceIds: [], lairIds: [], createdAt: Game.time });
        advance(op, busy);
    }
}

module.exports = { run, advance, body, roster };
