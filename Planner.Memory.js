/* Structure-planner Memory shape and migration helpers. */

function create(version, positionKeys) {
    function makeEmptyByRcl() {
        const byRcl = {};
        for (let rcl = 1; rcl <= 8; rcl++) {
            byRcl[rcl] = [];
        }
        return byRcl;
    }

    function makeEmptyPositions() {
        const positions = {};
        for (let i = 0; i < positionKeys.length; i++) {
            positions[positionKeys[i]] = [];
        }
        return positions;
    }

    function ensurePositionKeys(positions) {
        for (let i = 0; positions && i < positionKeys.length; i++) {
            if (!positions[positionKeys[i]]) {
                positions[positionKeys[i]] = [];
            }
        }
    }

    function makeEmptyPlan() {
        return {
            anchor: null,
            byRcl: makeEmptyByRcl(),
            positions: makeEmptyPositions(),
            links: { storage: null, controller: null, sources: {} },
            containers: { controller: null, mineral: null, sources: {} },
            extensionServiceTiles: []
        };
    }

    function ensurePlanShape(plan) {
        const shaped = plan || makeEmptyPlan();
        shaped.byRcl = shaped.byRcl || makeEmptyByRcl();
        shaped.positions = shaped.positions || makeEmptyPositions();
        ensurePositionKeys(shaped.positions);
        shaped.links = shaped.links || { storage: null, controller: null, sources: {} };
        shaped.containers = shaped.containers || { controller: null, mineral: null, sources: {} };
        shaped.extensionServiceTiles = shaped.extensionServiceTiles || [];
        return shaped;
    }

    function makeEmptyPlannerMemory() {
        return {
            version: version,
            lastPlanned: 0,
            lastBuilt: 0,
            lastRcl: 0,
            buildIndex: 0,
            forceReplan: false,
            plan: makeEmptyPlan()
        };
    }

    function ensurePlannerMemory(roomName) {
        Memory.rooms = Memory.rooms || {};
        Memory.rooms[roomName] = Memory.rooms[roomName] || {};
        const roomMemory = Memory.rooms[roomName];
        roomMemory.structurePlanner = roomMemory.structurePlanner || makeEmptyPlannerMemory();
        const planner = roomMemory.structurePlanner;

        planner.plan = ensurePlanShape(planner.plan);
        if (planner.forceReplan === undefined) planner.forceReplan = false;
        if (!planner.lastPlanned) planner.lastPlanned = 0;
        if (!planner.lastBuilt) planner.lastBuilt = 0;
        if (!planner.lastRcl) planner.lastRcl = 0;
        if (!planner.buildIndex) planner.buildIndex = 0;
        return planner;
    }

    function ensurePlanJobMemory(job) {
        job.draftPlan = ensurePlanShape(job.draftPlan);
        job.reserved = job.reserved || {};
        job.candidates = job.candidates || [];
        job.candidateScan = job.candidateScan || {
            range: 1, x: 0, y: 0, done: false, started: false
        };
        if (job.rcl === undefined) job.rcl = 0;
    }

    function resetRoom(roomName) {
        Memory.rooms = Memory.rooms || {};
        Memory.rooms[roomName] = Memory.rooms[roomName] || {};
        Memory.rooms[roomName].structurePlanner = makeEmptyPlannerMemory();
    }

    function packCoord(pos) {
        return pos.x + (pos.y * 50);
    }

    function unpackCoord(packed, roomName) {
        const value = parseInt(packed, 10) || 0;
        return new RoomPosition(value % 50, Math.floor(value / 50), roomName);
    }

    return {
        ensurePlanJobMemory: ensurePlanJobMemory,
        ensurePlanShape: ensurePlanShape,
        ensurePlannerMemory: ensurePlannerMemory,
        ensurePositionKeys: ensurePositionKeys,
        makeEmptyByRcl: makeEmptyByRcl,
        makeEmptyPlan: makeEmptyPlan,
        makeEmptyPlannerMemory: makeEmptyPlannerMemory,
        makeEmptyPositions: makeEmptyPositions,
        packCoord: packCoord,
        resetRoom: resetRoom,
        unpackCoord: unpackCoord
    };
}

module.exports = { create: create };
