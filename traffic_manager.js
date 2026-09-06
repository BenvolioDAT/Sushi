/* Deterministic cooperative movement. Final creep.move ownership lives here. */
const directionDelta = {
    [TOP]: { x: 0, y: -1 },
    [TOP_RIGHT]: { x: 1, y: -1 },
    [RIGHT]: { x: 1, y: 0 },
    [BOTTOM_RIGHT]: { x: 1, y: 1 },
    [BOTTOM]: { x: 0, y: 1 },
    [BOTTOM_LEFT]: { x: -1, y: 1 },
    [LEFT]: { x: -1, y: 0 },
    [TOP_LEFT]: { x: -1, y: -1 }
};

function registry() {
    if (!global.__sushiTrafficIntents || global.__sushiTrafficIntents.tick !== Game.time) {
        global.__sushiTrafficIntents = { tick: Game.time, byRoom: new Map() };
    }
    return global.__sushiTrafficIntents;
}

function roomRegistry(roomName) {
    const state = registry();
    if (!state.byRoom.has(roomName)) state.byRoom.set(roomName, new Map());
    return state.byRoom.get(roomName);
}

function packCoordinates(coord) {
    return `${coord.x}:${coord.y}`;
}

function unpackCoordinates(packedCoord) {
    const [x, y] = packedCoord.split(':').map(Number);
    return { x, y };
}

function defaultPriority(creep) {
    const memory = creep.memory || {};
    if (typeof memory.trafficPriority === 'number') return memory.trafficPriority;
    if (memory.role === 'Freighter' && creep.store && creep.store.getUsedCapacity && creep.store.getUsedCapacity() > 0) return 90;
    if (memory.role === 'Extractor' && (memory.homeRoom || memory.sourceId || memory.targetSourceId)) return 70;
    if (memory.role === 'Freighter') return 50;
    if (memory.role === 'Annex') return 40;
    if (memory.role === 'Artificer' && memory.remoteWorkRoomName) return 35;
    if (!memory.assignment && !memory.targetRoom && !memory.remoteWorkRoomName) return 5;
    if (memory.squadId) return 80;
    if (['Ronin', 'Volley', 'Cleric'].includes(memory.role)) return 60;
    if (['ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer'].includes(memory.role)) return 45;
    return 20;
}

function normalizeTarget(creep, target) {
    if (Number.isInteger(target)) {
        const delta = directionDelta[target];
        if (!delta) return null;
        return { x: creep.pos.x + delta.x, y: creep.pos.y + delta.y };
    }
    if (!target || !Number.isInteger(target.x) || !Number.isInteger(target.y)) return null;
    return { x: target.x, y: target.y };
}

function normalizeFallbacks(values) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (!value || !Number.isInteger(value.x) || !Number.isInteger(value.y)) continue;
        const packed = packCoordinates(value);
        if (!seen.has(packed)) {
            seen.add(packed);
            result.push(packed);
        }
    }
    return result;
}

function recordIndexIntent(roomName, record) {
    const index = global.__sushiTickIndex;
    if (!index || index.tick !== Game.time) return;
    const intents = roomRegistry(roomName);
    index.movementIntentsByRoom.set(roomName, Array.from(intents.values()));
}

function init(visual = false) {
    Creep.prototype.registerMove = function registerMove(target, options = {}) {
        const targetPosition = normalizeTarget(this, target);
        if (!targetPosition) return ERR_INVALID_ARGS;
        if (visual && this.room) new RoomVisual(this.room.name).arrow(this.pos, targetPosition);

        const roomName = this.room ? this.room.name : this.pos.roomName;
        const record = {
            creep: this,
            creepName: this.name,
            roomName,
            packedTarget: packCoordinates(targetPosition),
            priority: Number.isFinite(options.priority) ? options.priority : defaultPriority(this),
            fixed: options.fixed === true,
            operationId: options.operationId || (this.memory && this.memory.operationId) || null,
            squadId: options.squadId || (this.memory && this.memory.squadId) || null,
            fallbackPacked: normalizeFallbacks(options.fallbackPositions)
        };
        this._intendedPackedCoord = record.packedTarget;
        this._trafficIntent = record;
        this._trafficPriority = record.priority;
        if (record.fixed) this._trafficLocked = true;
        roomRegistry(roomName).set(this.name, record);
        recordIndexIntent(roomName, record);
        return OK;
    };

    Creep.prototype.setWorkingArea = function setWorkingArea(pos, range) {
        this._workingPos = pos;
        this._workingRange = range;
        return OK;
    };

    Creep.prototype.setTrafficLock = function setTrafficLock(locked = true) {
        this._trafficLocked = locked;
        return OK;
    };
}

function hasMovementIntents(roomName) {
    const intents = registry().byRoom.get(roomName);
    return !!intents && intents.size > 0;
}

function getMovementIntents(roomName) {
    const intents = registry().byRoom.get(roomName);
    return intents ? Array.from(intents.values()) : [];
}

function coordinateOrder(creep, a, b) {
    const aCost = (a.cost || 0) - (b.cost || 0);
    if (aCost) return aCost;
    const seed = String(creep.name || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 8;
    const aDirection = directionIndex(creep.pos, a, seed);
    const bDirection = directionIndex(creep.pos, b, seed);
    return aDirection - bDirection || a.x - b.x || a.y - b.y;
}

function directionIndex(origin, target, seed) {
    const dx = Math.sign(target.x - origin.x);
    const dy = Math.sign(target.y - origin.y);
    const deltas = Object.values(directionDelta);
    const index = deltas.findIndex(delta => delta.x === dx && delta.y === dy);
    return (index - seed + 8) % 8;
}

function insideRoom(coord) {
    return coord.x > 0 && coord.x < 49 && coord.y > 0 && coord.y < 49;
}

function isLegalAlternate(creep, coord, costs, threshold) {
    if (!insideRoom(coord)) return false;
    const terrain = Game.map.getRoomTerrain(creep.room.name);
    if (terrain.get(coord.x, coord.y) === TERRAIN_MASK_WALL) return false;
    return !costs || costs.get(coord.x, coord.y) < threshold;
}

function getPossibleMoves(creep, costs, threshold = 255) {
    if (creep._cachedMoveOptions) return creep._cachedMoveOptions;
    if (creep.fatigue > 0) return (creep._cachedMoveOptions = []);

    const intent = creep._trafficIntent;
    if (intent) {
        const packed = [intent.packedTarget].concat(intent.fallbackPacked || []);
        const unique = Array.from(new Set(packed)).map(unpackCoordinates);
        return (creep._cachedMoveOptions = unique.filter((coord, index) => {
            return index === 0 || isLegalAlternate(creep, coord, costs, threshold);
        }));
    }

    const memory = creep.memory || {};
    const stationaryMiner = memory.role === 'Extractor' && (memory.sourceId || memory.targetSourceId);
    if (creep._trafficLocked || stationaryMiner) return (creep._cachedMoveOptions = []);

    const inArea = [];
    const outOfArea = [];
    for (const delta of Object.values(directionDelta)) {
        const coord = { x: creep.pos.x + delta.x, y: creep.pos.y + delta.y };
        if (!isLegalAlternate(creep, coord, costs, threshold)) continue;
        coord.cost = costs ? costs.get(coord.x, coord.y) : 0;
        if (
            creep._workingPos &&
            creep._workingPos.getRangeTo(coord.x, coord.y) > creep._workingRange
        ) outOfArea.push(coord);
        else inArea.push(coord);
    }
    inArea.sort((a, b) => coordinateOrder(creep, a, b));
    outOfArea.sort((a, b) => coordinateOrder(creep, a, b));
    return (creep._cachedMoveOptions = inArea.concat(outOfArea));
}

function assign(context, creep, coord) {
    const packed = packCoordinates(coord);
    creep._matchedPackedCoord = packed;
    context.occupancy.set(packed, creep);
}

function search(context, creep, rootPriority, visited) {
    if (!creep || creep.my === false || visited.has(creep.name)) return false;
    visited.add(creep.name);

    for (const coord of getPossibleMoves(creep, context.costs, context.threshold)) {
        const packed = packCoordinates(coord);
        const occupant = context.occupancy.get(packed);
        if (!occupant) {
            assign(context, creep, coord);
            return true;
        }
        if (occupant === creep || occupant.my === false || occupant.__trafficBlocker) continue;
        const occupantMemory = occupant.memory || {};
        const protectedMiner = occupantMemory.role === 'Extractor' &&
            (occupantMemory.sourceId || occupantMemory.targetSourceId) &&
            String(occupantMemory.extractorState || '').indexOf('retreat') < 0;
        if (protectedMiner) continue;
        if (
            (occupant._trafficPriority || 0) > rootPriority &&
            occupant._matchedPackedCoord === occupant._intendedPackedCoord
        ) continue;
        if (search(context, occupant, rootPriority, visited)) {
            assign(context, creep, coord);
            return true;
        }
    }
    return false;
}

function blockerRecord(blocker, index) {
    return {
        name: `__blocker_${blocker.id || blocker.name || index}`,
        my: false,
        __trafficBlocker: true,
        pos: blocker.pos
    };
}

function run(room, costs, threshold = 255, options = {}) {
    const creeps = options.creeps || room.find(FIND_MY_CREEPS);
    const blockers = options.blockers || [];
    const context = { occupancy: new Map(), costs, threshold };

    for (const creep of creeps) {
        creep._cachedMoveOptions = undefined;
        creep._matchedPackedCoord = packCoordinates(creep.pos);
        if (!creep._trafficIntent) creep._trafficPriority = defaultPriority(creep);
        context.occupancy.set(creep._matchedPackedCoord, creep);
    }
    blockers.forEach((blocker, index) => {
        if (blocker && blocker.pos) context.occupancy.set(packCoordinates(blocker.pos), blockerRecord(blocker, index));
    });

    const intentful = creeps.filter(creep => creep._trafficIntent || creep._intendedPackedCoord);
    intentful.sort((a, b) => {
        const priority = (b._trafficPriority || 0) - (a._trafficPriority || 0);
        return priority || String(a.name).localeCompare(String(b.name));
    });

    for (const creep of intentful) {
        if (creep._matchedPackedCoord === creep._intendedPackedCoord) continue;
        const original = creep._matchedPackedCoord;
        if (context.occupancy.get(original) === creep) context.occupancy.delete(original);
        creep._matchedPackedCoord = undefined;
        if (!search(context, creep, creep._trafficPriority || 0, new Set())) {
            assign(context, creep, unpackCoordinates(original));
        }
    }

    let moved = 0;
    for (const creep of creeps) {
        if (!creep._matchedPackedCoord) continue;
        const matched = unpackCoordinates(creep._matchedPackedCoord);
        if (creep.pos.x === matched.x && creep.pos.y === matched.y) continue;
        creep.move(creep.pos.getDirectionTo(matched.x, matched.y));
        moved++;
    }
    return { creeps: creeps.length, intents: intentful.length, moved };
}

module.exports = {
    init,
    run,
    hasMovementIntents,
    getMovementIntents,
    getPossibleMoves,
    packCoordinates,
    unpackCoordinates,
    defaultPriority
};
