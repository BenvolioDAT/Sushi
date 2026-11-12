// Ordinary invaders retain ThreatLedger defense. This owner clears only a live,
// unopposed level-zero NPC core; strongholds and player targets are rejected.
const Hive = require('HiveMind.Memory');
const Index = require('HiveMind.Index');
const MathCombat = require('Combat.Math');
const Economy = require('HiveMind.Economy');
const Board = require('Spawn.DemandBoard');
const RemoteIntel = require('Remote.Intel');
const travel = require('utility.Travel.Creep');
const CombatPolicy = require('Combat.Policy');
const Remote = require('Planner.Remote');

function body() { return [...Array(6).fill(MOVE), ...Array(6).fill(ATTACK)]; }
function observe(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return { safe: false, reason: 'NEEDS_VISION' };
    const byType = Index.get().structuresByRoom.get(roomName);
    const structures = byType ? Array.from(byType.values()).flat() : [];
    const core = structures.find(s => s.structureType === 'invaderCore' && s.owner && s.owner.username === 'Invader');
    if (!core) return { safe: true, complete: true };
    if (core.level !== 0) return { safe: false, reason: 'STRONGHOLD_REQUIRES_SIEGE', core };
    const invulnerable = (core.effects || []).some(effect => effect.ticksRemaining > 0 &&
        typeof EFFECT_INVULNERABILITY !== 'undefined' && effect.effect === EFFECT_INVULNERABILITY);
    if (core.ticksToDeploy > 0 || invulnerable) return { safe: false, reason: 'CORE_INVULNERABLE', core };
    const hostiles = Index.get().hostilesByRoom.get(roomName) || [];
    if (hostiles.some(c => {
        const b = MathCombat.analyzeBody(c);
        return !c.owner || c.owner.username !== 'Invader' || b.melee > 0 || b.ranged > 0 || b.heal > 0 || b.dismantle > 0;
    }))
        return { safe: false, reason: 'CORE_DEFENDED', core };
    if (room.controller && room.controller.owner || structures.some(s =>
        (s.structureType === 'tower' || s.structureType === 'rampart' || s.structureType === 'constructedWall') && s.my !== true))
        return { safe: false, reason: 'CORE_DEFENDED', core };
    return { safe: true, core };
}
function phase(op, next, reason) {
    // Lost vision/funding is a safe pause, not time spent attacking unsuccessfully.
    if (next !== 'CLEAR') delete op.progress;
    if (op.phase !== next) { op.phase = next; op.phaseSince = Game.time; }
    op.reason = reason; op.updatedAt = Game.time;
}
function cancel(op) { Board.cancel(op.id); }
function run() {
    const settings = Hive.getConfig('combat').npcCores;
    const busy = new Set();
    for (const [roomName, memory] of Object.entries(Memory.rooms || {})) {
        if (!memory.invaderCore && !memory.npcCoreOperation) continue;
        const known = memory.invaderCore;
        const op = memory.npcCoreOperation || (memory.npcCoreOperation = {
            id: 'npcCore:' + roomName, roomName, phase: 'DISCOVERED', createdAt: Game.time });
        if (!known && op.phase === 'COMPLETE') continue;
        op.updatedAt = Game.time; op.funded = false;
        if (settings.enabled === false || Hive.getConfig('combat').diplomacy.npcAutoDefense === false) {
            phase(op, 'DEFERRED', 'NPC_AUTOMATION_DISABLED'); cancel(op); continue;
        }
        if (known && known.level !== 0) { phase(op, 'DEFERRED', 'STRONGHOLD_REQUIRES_SIEGE'); cancel(op); continue; }
        const snapshot = observe(roomName);
        if (!snapshot.safe) {
            if (snapshot.reason === 'NEEDS_VISION') RemoteIntel.request(roomName, 'NPC_CORE_NEEDS_VISION', 80);
            phase(op, 'DEFERRED', snapshot.reason); cancel(op); continue;
        }
        if (snapshot.complete) { phase(op, 'COMPLETE', 'CORE_GONE_CONFIRMED'); cancel(op); continue; }
        if (op.targetId && op.targetId !== snapshot.core.id) { op.failures = 0; op.retryAt = 0; op.fighter = null; }
        op.targetId = snapshot.core.id;
        const homes = Index.get().ownedSpawnRooms.filter(home => home.name !== roomName &&
            Game.map.getRoomLinearDistance(home.name, roomName) <= Hive.getConfig('remote').maxRoomRange)
            .sort((a,b) => Game.map.getRoomLinearDistance(a.name, roomName) - Game.map.getRoomLinearDistance(b.name, roomName) || a.name.localeCompare(b.name));
        const home = homes.find(h => h.name === op.originRoom) || homes[0];
        if (!home) { phase(op, 'DEFERRED', 'NO_HOME_IN_RANGE'); cancel(op); continue; }
        op.originRoom = home.name;
        const fighters = Index.get().allCreeps.filter(c => c.memory && c.memory.npcCoreOperationId === op.id);
        const fighter = fighters[0];
        // A clearance is finite: expiring without completion is also a failed
        // attempt. Otherwise repeated safe pauses could finance endless bodies.
        if (op.fighter && !fighters.some(c => c.id === op.fighter.id)) {
            op.failures = (op.failures || 0) + 1;
            op.retryAt = Game.time + Math.min(24000, 1500 * Math.pow(2, op.failures - 1));
            op.fighter = null;
        }
        if (fighter && !fighter.spawning) op.fighter = { id: fighter.id, deathAt: Game.time + fighter.ticksToLive };
        if (op.failures >= 3 || op.retryAt > Game.time) { phase(op, 'COOLDOWN', 'CORE_FORCE_LOSS'); cancel(op); continue; }
        if (busy.has(home.name) || Object.values(Memory.rooms).some(m => m.keeperOperation &&
            m.keeperOperation.originRoom === home.name && ['ASSEMBLE','CLEAR','GUARD','MINE','HAUL'].includes(m.keeperOperation.phase))) {
            phase(op, 'DEFERRED', 'COMBAT_BUDGET_BUSY'); cancel(op); continue;
        }
        if (Hive.ensure().threats[home.name]?.dangerousHostileCount > 0) {
            phase(op, 'DEFERRED', 'HOME_UNDER_ATTACK'); cancel(op); continue;
        }
        const economy = Economy.get(home.name), growth = economy && economy.growth || {};
        const price = 780;
        if (!economy || !['STABLE', 'SURPLUS'].includes(economy.state) || !Economy.canSpend(home.name, 'combat') ||
            home.energyCapacityAvailable < price || !fighter && (growth.energyAboveReserve || 0) < price) {
            phase(op, 'DEFERRED', 'CORE_FORCE_UNFUNDED'); cancel(op); continue;
        }
        // A one-tick recovery exit must not finance a new expedition. Already
        // existing bodies can resume when safe; new spending needs sustained health.
        if (!fighter && (!Number.isFinite(economy.stateSince) || economy.stateSince > Game.time || Game.time - economy.stateSince < 100)) {
            phase(op, 'DEFERRED', 'CORE_ECONOMY_SETTLING'); cancel(op); continue;
        }
        if (!CombatPolicy.isDefenseRoom(roomName) && !Object.keys(memory.sources || {}).length) {
            phase(op, 'DEFERRED', 'NO_ECONOMIC_INTEREST'); cancel(op); continue;
        }
        if (!op.route || op.route.targetId !== snapshot.core.id || op.route.at > Game.time || Game.time - op.route.at > 300) {
            if (op.lastRouteAttempt <= Game.time && Game.time - op.lastRouteAttempt < 75) continue;
            op.lastRouteAttempt = Game.time;
            op.route = Remote.prepareNpcCoreRoute(home.name, roomName, snapshot.core);
        }
        if (!op.route) { phase(op, 'DEFERRED', 'NO_SAFE_CORE_ROUTE'); cancel(op); continue; }
        op.routeRooms = op.route.rooms;
        op.travelTicks = op.route.travelTicks;
        const damage = fighter ? MathCombat.analyzeBody(fighter).melee : 180;
        if (fighter && fighter.hits < fighter.hitsMax) { phase(op, 'DEFERRED', 'CORE_ATTACKER_DAMAGED'); cancel(op); continue; }
        const killTicks = Math.ceil(snapshot.core.hits / Math.max(1, damage));
        if (killTicks + op.travelTicks * 2 + 100 >= (fighter && !fighter.spawning ? fighter.ticksToLive : 1500)) {
            phase(op, 'DEFERRED', 'CORE_LIFETIME_INSUFFICIENT'); cancel(op); continue;
        }
        op.funded = true; busy.add(home.name);
        phase(op, fighter && !fighter.spawning ? 'CLEAR' : 'ASSEMBLE', fighter ? 'CLEAR_UNOPPOSED_LESSER_CORE' : 'ASSEMBLING_CORE_ATTACKER');
        if (op.phase === 'CLEAR') {
            if (!op.progress || op.progress.tick > Game.time || snapshot.core.hits < op.progress.hits)
                op.progress = { hits: snapshot.core.hits, tick: Game.time };
            if (Game.time - op.progress.tick > Math.max(200, op.travelTicks + 150)) {
                op.failures = (op.failures || 0) + 1;
                op.retryAt = Game.time + Math.min(24000, 1500 * Math.pow(2, op.failures - 1));
                phase(op, 'COOLDOWN', 'CORE_CLEAR_STALLED'); cancel(op); continue;
            }
        } else delete op.progress;
        Board.emit({ id: op.id, role: 'Ronin', count: 1, originRoom: home.name, preferredSpawnRoom: home.name,
            targetRoom: roomName, bodyRequirements: { fixed: true, body: body() }, priority: 56,
            economyCategory: 'combat', producer: 'npcCoreOperations', validUntil: Game.time + 5,
            memory: { role: 'Ronin', homeRoom: home.name, targetRoom: roomName, npcCoreOperationId: op.id }, reason: op.reason });
    }
}
function runCreep(creep) {
    if (!creep.memory.npcCoreOperationId) return false;
    const op = Memory.rooms[creep.memory.targetRoom] && Memory.rooms[creep.memory.targetRoom].npcCoreOperation;
    if (creep.room.name === creep.memory.homeRoom && (!op || op.phase !== 'CLEAR') &&
        (Index.get().hostilesByRoom.get(creep.room.name) || []).some(c => c.owner && c.owner.username === 'Invader')) return false;
    const snapshot = observe(creep.memory.targetRoom);
    if (!op || op.id !== creep.memory.npcCoreOperationId || op.updatedAt !== Game.time || op.phase !== 'CLEAR' ||
        !snapshot.safe || snapshot.complete || creep.hits < creep.hitsMax || creep.ticksToLive <= op.travelTicks + 50) {
        if (creep.room.name !== creep.memory.homeRoom) travel.moveToRoom(creep, creep.memory.homeRoom, { reusePath: 5 });
        return true;
    }
    if (creep.room.name !== op.roomName) {
        travel.moveToRoom(creep, op.roomName, { reusePath: 5, allowedRooms: Object.fromEntries((op.routeRooms || []).map(name => [name, true])) });
        return true;
    }
    if (MathCombat.rangeBetween(creep, snapshot.core) <= 1) creep.attack(snapshot.core);
    else travel.move(creep, snapshot.core, { range: 1, reusePath: 5 });
    return true;
}

module.exports = { run, runCreep, observe, body };
