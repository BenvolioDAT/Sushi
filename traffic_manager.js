const utility = require('utility');

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
    if (!global.__sushiTrafficIntents || global.__sushiTrafficIntents.tick !== Game.time || global.__sushiTrafficIntents.game !== Game) {
        global.__sushiTrafficIntents = { tick: Game.time, game: Game, byRoom: new Map() };
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
    if (memory.squadId) return 80;
    if (['Ronin', 'Volley', 'Cleric'].includes(memory.role)) return 70;
    if (memory.role === 'Extractor' && (memory.homeRoom || memory.sourceId || memory.targetSourceId)) return 70;
    if (memory.role === 'Freighter') return 50;
    if (['ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer'].includes(memory.role) || memory.season11Maintenance) return 50;
    if (memory.role === 'Annex') return 40;
    if (memory.role === 'Artificer' && memory.remoteWorkRoomName) return 35;
    if (!memory.assignment && !memory.targetRoom && !memory.remoteWorkRoomName &&
        !memory.targetId && !memory.sourceId && !memory.task && !memory.operationId) return 5;
    return 20;
}

function isProtectedStationaryMiner(creep) {
    const memory = creep.memory || {};
    if (memory.role !== 'Extractor' || /retreat|moving|waiting|idle|Delivery/i.test(memory.extractorState || '')) return false;
    // An explicit movement request also covers seat correction and local recovery delivery.
    if (creep._trafficIntent || creep.memory._sushiMoveTick === Game.time) return false;
    const sourceId = memory.sourceId || memory.targetSourceId;
    const source = sourceId && Game.getObjectById(sourceId);
    const saved = Memory.rooms[creep.pos.roomName] && Memory.rooms[creep.pos.roomName].sources;
    const record = saved && saved[sourceId];
    const origin = source && source.pos || record && record.pos;
    if (!origin || origin.roomName !== creep.pos.roomName || creep.pos.getRangeTo(origin) !== 1) return false;
    const same = pos => pos && pos.x === creep.pos.x && pos.y === creep.pos.y && pos.roomName === creep.pos.roomName;
    const seat = memory.miningSeat;
    if (seat && seat.sourceId === sourceId && same(seat) &&
        utility.getValidSourceMiningSeats(record, origin).some(same)) return true;
    const container = record && record.containerId && Game.getObjectById(record.containerId);
    return same(container && container.pos) || same(utility.getPlannedSourceContainerPosition(record, origin));
}

function alternateHazards(creep) {
    const state = registry();
    if (!state.hazards) state.hazards = new Map();
    const roomName = creep.pos.roomName;
    if (state.hazards.has(roomName)) return state.hazards.get(roomName);
    const blocked = new Set();
    const reserve = pos => { if (pos) blocked.add(packCoordinates(pos)); };
    const sources = Memory.rooms[roomName] && Memory.rooms[roomName].sources || {};
    Object.values(sources).forEach(source => {
        reserve(source.pos);
        reserve(utility.getPlannedSourceContainerPosition(source));
        utility.getValidSourceMiningSeats(source).forEach(reserve);
    });
    const room = Game.rooms[roomName] || creep.room;
    if (room && room.find) {
        (room.find(FIND_STRUCTURES) || []).forEach(structure => {
            if (structure.structureType === STRUCTURE_TOWER && !structure.my && structure.store &&
                structure.store[RESOURCE_ENERGY] >= 10) blocked.add('unsafeRoom');
            if (structure.structureType === STRUCTURE_CONTAINER ||
                (typeof OBSTACLE_OBJECT_TYPES !== 'undefined' && OBSTACLE_OBJECT_TYPES.includes(structure.structureType)) ||
                (structure.structureType === STRUCTURE_RAMPART && !structure.my && !structure.isPublic)) reserve(structure.pos);
        });
        (room.find(FIND_HOSTILE_CREEPS) || []).forEach(hostile => {
            const active = type => hostile.body && hostile.body.some(part => part.type === type && part.hits > 0);
            const range = active(RANGED_ATTACK) ? 4 : active(ATTACK) ? 2 : 0;
            for (let x = hostile.pos.x - range; x <= hostile.pos.x + range; x++) {
                for (let y = hostile.pos.y - range; y <= hostile.pos.y + range; y++) reserve({ x, y });
            }
        });
    }
    state.hazards.set(roomName, blocked);
    return blocked;
}

function routeTraffic(metadata) {
    const planner = metadata && Memory.rooms[metadata.homeRoom] && Memory.rooms[metadata.homeRoom].remotePlanner;
    const info = planner && planner.sourceInfos && planner.sourceInfos[metadata.sourceId];
    if (!info || !info.route || info.route.revision !== metadata.routeRevision) return null;
    const traffic = info.route.traffic || (info.route.traffic = {});
    traffic.avgObservedTravel = info.route.observedRoundTripTicks || traffic.avgObservedTravel || 0;
    return traffic;
}

function recordTraffic(metadata, event) {
    const traffic = routeTraffic(metadata);
    if (!traffic) return;
    traffic[event] = (traffic[event] || 0) + 1;
    if (['moves', 'blockedMoves', 'detours', 'stuckEvents'].includes(event)) {
        traffic.congestionScore = Math.round(((traffic.congestionScore || 0) * 0.9 +
            (event === 'moves' ? 0 : 10)) * 100) / 100;
    }
    traffic.lastUpdated = Game.time;
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
            fallbackPacked: normalizeFallbacks(options.fallbackPositions),
            remoteRoute: options.remoteRoute || null
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
    if (Math.max(Math.abs(coord.x - creep.pos.x), Math.abs(coord.y - creep.pos.y)) !== 1) return false;
    const hazards = alternateHazards(creep);
    if (hazards.has('unsafeRoom') || hazards.has(packCoordinates(coord))) return false;
    return !costs || costs.get(coord.x, coord.y) < threshold;
}

function getPossibleMoves(creep, costs, threshold = 255) {
    if (creep._cachedMoveOptions) return creep._cachedMoveOptions;
    if (creep.fatigue > 0) return (creep._cachedMoveOptions = []);

    const intent = creep._trafficIntent;
    if (intent) {
        const sides = intent.remoteRoute && !intent.fixed ? Object.values(directionDelta).map(delta => ({
            x: creep.pos.x + delta.x, y: creep.pos.y + delta.y
        })).filter(coord => isLegalAlternate(creep, coord, costs, threshold)) : [];
        sides.sort((a, b) => coordinateOrder(creep, a, b));
        const packed = [intent.packedTarget].concat(intent.fallbackPacked || [], sides.map(packCoordinates));
        const unique = Array.from(new Set(packed)).map(unpackCoordinates);
        return (creep._cachedMoveOptions = unique.filter((coord, index) => {
            return index === 0 || isLegalAlternate(creep, coord, costs, threshold);
        }));
    }

    if (creep._trafficLocked || isProtectedStationaryMiner(creep)) return (creep._cachedMoveOptions = []);

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
    if (context.occupancy.get(creep._matchedPackedCoord) === creep) context.occupancy.delete(creep._matchedPackedCoord);
    creep._matchedPackedCoord = packed;
    context.occupancy.set(packed, creep);
}

function search(context, creep, rootPriority, visited) {
    if (!creep || creep.my === false || visited.has(creep.name)) return false;
    visited.add(creep.name);

    let moves = getPossibleMoves(creep, context.costs, context.threshold);
    // On a highway head-on, prefer a free side tile over a lower-priority swap.
    if (context.root && context.root !== creep && (creep._trafficPriority || 0) < rootPriority &&
        (context.root._trafficIntent && context.root._trafficIntent.remoteRoute || creep._trafficIntent && creep._trafficIntent.remoteRoute) &&
        creep._intendedPackedCoord === packCoordinates(context.root.pos)) {
        const candidates = creep._trafficIntent && creep._trafficIntent.fixed ? [] : Object.values(directionDelta).map(delta => ({
            x: creep.pos.x + delta.x, y: creep.pos.y + delta.y
        })).filter(coord => isLegalAlternate(creep, coord, context.costs, context.threshold));
        candidates.sort((a, b) => coordinateOrder(creep, a, b));
        const dx = creep.pos.x - context.root.pos.x, dy = creep.pos.y - context.root.pos.y;
        const sides = candidates.filter(coord =>
            (coord.x - creep.pos.x) * dy !== (coord.y - creep.pos.y) * dx &&
            !context.occupancy.has(packCoordinates(coord)));
        moves = sides.concat(moves.filter(coord => !sides.some(side => side.x === coord.x && side.y === coord.y)));
    }
    for (const coord of moves) {
        const packed = packCoordinates(coord);
        const occupant = context.occupancy.get(packed);
        if (!occupant) {
            assign(context, creep, coord);
            return true;
        }
        if (occupant === creep || occupant.my === false || occupant.__trafficBlocker) continue;
        if ((occupant._trafficLocked && !occupant._trafficIntent) || isProtectedStationaryMiner(occupant)) continue;
        if (
            (occupant._trafficPriority || 0) > rootPriority &&
            occupant._matchedPackedCoord === occupant._intendedPackedCoord
        ) continue;
        if (search(context, occupant, rootPriority, visited)) {
            context.displaced.add(occupant.name);
            context.pushedBy.set(occupant.name, context.root._trafficIntent && context.root._trafficIntent.remoteRoute);
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
    const context = { occupancy: new Map(), costs, threshold, displaced: new Set(), pushedBy: new Map() };

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
        if (context.displaced.has(creep.name)) continue;
        context.root = creep;
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
        const changed = creep.pos.x !== matched.x || creep.pos.y !== matched.y;
        const intent = creep._trafficIntent;
        const metadata = intent && intent.remoteRoute;
        const result = changed ? creep.move(creep.pos.getDirectionTo(matched.x, matched.y)) : null;
        if (changed && result === OK) {
            moved++;
            if (metadata) {
                recordTraffic(metadata, creep._matchedPackedCoord === intent.packedTarget ? 'moves' : 'detours');
                if (creep._matchedPackedCoord !== intent.packedTarget) recordTraffic(metadata, 'sidesteps');
                else if (metadata.rejoin) recordTraffic(metadata, 'rejoins');
            }
            if (context.pushedBy.has(creep.name)) {
                const pushedRoute = metadata || context.pushedBy.get(creep.name);
                recordTraffic(pushedRoute, 'pushes');
                if (!metadata) recordTraffic(pushedRoute, 'sidesteps');
            }
        } else if (metadata && creep.fatigue === 0) recordTraffic(metadata, 'blockedMoves');
        // Heap-only observations: distinguish accepted intents from actual next-tick progress.
        if (!global.__sushiTrafficProgress || global.__sushiTrafficProgress.game !== Game &&
            global.__sushiTrafficProgress.tick >= Game.time) global.__sushiTrafficProgress = { game: Game, tick: Game.time, creeps: new Map() };
        const progress = global.__sushiTrafficProgress;
        progress.game = Game;
        if (progress.tick !== Game.time) {
            for (const [name, value] of progress.creeps) if (value.tick < Game.time - 1) progress.creeps.delete(name);
            progress.tick = Game.time;
        }
        const previous = progress.creeps.get(creep.name);
        const position = creep.pos.roomName + ':' + packCoordinates(creep.pos);
        if (previous && previous.tick === Game.time - 1 && previous.position === position && previous.expected && creep.fatigue === 0) {
            recordTraffic(previous.metadata, 'stuckEvents');
        }
        progress.creeps.set(creep.name, { tick: Game.time, position, expected: changed && result === OK, metadata });
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
    defaultPriority,
    isProtectedStationaryMiner
};
