// Successful intents need accounting before Game reflects next tick's state.
let state;
function get() {
    if (!state || state.tick !== Game.time || state.memory !== Memory) {
        state = { tick: Game.time, memory: Memory, spawns: [], energy: {}, used: new Set() };
    }
    return state;
}
function available(room) {
    const remaining = get().energy[room.name];
    return Math.min(room.energyAvailable, remaining === undefined ? room.energyAvailable : remaining);
}
function record(spawn, name, request, cost, before) {
    const current = get();
    current.energy[spawn.room.name] = before - cost;
    current.used.add(spawn.name);
    current.spawns.push({ name: spawn.name, room: spawn.room,
        spawning: { name, needTime: request.body.length * 3, remainingTime: request.body.length * 3 },
        memory: request.memory, request });
}
module.exports = { get, available, record };
