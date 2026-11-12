// Explicitly assigned Volley patrols. This module never creates spawn requests.
const Intel = require('Keeper.Intel');
const MathCombat = require('Combat.Math');
const Index = require('HiveMind.Index');
const Tactics = require('Squad.Tactics');
const travel = require('utility.Travel.Creep');
const Policy = require('NPC.Policy');

function capable(creep) {
    return Policy.guardCapable(creep);
}

function energyLairs(intel, includeMineral = false) {
    return intel ? Object.values(intel.lairs).filter(lair => includeMineral ||
        lair.resourceIds.some(id => intel.resources[id] && intel.resources[id].kind === 'source')) : [];
}

function protection(roomName, homeRoom) {
    const intel = Intel.get(roomName);
    const guards = Index.get().allCreeps.filter(c => c.memory && c.memory.role === 'Volley' &&
        c.memory.keeperPatrolRoom === roomName && c.memory.homeRoom === homeRoom &&
        c.pos.roomName === roomName && c.memory.keeperPatrolState !== 'RETREAT' && capable(c));
    const fresh = intel && intel.observedAt === Game.time && !!Game.rooms[roomName];
    // Until measured patrol travel certifies shared coverage, require one live
    // guard per lair. Never assume a desired or spawning body supplies protection.
    const required = energyLairs(intel).length;
    return { ready: !!(fresh && required && guards.length >= required && !intel.otherHostiles && !intel.core),
        guards: guards.map(c => c.name), required };
}

function economics(roomName, options = {}) {
    const intel = Intel.get(roomName);
    const sources = intel ? Object.values(intel.resources).filter(r => r.kind === 'source') : [];
    const travelTicks = options.travelTicks;
    const uptime = options.uptime;
    if (!sources.length || !Number.isFinite(travelTicks) || travelTicks < 0 || travelTicks >= 1200 ||
        !Number.isFinite(uptime) || uptime <= 0 || uptime > 1) return { viable: false, reason: 'NEEDS_TRAVEL_AND_UPTIME' };
    const peakGross = sources.reduce((sum, s) => sum + s.capacity / 300, 0);
    const gross = peakGross * uptime;
    const guards = energyLairs(intel, options.includeMineral === true).length;
    const lifetime = 1500 - travelTicks;
    const combat = guards * 5000 / lifetime; // 10 RANGED, 10 HEAL, 20 MOVE; unboosted
    const minerTravel = Number.isFinite(options.minerTravelTicks) ? options.minerTravelTicks : travelTicks;
    if (minerTravel < 0 || minerTravel >= 1200) return { viable: false, reason: 'MINER_LIFETIME_INSUFFICIENT' };
    const mining = sources.length * 950 / (1500 - minerTravel); // 7 WORK, CARRY, 4 MOVE
    const roundTrip = Number.isFinite(options.roundTripTicks) ? options.roundTripTicks : 2 * travelTicks;
    if (roundTrip < 0 || roundTrip >= 1400) return { viable: false, reason: 'HAUL_LIFETIME_INSUFFICIENT' };
    // Income is discounted for unsafe periods; transport still covers a full
    // productive window so the operation cannot manufacture a cheap CARRY budget.
    const carry = Math.ceil(peakGross * (roundTrip + 4) / 50);
    const hauling = carry * 100 / lifetime; // CARRY+MOVE per 50 energy
    const infrastructure = options.infrastructureCost;
    if (!Number.isFinite(infrastructure) || infrastructure < 0) return { viable: false, reason: 'NEEDS_INFRASTRUCTURE_COST' };
    const net = gross - combat - mining - hauling - infrastructure;
    const spawnUsage = (guards * 120 + carry * 6) / lifetime + sources.length * 36 / (1500 - minerTravel);
    const capacity = options.energyCapacity;
    const spawnBudget = options.spawnBudget;
    const reason = net <= 0 ? 'NEGATIVE_NET' : !(capacity >= 5000) ? 'GUARD_BODY_UNAFFORDABLE' :
        !Number.isFinite(spawnBudget) || spawnBudget <= 0 ? 'NEEDS_SPAWN_BUDGET' :
        spawnUsage >= spawnBudget ? 'SPAWN_BUDGET_EXCEEDED' : 'MODELED_FEASIBILITY_ONLY';
    return { viable: reason === 'MODELED_FEASIBILITY_ONLY', profitable: net > 0,
        gross, peakGross, net, combat, mining, hauling, carry, guards, spawnUsage,
        guardBodyCost: 5000, reason };
}

function run(creep) {
    const roomName = creep.memory.keeperPatrolRoom;
    if (!roomName) return false;
    const mission = Policy.keeper(roomName);
    if (creep.memory.keeperOperationId && (!mission || !Policy.guardMayDeploy(roomName, creep.memory.homeRoom))) {
        // A staged/withdrawn guard can still serve ordinary NPC home defense.
        if (creep.room.name === creep.memory.homeRoom &&
            (Index.get().hostilesByRoom.get(creep.room.name) || []).some(c => c.owner && c.owner.username === 'Invader')) return false;
        if (creep.getActiveBodyparts(HEAL) > 0) creep.heal(creep);
        creep.memory.keeperPatrolState = 'RALLY';
        if (creep.room.name !== creep.memory.homeRoom) travel.moveToRoom(creep, creep.memory.homeRoom, { reusePath: 5 });
        else {
            const spawn = (Index.get().ownedSpawnsByRoom.get(creep.memory.homeRoom) || [])[0];
            if (spawn) travel.move(creep, spawn, { range: 3, reusePath: 5 });
        }
        return true;
    }
    if (creep.getActiveBodyparts(HEAL) > 0) creep.heal(creep);
    const intel = Intel.get(roomName);
    const unhealthy = !capable(creep) || intel && (intel.core || intel.otherHostiles);
    if (unhealthy || creep.memory.keeperPatrolState === 'RETREAT' &&
        (creep.room.name !== creep.memory.homeRoom || creep.hits < creep.hitsMax)) {
        creep.memory.keeperPatrolState = 'RETREAT';
        if (creep.room.name !== creep.memory.homeRoom) travel.moveToRoom(creep, creep.memory.homeRoom, { reusePath: 5 });
        return true;
    }
    if (creep.room.name !== roomName) {
        if (!intel || intel.observedAt > Game.time || Game.time - intel.observedAt > 50) {
            require('Remote.Intel').request(roomName, 'KEEPER_PATROL_NEEDS_VISION', 80);
            creep.memory.keeperPatrolState = 'WAIT_INTEL';
            if (creep.room.name !== creep.memory.homeRoom) travel.moveToRoom(creep, creep.memory.homeRoom, { reusePath: 5 });
            return true;
        }
        creep.memory.keeperPatrolState = 'TRAVEL';
        travel.moveToRoom(creep, roomName, { reusePath: 5 });
        return true;
    }
    const relevantLairs = energyLairs(intel, creep.memory.keeperIncludeMineral === true)
        .filter(l => !creep.memory.keeperOperationId || l.id === creep.memory.keeperLairId);
    const guardedNames = new Set(relevantLairs.map(l => 'Keeper' + l.id));
    const allKeepers = (Index.get().hostilesByRoom.get(roomName) || []).filter(c => c.owner && c.owner.username === 'Source Keeper');
    const enemies = allKeepers.filter(c => guardedNames.has(c.name));
    const peers = Index.get().allCreeps.filter(c => c !== creep && c.memory && c.memory.keeperPatrolRoom === roomName);
    const locked = enemies.find(c => c.id === creep.memory.keeperTargetId);
    const target = locked || enemies.slice().sort((a, b) => {
        const claimed = id => peers.some(c => c.memory.keeperTargetId === id) ? 100 : 0;
        return claimed(a.id) + MathCombat.rangeBetween(creep, a) - claimed(b.id) - MathCombat.rangeBetween(creep, b);
    })[0];
    if (target) {
        creep.memory.keeperTargetId = target.id;
        creep.memory.keeperPatrolState = 'ENGAGE';
        const range = MathCombat.rangeBetween(creep, target);
        if (range <= 3) creep.rangedAttack(target);
        const incoming = MathCombat.incomingDamage(creep, allKeepers);
        if (incoming > MathCombat.analyzeBody(creep).heal) creep.memory.keeperPatrolState = 'RETREAT';
        if (range < 3 || incoming > MathCombat.analyzeBody(creep).heal) {
            const kite = Tactics.chooseKitePositions(creep, null, allKeepers);
            if (kite.primary) travel.move(creep, kite.primary, { range: 0, reusePath: 0,
                trafficPriority: 70, fallbackPositions: kite.fallbacks, disableSharedRouteCache: true });
            else creep.memory.keeperPatrolState = 'RETREAT';
        } else if (range > 3) travel.move(creep, target, { range: 3, reusePath: 0,
            roomCallback: function(name, matrix) {
                if (name !== roomName) return matrix;
                for (const enemy of allKeepers) for (let x = Math.max(0, enemy.pos.x - 2); x <= Math.min(49, enemy.pos.x + 2); x++)
                    for (let y = Math.max(0, enemy.pos.y - 2); y <= Math.min(49, enemy.pos.y + 2); y++) matrix.set(x, y, 255);
                return matrix;
            } });
        return true;
    }
    delete creep.memory.keeperTargetId;
    creep.memory.keeperPatrolState = 'PATROL';
    const lairs = relevantLairs;
    lairs.sort((a, b) => (a.nextSpawnAt === null ? Infinity : a.nextSpawnAt) -
        (b.nextSpawnAt === null ? Infinity : b.nextSpawnAt) || a.id.localeCompare(b.id));
    const unclaimed = lairs.find(l => !peers.some(p => p.memory.keeperLairId === l.id)) || lairs[0];
    if (unclaimed) {
        creep.memory.keeperLairId = unclaimed.id;
        const station = mission && intel.resources[unclaimed.resourceIds.find(id => intel.resources[id] && intel.resources[id].kind === 'source')];
        const camp = station ? station.pos : unclaimed.pos;
        travel.move(creep, new RoomPosition(camp.x, camp.y, roomName), { range: station ? 4 : 5, reusePath: 5 });
    }
    return true;
}

function fleeCivilian(creep) {
    const hazards = Intel.hazards(creep.room.name);
    if (!hazards.some(h => MathCombat.rangeBetween(creep, h.pos) <= h.range)) return false;
    const kite = Tactics.chooseKitePositions(creep, null, hazards);
    if (!kite.primary) return false;
    const margin = p => Math.min(...hazards.map(h => MathCombat.rangeBetween(p, h.pos) - h.range));
    if (margin(kite.primary) <= margin(creep.pos)) return false;
    travel.move(creep, kite.primary, { range: 0, reusePath: 0, trafficPriority: 70,
        fallbackPositions: kite.fallbacks, disableSharedRouteCache: true });
    return true;
}

module.exports = { capable, protection, economics, run, fleeCivilian };
