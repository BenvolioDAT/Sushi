const HiveMemory = require('HiveMind.Memory');
const Season11 = require('Logic.Season11');

function stateFor(roomName) {
    const observers = HiveMemory.ensure().resources.observers;
    if (!observers[roomName]) observers[roomName] = { roomName, queue: [], index: 0, lastObserved: {} };
    return observers[roomName];
}

function buildQueue(origin, radius = 5) {
    const seen = new Set([origin]);
    const queue = [{ roomName: origin, range: 0 }];
    const result = [];
    while (queue.length) {
        const current = queue.shift();
        if (current.range >= radius) continue;
        const exits = Game.map.describeExits(current.roomName) || {};
        for (const roomName of Object.values(exits).sort()) {
            if (!roomName || seen.has(roomName)) continue;
            seen.add(roomName);
            result.push(roomName);
            queue.push({ roomName, range: current.range + 1 });
        }
    }
    if (Season11.isObserving()) {
        result.sort((a, b) => {
            const aDistance = Game.map.getRoomLinearDistance(origin, a);
            const bDistance = Game.map.getRoomLinearDistance(origin, b);
            return aDistance - bDistance || Season11.scoutPriority(b) - Season11.scoutPriority(a) || a.localeCompare(b);
        });
    }
    return result;
}

function priorityRooms(origin) {
    const hive = HiveMemory.ensure();
    const priorities = [];
    for (const threat of Object.values(hive.threats)) if (threat && threat.roomName) priorities.push(threat.roomName);
    const expansion = HiveMemory.ensure().expansion;
    if (expansion.targetRoom) priorities.push(expansion.targetRoom);
    const seasonRooms = hive.season && hive.season.rooms || {};
    for (const roomName of Object.keys(seasonRooms)) priorities.push(roomName);
    return Array.from(new Set(priorities)).filter(roomName => roomName !== origin &&
        Game.map.getRoomLinearDistance(origin, roomName) <= 10).sort();
}

function chooseTarget(observer) {
    const state = stateFor(observer.room.name);
    if (!state.queue.length || Game.time - (state.queueBuiltTick || 0) > 5000) {
        state.queue = buildQueue(observer.room.name);
        state.queueBuiltTick = Game.time;
        state.index = 0;
    }
    const candidates = priorityRooms(observer.room.name).concat(state.queue);
    for (let checked = 0; checked < candidates.length; checked++) {
        const index = (state.index + checked) % candidates.length;
        const roomName = candidates[index];
        if (!roomName || Game.time - (state.lastObserved[roomName] || 0) < 100) continue;
        state.index = (index + 1) % candidates.length;
        return roomName;
    }
    return null;
}

function run(observer) {
    if (!observer || typeof observer.observeRoom !== 'function' || observer.cooldown > 0) return null;
    const targetRoom = chooseTarget(observer);
    if (!targetRoom) return null;
    const result = observer.observeRoom(targetRoom);
    const state = stateFor(observer.room.name);
    state.lastAttempt = { tick: Game.time, targetRoom, result };
    if (result === OK) state.lastObserved[targetRoom] = Game.time;
    return state.lastAttempt;
}

module.exports = { stateFor, buildQueue, priorityRooms, chooseTarget, run };
