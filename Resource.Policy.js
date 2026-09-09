const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const Economy = require('HiveMind.Economy');
const Labs = require('Resource.Labs');

const STOCKS = Object.freeze({
    H: [10000, 20000, 30000], O: [10000, 20000, 30000],
    U: [8000, 15000, 25000], L: [8000, 15000, 25000],
    K: [8000, 15000, 25000], Z: [8000, 15000, 25000],
    X: [15000, 25000, 40000], G: [5000, 10000, 10000]
});
const { DEFAULTS, config, capacity, free, active } = require('Resource.Storage');
function amount(store, type) { return Labs.amount(store, type); }
function state() {
    const r = HiveMemory.ensure().resources;
    if (!r.policy) r.policy = { resources: {}, rooms: {}, mining: {}, hubs: [], transfers: {} };
    return r.policy;
}
function record(type) {
    return { resourceType: type, totalStored: 0, storageAmount: 0, terminalAmount: 0,
        labAmount: 0, stagingAmount: 0, factoryAmount: 0, powerSpawnAmount: 0, reactorAmount: 0,
        reservedAmount: 0, availableAmount: 0, targetLow: 0, targetDesired: 0, targetHigh: 0,
        demandAmount: 0, demandReason: 'No active demand', state: 'TARGET', updatedAt: Game.time };
}
function snapshot(force = false) {
    const p = state(), c = config();
    if (!force && p.updatedAt <= Game.time && Game.time - p.updatedAt < c.interval) return p;
    const index = TickIndex.get(), resources = {}, rooms = {}, sources = {}, seenStores = new Set();
    const get = type => resources[type] || (resources[type] = record(type));
    for (const type of Object.keys(STOCKS)) get(type);
    for (const room of index.ownedRooms) {
        const local = rooms[room.name] = { ...capacity(room), inventory: {}, needs: {}, reasons: {}, mineralType: null };
        const minerals = typeof FIND_MINERALS !== 'undefined' && room.find ? room.find(FIND_MINERALS) || [] : [];
        for (const m of minerals) if (STOCKS[m.mineralType]) { sources[m.mineralType] = (sources[m.mineralType] || 0) + 1; local.mineralType = m.mineralType; }
        const byType = index.structuresByRoom.get(room.name) || new Map(), seen = new Set();
        const add = (s, field) => {
            if (!active(s) || !s.store || seen.has(s.id || s)) return;
            seen.add(s.id || s); seenStores.add(s.id || s);
            for (const type of Object.keys(s.store)) {
                if (typeof s.store[type] !== 'number' || s.store[type] <= 0) continue;
                const n = amount(s.store, type), r = get(type);
                r.totalStored += n; r[field] += n; local.inventory[type] = (local.inventory[type] || 0) + n;
            }
        };
        add(room.storage, 'storageAmount'); add(room.terminal, 'terminalAmount');
        for (const [type, field] of [['lab', 'labAmount'], ['factory', 'factoryAmount'], ['powerSpawn', 'powerSpawnAmount'], ['reactor', 'reactorAmount']]) {
            for (const s of byType.get(type) || []) add(s, field);
        }
        const saved = HiveMemory.ensure().resources.rooms[room.name];
        const stagingIds = new Set([saved && saved.mineral && saved.mineral.containerId]);
        for (const m of minerals) for (const s of byType.get('container') || []) {
            if (s.pos && m.pos && s.pos.getRangeTo(m) <= 2) stagingIds.add(s.id);
        }
        for (const id of stagingIds) if (id) add(Game.getObjectById(id), 'stagingAmount');
        const cluster = Labs.identifyCluster(room.name);
        local.hubScore = active(room.storage) && active(room.terminal) && cluster.outputs.length &&
            Economy.canSpend(room, 'resources') && local.capacityPressure === 'OK' ?
            room.controller.level * 10 + cluster.outputs.length * 2 : 0;
    }
    const season = HiveMemory.ensure().season && HiveMemory.ensure().season.season11;
    const thoriumType = typeof RESOURCE_THORIUM !== 'undefined' ? RESOURCE_THORIUM : null;
    for (const reactor of Object.values(season && season.reactors || {})) {
        if (!thoriumType || reactor.my !== true || seenStores.has(reactor.id)) continue;
        const live = Game.getObjectById(reactor.id);
        if (live && live.my !== true) continue;
        const stored = live ? amount(live.store, thoriumType) : Math.max(0, (reactor.thorium || 0) - (Game.time - (reactor.lastSeen || Game.time)));
        const r = get(thoriumType); r.totalStored += stored; r.reactorAmount += stored;
    }
    p.hubs = Object.keys(rooms).filter(name => rooms[name].hubScore > 0)
        .sort((a, b) => rooms[b].hubScore - rooms[a].hubScore || a.localeCompare(b));
    if (Array.isArray(c.hubs)) p.hubs.sort((a, b) => (c.hubs.includes(b) ? 1 : 0) - (c.hubs.includes(a) ? 1 : 0));
    const roots = {};
    function need(roomName, type, n, reason, additive = false) {
        if (!rooms[roomName] || !type || !(n > 0)) return;
        const key = roomName + ':' + type;
        roots[key] = { roomName, type, amount: additive ? (roots[key] && roots[key].amount || 0) + n :
            Math.max(n, roots[key] && roots[key].amount || 0), reason };
    }
    const system = HiveMemory.ensure().resources;
    for (const b of Object.values(system.boosts)) {
        if (!b || ['COMPLETE', 'ABORTED'].includes(b.state)) continue;
        for (const list of Object.values(b.requirements || {})) for (const item of list) {
            need(b.roomName, item.compound, Math.ceil(item.parts * 30 * (1 + c.boostSafetyMargin)), 'boost production demand', true);
        }
    }
    for (const [name, lab] of Object.entries(system.labs)) if (lab.reactionGoal && !lab.reactionGoal.policyManaged) {
        need(name, lab.reactionGoal.product, lab.reactionGoal.targetAmount, 'lab reaction demand');
    }
    for (const [name, list] of Object.entries(c.colonyNeeds || {})) for (const [type, n] of Object.entries(list)) need(name, type, n, 'configured colony need');
    const g = get('G'), gs = p.mining.G;
    const gTarget = (c.stockTargets || {}).G || {};
    const gLow = gTarget.resumeBelow ?? 5000, gHigh = gTarget.pauseAbove ?? 10000;
    if (p.hubs[0] && (g.totalStored < gLow || gs && gs.mode === 'MINING' && g.totalStored < gHigh)) need(p.hubs[0], 'G', gHigh, 'Ghodium reserve');
    for (const [type, n] of Object.entries(c.compoundReserves || {})) if (p.hubs[0]) need(p.hubs[0], type, n, 'configured compound reserve');
    // Shared inventory ledger: each unit of compound/intermediate covers only one requirement.
    const budget = Object.fromEntries(Object.entries(resources).map(([type, r]) => [type, r.totalStored]));
    p.production = [];
    function expand(roomName, type, n, reason, path = []) {
        if (!(n > 0) || path.includes(type) || path.length > 12) return;
        const r = get(type), local = rooms[roomName];
        r.demandAmount += n; r.demandReason = reason;
        local.needs[type] = (local.needs[type] || 0) + n; local.reasons[type] = reason;
        const used = Math.min(n, budget[type] || 0); budget[type] = (budget[type] || 0) - used;
        r.reservedAmount += used;
        const missing = n - used, ingredients = Labs.ingredientsFor(type);
        if (missing > 0 && ingredients) {
            const productionRoom = rooms[roomName].hubScore > 0 ? roomName : p.hubs[0] || roomName;
            for (const input of ingredients) expand(productionRoom, input, missing, reason, path.concat(type));
            p.production.push({ roomName: productionRoom, product: type, amount: missing, reason, ingredients });
        }
    }
    for (const root of Object.values(roots).sort((a, b) => a.type.localeCompare(b.type) || a.roomName.localeCompare(b.roomName))) expand(root.roomName, root.type, root.amount, root.reason);
    for (const [type, r] of Object.entries(resources)) {
        const base = STOCKS[type] || [0, 0, 0], override = (c.stockTargets || {})[type] || {};
        r.targetLow = Math.max(0, override.resumeBelow ?? base[0]);
        r.targetDesired = Math.max(r.targetLow, override.desired ?? base[1]);
        r.targetHigh = Math.max(r.targetDesired, override.pauseAbove ?? base[2]);
        if (r.demandAmount) {
            if (type === 'G') {
                r.targetLow = Math.max(r.targetLow, r.demandAmount);
                r.targetDesired = Math.max(r.targetDesired, r.demandAmount);
                r.targetHigh = Math.max(r.targetHigh, r.demandAmount);
            } else { r.targetLow += r.demandAmount; r.targetDesired += r.demandAmount; r.targetHigh += r.demandAmount; }
        }
        if (type === thoriumType) {
            r.targetLow = r.targetDesired = r.targetHigh = 0;
            r.demandReason = 'FINITE_RESOURCE';
            r.reservedAmount = Object.values(season && season.thoriumReservations && season.thoriumReservations.stores || {})
                .reduce((sum, store) => sum + Object.values(store.reactors || {}).reduce((n, value) => n + value, 0), 0);
        }
        r.availableAmount = Math.max(0, r.totalStored - r.reservedAmount);
        r.state = r.totalStored < r.targetLow ? 'CRITICAL' : r.totalStored < r.targetDesired ? 'NEEDED' : r.totalStored >= r.targetHigh && r.targetHigh > 0 ? 'SURPLUS' : 'TARGET';
        if (STOCKS[type]) {
            const old = p.mining[type] || { mode: 'MINING', stateSince: Game.time };
            const mode = r.totalStored >= r.targetHigh ? 'PAUSED_TARGET_REACHED' :
                r.totalStored < r.targetLow ? 'MINING' : old.mode;
            p.mining[type] = { mode, stateSince: mode === old.mode ? old.stateSince : Game.time };
            r.miningState = mode;
        }
    }
    p.resources = resources; p.rooms = rooms; p.sources = sources; p.updatedAt = Game.time;
    return p;
}
function extraction(room, type) {
    const p = snapshot(), r = p.resources[type];
    if (!STOCKS[type] || type === 'G') return { allowed: false, reason: 'DEDICATED_RESOURCE' };
    if (!Economy.canSpend(room, 'resources')) return { allowed: false, reason: 'PAUSED_ECONOMY' };
    if (capacity(room).extractionBlockedReason) return { allowed: false, reason: 'PAUSED_STORAGE_PRESSURE' };
    const allowed = p.mining[type].mode === 'MINING';
    return { allowed, reason: allowed ? 'MINING_RESOURCE_DEFICIT' : 'PAUSED_TARGET_REACHED',
        detail: `${type}: NEED ${r.targetDesired} / HAVE ${r.totalStored} - ${r.demandReason}` };
}
function deposit(room, type) {
    if (!room || !room.controller || !room.controller.my) return null;
    if (active(room.storage) && free(room.storage.store) > 0) return room.storage;
    return null;
}
function diversity(type) { return STOCKS[type] && type !== 'G' && !(snapshot().sources[type] > 0) ? Math.min(10, Math.max(0, config().diversityBonus)) : 0; }
function planReactions() {
    const p = snapshot();
    for (const task of p.production) {
        const room = Game.rooms[task.roomName];
        if (!room || capacity(room).extractionBlockedReason || !Economy.canSpend(room, 'resources')) continue;
        const lab = Labs.roomState(room.name);
        if (lab.reactionGoal || !Labs.identifyCluster(room.name).outputs.length) continue;
        const missing = task.ingredients.filter(type => !(p.rooms[room.name].inventory[type] >= 5));
        if (missing.length) {
            lab.blockingIngredients = missing;
            p.resources[task.product].state = 'BLOCKED';
            p.resources[task.product].blockingIngredients = missing;
            continue;
        }
        lab.blockingIngredients = [];
        const goal = Labs.configureReaction(room.name, task.product, (p.rooms[room.name].inventory[task.product] || 0) + task.amount);
        goal.policyManaged = true;
    }
}
module.exports = { STOCKS, DEFAULTS, config, state, snapshot, capacity, extraction, deposit, diversity, planReactions, free, active };
