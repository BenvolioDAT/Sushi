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

    global.OK = 0;
    global.ERR_NOT_FOUND = -5;
    global.ERR_INVALID_TARGET = -7;
    global.ERR_FULL = -8;
    global.ERR_NOT_IN_RANGE = -9;
    global.TOP = 1;
    global.TOP_RIGHT = 2;
    global.RIGHT = 3;
    global.BOTTOM_RIGHT = 4;
    global.BOTTOM = 5;
    global.BOTTOM_LEFT = 6;
    global.LEFT = 7;
    global.TOP_LEFT = 8;
    global.LOOK_SCORE = 'score';
    global.OBSTACLE_OBJECT_TYPES = [];
    global.CONTROLLER_STRUCTURES = {};
    global.BOOSTS = {};
    global.BODYPART_COST = new Proxy({}, { get: () => 50 });
}

class RoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }
    getRangeTo() { return 1; }
    isEqualTo(pos) { return !!pos && this.x === pos.x && this.y === pos.y; }
    findInRange() { return []; }
    findClosestByRange() { return null; }
    lookFor() { return []; }
}

class CostMatrix {
    set() {}
    get() { return 0; }
    clone() { return new CostMatrix(); }
}

function installGlobals(cpu) {
    installConstants();
    global.RoomPosition = RoomPosition;
    global.RoomVisual = class { text() {} circle() {} line() {} rect() {} };
    global.Room = class {};
    global.Creep = class { move() { return OK; } };
    global.PowerCreep = class {};
    global.PathFinder = { CostMatrix, search: () => ({ path: [], incomplete: false }) };
    global.Memory = { rooms: {}, creeps: {}, settings: {} };
    global.RawMemory = { segments: {}, setActiveSegments() {} };
    global.Game = {
        time: 100,
        cpu: Object.assign({ limit: 20, tickLimit: 500, bucket: 10000, getUsed: () => 0 }, cpu),
        rooms: {}, creeps: {}, spawns: {}, flags: {}, constructionSites: {},
        shard: { name: 'shard0' },
        map: {
            getRoomLinearDistance: () => 1,
            findRoute: () => [],
            describeExits: () => ({})
        },
        getObjectById: () => null
    };
    global._ = {
        filter: (value, fn) => Object.values(value || {}).filter(fn),
        find: (value, fn) => Object.values(value || {}).find(fn),
        sum: value => Array.isArray(value) ? value.reduce((a, b) => a + b, 0) : 0
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

module.exports = { root, installGlobals, clearLocalModules };
