const HiveMemory = require('HiveMind.Memory');
const Economy = require('HiveMind.Economy');
const TickIndex = require('HiveMind.Index');
const Strategy = require('Strategy.Provider');

const ENERGY_RESERVE = 20000;
const MIN_SEND = 100;

function terminalRooms() {
    return TickIndex.get().ownedRooms.filter(room => room.terminal && room.terminal.my !== false && room.controller && room.controller.my);
}

function amount(store, resourceType) {
    if (!store) return 0;
    return typeof store.getUsedCapacity === 'function' ? store.getUsedCapacity(resourceType) || 0 : store[resourceType] || 0;
}

function requestTransfer(input) {
    if (!input || !input.fromRoom || !input.toRoom || input.fromRoom === input.toRoom || !input.resourceType) return null;
    if (isDedicatedThorium(input.resourceType)) return null;
    const resources = HiveMemory.ensure().resources;
    const id = input.id || `terminal:${input.fromRoom}:${input.toRoom}:${input.resourceType}`;
    const transfer = {
        id,
        fromRoom: input.fromRoom,
        toRoom: input.toRoom,
        resourceType: input.resourceType,
        amount: Math.max(MIN_SEND, Math.floor(input.amount || MIN_SEND)),
        priority: Number.isFinite(input.priority) ? input.priority : 50,
        createdTick: input.createdTick || Game.time,
        validUntil: input.validUntil || Game.time + 500,
        reason: input.reason || 'Empire resource balance'
    };
    if (input.allowExternal === true) transfer.allowExternal = true;
    const existing = resources.transfers[id];
    resources.transfers[id] = existing ? { ...existing, ...transfer, amount: Math.max(existing.amount || 0, transfer.amount) } : transfer;
    return resources.transfers[id];
}

function resourceKeys(store) {
    if (!store || typeof store !== 'object') return [];
    return Object.keys(store).filter(key => typeof store[key] === 'number' && store[key] > 0 && key !== RESOURCE_ENERGY);
}

function isDedicatedThorium(resourceType) {
    /* Intentional Season 11 policy: generic terminal logistics never move
       Thorium, even between owned terminals. Staging and Reactor supply remain
       exclusively under the dedicated creep pipeline. */
    const special = Strategy.getSpecialResourcePolicy(resourceType);
    return !!(special && special.finite);
}

function reservedAmount(roomName, resourceType) {
    const mineralPerPart = typeof LAB_BOOST_MINERAL === 'number' ? LAB_BOOST_MINERAL : 30;
    let reserved = 0;
    for (const request of Object.values(HiveMemory.ensure().resources.boosts)) {
        if (!request || request.roomName !== roomName || ['COMPLETE', 'ABORTED'].includes(request.state)) continue;
        for (const requirements of Object.values(request.requirements || {})) {
            for (const item of requirements || []) if (item.compound === resourceType) reserved += item.parts * mineralPerPart;
        }
    }
    const lab = HiveMemory.ensure().resources.labs[roomName];
    if (lab && lab.reactionGoal && lab.reactionGoal.product === resourceType) {
        reserved = Math.max(reserved, lab.reactionGoal.targetAmount || 0);
    }
    return reserved;
}

function planBalance() {
    const Policy = require('Resource.Policy'), p = Policy.snapshot(), rooms = terminalRooms();
    // Retire queued legacy symmetry jobs when upgrading an existing empire.
    const transfers = HiveMemory.ensure().resources.transfers;
    for (const [id, t] of Object.entries(transfers)) if (t.reason === 'Automatic owned-terminal balance') delete transfers[id];
    const allocated = {};
    for (const receiver of rooms) {
        const local = p.rooms[receiver.name];
        if (!local) continue;
        for (const [type, target] of Object.entries(local.needs)) {
            if (isDedicatedThorium(type) || type === RESOURCE_ENERGY) continue;
            const shortage = target - (local.inventory[type] || 0);
            if (shortage <= 0) continue;
            const donor = rooms.filter(r => r.name !== receiver.name && p.rooms[r.name] &&
                (p.rooms[r.name].inventory[type] || 0) - (p.rooms[r.name].needs[type] || 0) - (allocated[r.name + ':' + type] || 0) >= MIN_SEND)
                .sort((a, b) => transferCost(1000, a.name, receiver.name) - transferCost(1000, b.name, receiver.name) || a.name.localeCompare(b.name))[0];
            if (!donor) continue;
            const key = donor.name + ':' + type;
            const n = Math.min(1000, Math.max(MIN_SEND, shortage), (p.rooms[donor.name].inventory[type] || 0) -
                (p.rooms[donor.name].needs[type] || 0) - (allocated[key] || 0));
            requestTransfer({ fromRoom: donor.name, toRoom: receiver.name, resourceType: type,
                amount: n, priority: 70, validUntil: Game.time + 100, reason: local.reasons[type] });
            allocated[key] = (allocated[key] || 0) + n;
        }
    }
    // Relieve a pressured vault only when another colony has genuinely useful headroom.
    for (const donor of rooms) {
        const local = p.rooms[donor.name];
        if (!local || local.capacityPressure !== 'PRESSURE') continue;
        const receiver = rooms.find(r => r.name !== donor.name && p.rooms[r.name] &&
            p.rooms[r.name].storageFree > Policy.config().desiredStorageFreeCapacity + 10000);
        if (!receiver) continue;
        const type = Object.keys(local.inventory).sort().find(t => t !== RESOURCE_ENERGY &&
            t !== (typeof RESOURCE_POWER !== 'undefined' ? RESOURCE_POWER : 'power') && !isDedicatedThorium(t) &&
            (local.inventory[t] || 0) - (local.needs[t] || 0) >= 1000);
        if (type) requestTransfer({ fromRoom: donor.name, toRoom: receiver.name, resourceType: type,
            amount: 1000, priority: 30, validUntil: Game.time + 100, reason: 'Storage pressure consolidation' });
    }

}

function transferCost(n, from, to) {
    return Game.market && typeof Game.market.calcTransactionCost === 'function' ?
        Game.market.calcTransactionCost(n, from, to) : Math.ceil(n * 0.5);
}

function jobs(room) {
    const Policy = require('Resource.Policy'), c = Policy.config(), result = [];
    if (!room.terminal || !room.storage || !room.controller || !room.controller.my) return result;
    const outgoing = {};
    for (const t of Object.values(HiveMemory.ensure().resources.transfers)) if (t.fromRoom === room.name && t.validUntil >= Game.time && !isDedicatedThorium(t.resourceType)) outgoing[t.resourceType] = (outgoing[t.resourceType] || 0) + t.amount;
    outgoing[RESOURCE_ENERGY] = c.terminalEnergyReserve + 5000;
    for (const type of new Set([...Object.keys(outgoing), ...resourceKeys(room.terminal.store)])) {
        if (isDedicatedThorium(type)) continue;
        const current = amount(room.terminal.store, type), wanted = outgoing[type] || 0;
        const loading = current < wanted;
        const source = loading ? room.storage : room.terminal, target = loading ? room.terminal : room.storage;
        const n = Math.min(Math.abs(wanted - current), amount(source.store, type),
            Math.max(0, Policy.free(target.store) - (loading ? c.minimumTerminalFreeCapacity : 0)));
        if (n <= 0) continue;
        result.push({ id: `terminal-stage:${room.name}:${type}`, type: 'TRANSFER', roomName: room.name,
            sourceId: source.id, targetId: target.id, resourceType: type, amount: n, priority: 65,
            reason: loading ? 'Stage owned transfer buffer' : 'Return transit stock to Storage' });
    }
    return result;
}

function validate(transfer) {
    if (!transfer || transfer.validUntil < Game.time) return { ok: false, reason: 'expired' };
    if (isDedicatedThorium(transfer.resourceType)) {
        return { ok: false, reason: 'Thorium is reserved for the Season 11 Reactor pipeline' };
    }
    const from = Game.rooms[transfer.fromRoom];
    const to = Game.rooms[transfer.toRoom];
    const external = !(to && to.controller && to.controller.my);
    if (!from || !from.controller || !from.controller.my) {
        return { ok: false, reason: 'origin room must be mine and visible' };
    }
    if (external && (!transfer.allowExternal || !Strategy.capabilities().externalTerminalTransfers)) {
        return { ok: false, reason: Strategy.capabilities().externalTerminalTransfers ?
            'external transfer requires explicit permission' : 'strategy restricts transfers to owned terminals' };
    }
    if (!from.terminal || from.terminal.my === false || !external && (!to.terminal || to.terminal.my === false)) {
        return { ok: false, reason: external ? 'owned origin terminal is required' : 'both owned terminals are required' };
    }
    if (amount(from.terminal.store, RESOURCE_ENERGY) < ENERGY_RESERVE) return { ok: false, reason: 'energy reserve' };
    const Policy = require('Resource.Policy'), c = Policy.config();
    const history = Policy.state().transfers;
    const key = [from.name, to.name].sort().join(':') + ':' + transfer.resourceType;
    if (history[key] !== undefined && Game.time - history[key] < c.transferCooldown) return { ok: false, reason: 'transfer hysteresis' };
    if (!external && Policy.free(to.terminal.store) - transfer.amount < c.minimumTerminalFreeCapacity) return { ok: false, reason: 'terminal capacity reserve' };
    const n = Math.min(transfer.amount, amount(from.terminal.store, transfer.resourceType));
    if (amount(from.terminal.store, RESOURCE_ENERGY) - transferCost(n, from.name, to.name) - (transfer.resourceType === RESOURCE_ENERGY ? n : 0) < c.terminalEnergyReserve) return { ok: false, reason: 'send energy reserve' };
    if (from.terminal.cooldown > 0) return { ok: false, reason: 'cooldown' };
    if (!Economy.canSpend(from, 'resources')) return { ok: false, reason: 'home economy recovery' };
    if (amount(from.terminal.store, RESOURCE_ENERGY) < ENERGY_RESERVE) return { ok: false, reason: 'energy reserve' };
    if (amount(from.terminal.store, transfer.resourceType) < MIN_SEND) return { ok: false, reason: 'resource unavailable' };
    return { ok: true, from, to };
}

function run() {
    const resources = HiveMemory.ensure().resources;
    if (Game.time % 25 === 0) planBalance();
    const queue = Object.values(resources.transfers).filter(Boolean)
        .sort((a, b) => b.priority - a.priority || a.createdTick - b.createdTick || a.id.localeCompare(b.id));
    const report = [];
    const usedRooms = new Set();
    for (const transfer of queue) {
        const check = validate(transfer);
        if (!check.ok) {
            if (check.reason === 'expired' || check.reason === 'both rooms must be mine and visible' ||
                check.reason === 'Thorium is reserved for the Season 11 Reactor pipeline') delete resources.transfers[transfer.id];
            report.push({ id: transfer.id, result: null, reason: check.reason });
            continue;
        }
        if (usedRooms.has(transfer.fromRoom)) continue;
        const sendAmount = Math.min(transfer.amount, amount(check.from.terminal.store, transfer.resourceType));
        const result = check.from.terminal.send(transfer.resourceType, sendAmount, transfer.toRoom, transfer.reason.slice(0, 100));
        report.push({ id: transfer.id, fromRoom: transfer.fromRoom, toRoom: transfer.toRoom, amount: sendAmount, result });
        usedRooms.add(transfer.fromRoom);
        if (result === OK) {
            require('Resource.Policy').state().transfers[[transfer.fromRoom, transfer.toRoom].sort().join(':') + ':' + transfer.resourceType] = Game.time;
            transfer.amount -= sendAmount;
            if (transfer.amount < MIN_SEND) delete resources.transfers[transfer.id];
        }
    }
    return report;
}

module.exports = { jobs, transferCost, requestTransfer, planBalance, validate, run, amount, terminalRooms, reservedAmount, isDedicatedThorium };
