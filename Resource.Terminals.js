const HiveMemory = require('HiveMind.Memory');
const Economy = require('HiveMind.Economy');
const TickIndex = require('HiveMind.Index');
const Season11Adapter = require('Season11.Adapter');

const ENERGY_RESERVE = 20000;
const MIN_SEND = 100;
const BALANCE_LOW = 1000;
const BALANCE_HIGH = 5000;

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
    return Season11Adapter.isAvailable() && resourceType === Season11Adapter.resourceType();
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
    const rooms = terminalRooms();
    const types = new Set();
    for (const room of rooms) for (const type of resourceKeys(room.terminal.store)) types.add(type);
    for (const type of Array.from(types).sort()) {
        if (isDedicatedThorium(type)) continue;
        const donors = rooms.filter(room => amount(room.terminal.store, type) > BALANCE_HIGH + reservedAmount(room.name, type))
            .sort((a, b) => amount(b.terminal.store, type) - amount(a.terminal.store, type) || a.name.localeCompare(b.name));
        const receivers = rooms.filter(room => amount(room.terminal.store, type) < BALANCE_LOW)
            .sort((a, b) => amount(a.terminal.store, type) - amount(b.terminal.store, type) || a.name.localeCompare(b.name));
        if (!donors[0] || !receivers[0] || donors[0] === receivers[0]) continue;
        requestTransfer({
            fromRoom: donors[0].name,
            toRoom: receivers[0].name,
            resourceType: type,
            amount: Math.min(1000, amount(donors[0].terminal.store, type) - BALANCE_HIGH - reservedAmount(donors[0].name, type)),
            priority: 25,
            validUntil: Game.time + 100,
            reason: 'Automatic owned-terminal balance'
        });
    }
}

function validate(transfer) {
    if (!transfer || transfer.validUntil < Game.time) return { ok: false, reason: 'expired' };
    if (isDedicatedThorium(transfer.resourceType)) {
        return { ok: false, reason: 'Thorium is reserved for the Season 11 Reactor pipeline' };
    }
    const from = Game.rooms[transfer.fromRoom];
    const to = Game.rooms[transfer.toRoom];
    if (!from || !to || !from.controller || !from.controller.my || !to.controller || !to.controller.my) {
        return { ok: false, reason: 'both rooms must be mine and visible' };
    }
    if (!from.terminal || from.terminal.my === false || !to.terminal || to.terminal.my === false) {
        return { ok: false, reason: 'both owned terminals are required' };
    }
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
        if (result === OK) delete resources.transfers[transfer.id];
    }
    return report;
}

module.exports = { requestTransfer, planBalance, validate, run, amount, terminalRooms, reservedAmount, isDedicatedThorium };
