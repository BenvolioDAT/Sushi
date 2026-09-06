/* Capability-bounded body generation. No runtime objects or Memory retained. */
const COST = { work: 100, carry: 50, move: 50, attack: 80, ranged_attack: 150, heal: 250, tough: 10, claim: 600 };
const n = (v, fallback = 0) => Number.isFinite(v) ? Math.max(0, v) : fallback;
function cost(body) { return (body || []).reduce((sum, p) => sum + (COST[p.type || p] || 0), 0); }
function lifetime(body, memory = {}) {
    const base = body.some(p => (p.type || p) === 'claim') ? 600 : 1500;
    const aging = Math.max(1, n(memory.season11AgingMultiplier, 1));
    return Math.max(1, Math.min(base / aging, n(memory.expectedUsefulLifetime, base),
        base - n(memory.remoteTravelTicks || memory.season11RouteDistance)));
}
function metrics(body, options = {}) {
    const counts = {};
    for (const part of body) counts[part.type || part] = (counts[part.type || part] || 0) + 1;
    const expectedLifetime = lifetime(body, options);
    const useful = counts.work || counts.carry || counts.claim || counts.attack || counts.ranged_attack || counts.heal || 1;
    return { bodyParts: body.length, cost: cost(body), spawnTime: body.length * 3,
        WORK: counts.work || 0, CARRY: counts.carry || 0, MOVE: counts.move || 0,
        expectedLifetime, estimatedReplacementLoad: body.length * 3 / expectedLifetime,
        usefulWorkPerCpuEstimate: useful / Math.max(0.05, n(options.cpuPerCreep, 0.2)),
        usefulWorkPerSpawnTick: useful / Math.max(1, body.length * 3) };
}
function build(role, options = {}) {
    const emergency = options.urgency === 'EMERGENCY';
    const energy = n(emergency ? options.energyAvailable : options.energyCapacity);
    const road = options.routeProfile === 'ROAD_HEAVY' && options.provenRoads === true;
    const fed = role === 'Tech' && options.controllerFed === true;
    const work = Math.floor(n(options.desiredWork, role === 'Extractor' || role === 'ThoriumMiner' ? 5 : 0));
    const carry = Math.floor(n(options.desiredCarry, 0));
    const combat = ['Ronin', 'Volley', 'Cleric'].includes(role);
    const requested = role === 'Scout' ? 1 : role === 'Annex' || role === 'ReactorClaimer' ?
        Math.floor(n(options.desiredClaim, 1)) : combat ? Math.floor(n(options.desiredPower, 1)) :
        ['Freighter', 'Foreman', 'ThoriumHauler', 'ResourceCourier', 'SupplyRunner'].includes(role) ? carry : work;
    const maximum = Math.min(50, requested, role === 'Extractor' ? n(options.maxWork, work) : 50);
    let chosen = null;
    // At most 50 small candidates. Emergency chooses the first viable capability.
    for (let amount = 1; amount <= maximum; amount++) {
        let counts;
        if (role === 'Scout') counts = { move: 1 };
        else if (role === 'Annex' || role === 'ReactorClaimer') counts = { claim: amount, move: amount };
        else if (combat) {
            const power = role === 'Ronin' ? 'attack' : role === 'Volley' ? 'ranged_attack' : 'heal';
            const tough = role === 'Ronin' ? Math.ceil(amount / 4) : 0;
            const heal = role !== 'Cleric' && amount >= 8 ? 1 : 0;
            counts = { tough, move: amount + tough + heal, [power]: amount };
            if (heal) counts.heal = heal;
        } else if (carry > 0 && !work) counts = { carry: amount, move: Math.ceil(amount / (road ? 2 : 1)) };
        else {
            const c = role === 'Extractor' || role === 'ThoriumMiner' ? 1 :
                fed ? Math.max(1, Math.ceil(amount / 4)) : role === 'Tech' ? Math.ceil(amount / 3) : Math.ceil(amount / 2);
            const movement = emergency && amount === 1 ? 1 : role === 'Extractor' && options.routeProfile !== 'REMOTE_OFFROAD' ? Math.ceil(amount / 2) :
                road || fed ? Math.ceil((amount + c) / 2) : amount + c;
            counts = role === 'Extractor' ? { work: amount, move: movement, carry: c } : { work: amount, carry: c, move: movement };
        }
        const body = Object.entries(counts).flatMap(([part, count]) => Array(count).fill(part));
        if (body.length > 50 || cost(body) > energy) continue;
        if (options.urgency === 'REPLACEMENT' && body.length * 3 > n(options.replacementDeadline, 150)) continue;
        if (role === 'ThoriumHauler' && lifetime(body, options) <= body.length * 3 + n(options.roundTrip, 100)) continue;
        chosen = body;
        if (emergency && !combat) break;
    }
    if (!chosen) return null;
    return { body: chosen, ...metrics(chosen, options), reason: emergency ? 'EMERGENCY: affordable useful minimum' :
        (options.cpuMode === 'low' || options.cpuMode === 'critical' ? 'CPU constrained; consolidate capability' :
            'fewest useful bodies within capability, energy and spawn deadline') + (road ? '; proven roads' : fed ? '; controller fed' : '; conservative mobility') };
}
function requestOptions(room, request) {
    const m = request.memory || {}, body = request.body || [], counts = metrics(body, m);
    const sourceId = m.remoteSourceId || m.sourceId;
    const memory = Memory.rooms && Memory.rooms[room.name] || {};
    const info = sourceId && memory.remotePlanner && (memory.remotePlanner.sourceInfos || {})[sourceId];
    const route = info && info.route;
    const road = route && route.valid !== false && Game.time - (route.lastValidatedAt || 0) < 500 &&
        route.terrain && route.terrain.road >= route.length * 0.9 && !route.terrain.swamp;
    const structures = require('HiveMind.Index').get().structuresByRoom.get(room.name);
    const feeding = structures && ['container', 'link'].some(type => (structures.get(type) || []).some(s =>
        s.pos && room.controller && room.controller.pos &&
        Math.max(Math.abs(s.pos.x - room.controller.pos.x), Math.abs(s.pos.y - room.controller.pos.y)) <= 3 &&
        s.store && s.store.energy > 0));
    return { season11AgingMultiplier: m.season11AgingMultiplier || 1,
        season11RouteDistance: m.season11RouteDistance || 0,
        energyCapacity: room.energyCapacityAvailable, energyAvailable: room.energyAvailable,
        desiredWork: request.requestedWorkParts || request.maxWorkParts || counts.WORK,
        maxWork: request.requestedWorkParts || request.maxWorkParts || counts.WORK,
        desiredCarry: request.requestedCarryParts || request.maxCarryParts || counts.CARRY,
        desiredClaim: (request.bodyCapabilities || {}).claim || body.filter(p => (p.type || p) === 'claim').length || 1,
        desiredPower: (request.bodyCapabilities || {}).power,
        urgency: request.emergency || m.controllerEmergency ? 'EMERGENCY' : request.deadline ? 'REPLACEMENT' : 'NORMAL',
        replacementDeadline: request.deadline ? Math.max(0, request.deadline - Game.time) : 150,
        controllerFed: !!feeding, provenRoads: !!road, routeProfile: road ? 'ROAD_HEAVY' : 'UNKNOWN',
        cpuMode: require('CPU.Status').getCpuStatus().mode };
}
module.exports = { build, metrics, cost, lifetime, requestOptions };
