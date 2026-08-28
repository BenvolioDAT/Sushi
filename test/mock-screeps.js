const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
process.env.NODE_PATH = [root, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

function installConstants() {
    const source = fs.readdirSync(root)
        .filter(file => file.endsWith('.js'))
        .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
        .join('\n');
    const names = source.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || [];
    for (const name of new Set(names)) {
        if (!(name in global)) global[name] = name;
    }

    Object.assign(global, {
        OK: 0,
        ERR_NOT_OWNER: -1,
        ERR_NO_PATH: -2,
        ERR_NAME_EXISTS: -3,
        ERR_BUSY: -4,
        ERR_NOT_FOUND: -5,
        ERR_NOT_ENOUGH_ENERGY: -6,
        ERR_INVALID_TARGET: -7,
        ERR_FULL: -8,
        ERR_NOT_IN_RANGE: -9,
        ERR_INVALID_ARGS: -10,
        ERR_TIRED: -11,
        TOP: 1,
        TOP_RIGHT: 2,
        RIGHT: 3,
        BOTTOM_RIGHT: 4,
        BOTTOM: 5,
        BOTTOM_LEFT: 6,
        LEFT: 7,
        TOP_LEFT: 8,
        LOOK_SCORE: 'score',
        MOVE: 'move',
        WORK: 'work',
        CARRY: 'carry',
        ATTACK: 'attack',
        RANGED_ATTACK: 'ranged_attack',
        HEAL: 'heal',
        CLAIM: 'claim',
        TOUGH: 'tough',
        RESOURCE_ENERGY: 'energy',
        RESOURCE_THORIUM: undefined,
        OBSTACLE_OBJECT_TYPES: [],
        CONTROLLER_STRUCTURES: {},
        BOOSTS: {},
        BODYPART_COST: new Proxy({}, { get: () => 50 })
    });
}

class RoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }
    getRangeTo(target, y) {
        const pos = typeof target === 'number' ? { x: target, y } : (target && target.pos ? target.pos : target);
        if (!pos) return Infinity;
        return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
    }
    getDirectionTo() { return TOP; }
    isNearTo(target) { return this.getRangeTo(target) <= 1; }
    inRangeTo(target, range) { return this.getRangeTo(target) <= range; }
    isEqualTo(pos) { return !!pos && this.x === pos.x && this.y === pos.y && this.roomName === pos.roomName; }
    findInRange() { return []; }
    findClosestByRange() { return null; }
    findClosestByPath() { return null; }
    lookFor() { return []; }
}

class CostMatrix {
    constructor() { this.data = new Map(); }
    set(x, y, value) { this.data.set(`${x}:${y}`, value); }
    get(x, y) { return this.data.get(`${x}:${y}`) || 0; }
    clone() {
        const copy = new CostMatrix();
        copy.data = new Map(this.data);
        return copy;
    }
}

class MockCreep {
    move() { return OK; }
    moveTo() { return OK; }
}

function installGlobals(cpu) {
    delete global.__sushiTickIndex;
    delete global.__sushiTrafficIntents;
    delete global.__sushiScheduler;
    delete global.__sushiTelemetry;
    installConstants();
    global.RoomPosition = RoomPosition;
    global.RoomVisual = class { text() { return this; } circle() { return this; } line() { return this; } rect() { return this; } };
    global.Room = class {};
    global.Creep = MockCreep;
    global.PowerCreep = class {};
    global.Structure = class {};
    global.StructureSpawn = class {};
    global.PathFinder = { CostMatrix, search: () => ({ path: [], incomplete: false, cost: 0, ops: 0 }) };
    global.Memory = { rooms: {}, creeps: {}, settings: {} };
    global.RawMemory = { segments: {}, setActiveSegments() {}, get: () => '{}' };
    global.Game = {
        time: 100,
        cpu: Object.assign({ limit: 20, tickLimit: 500, bucket: 10000, getUsed: () => 0 }, cpu),
        rooms: {},
        creeps: {},
        powerCreeps: {},
        spawns: {},
        flags: {},
        constructionSites: {},
        shard: { name: 'shard0' },
        map: {
            getRoomLinearDistance: () => 1,
            findRoute: () => [],
            describeExits: () => ({}),
            getRoomTerrain: () => ({ get: () => 0 })
        },
        getObjectById: () => null
    };
    global._ = {
        filter: (value, fn) => Object.values(value || {}).filter(fn),
        find: (value, fn) => Object.values(value || {}).find(fn),
        sum: value => Array.isArray(value) ? value.reduce((a, b) => a + b, 0) : 0,
        sortBy: (value, fn) => Object.values(value || {}).sort((a, b) => fn(a) - fn(b))
    };
    return global.Game;
}

function clearLocalModules() {
    for (const file of Object.keys(require.cache)) {
        if (file.startsWith(root + path.sep) && !file.includes(path.sep + 'test' + path.sep)) {
            delete require.cache[file];
        }
    }
}

module.exports = { root, installGlobals, clearLocalModules, RoomPosition, CostMatrix };
