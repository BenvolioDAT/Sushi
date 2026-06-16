var roleForeman = require('role.Foreman');
var roleExtractor = require('role.Extractor');
var roleTech = require('role.Tech');
var roleFreighter = require('role.Freighter');
var roleAnnex = require('role.Annex');
var roleArtificer = require('role.Artificer');
var rolePioneer = require('role.Pioneer');
var roleSupplyRunner = require('role.SupplyRunner');
var roleScout = require('role.Scout');
var roleRonin = require('role.Ronin');
var roleVolley = require('role.Volley');
var roleCleric = require('role.Cleric');
var roleScoreRunner = require('role.scorerunner');

var utility_spawn = require('utility.spawn');
var utilityVisual = require('utility.Visual');
var utility = require('utility');

var TowerLogic = require('Logic.Tower');
var WarRoom = require('Logic.WarRoom');
var ExpansionLogic = require('Logic.Expansion');

var spawnManager = require('spawn.manager');
var spawnRequestManager = require('spawn.request.manager');
var trafficManager = require('traffic_manager');
var travelUtility = require('utility.Travel.Creep');
var RemotePlanner = require('Planner.Remote');
var RoadPlanner = require('Planner.Roads');
var Dashboard = require('Visual.Dashboard');

/*
 * Harabi-style traffic movement is initialized once when this global is loaded.
 * Role code should keep asking Sushi's travel utility to move. The travel
 * utility registers the intended step, and the end-of-tick traffic pass below
 * performs the actual creep.move calls for each room.
 */
trafficManager.init();

/*
 * Tiles at or above this cost are avoided when traffic manager needs to shuffle
 * idle creeps out of the way. Intentional pathing still comes from Traveler.
 */
var TRAFFIC_MANAGER_THRESHOLD = 20;

/*
 * Save damaged structures into room memory.
 *
 * Memory path:
 * Memory.rooms[room.name].RepairStructure
 *
 * Example:
 * Memory.rooms.W39S47.RepairStructure = [
 *     "abc123",
 *     "def456"
 * ];
 */
function updateRepairStructureMemory(room) {
    /*
     * Safety check.
     * If no room was passed in, stop.
     */
    if (!room) {
        return;
    }

    /*
     * Make sure Memory.rooms exists.
     */
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    /*
     * Make sure this room has a memory object.
     *
     * Example:
     * Memory.rooms["W39S47"]
     */
    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }

    /*
     * Find all structures in the room that are damaged.
     *
     * A structure needs repair when:
     * structure.hits < structure.hitsMax
     */
    var damagedStructures = room.find(FIND_STRUCTURES, {
        filter: function(structure) {
            return structure.hits < structure.hitsMax;
        }
    });

    /*
     * Clear the old repair list.
     *
     * This is important because some structures may get repaired later.
     * We do not want old repaired structures staying in memory forever.
     */
    Memory.rooms[room.name].RepairStructure = [];

    /*
     * Save only the structure IDs into memory.
     *
     * We save IDs because Memory should store simple data:
     * strings, numbers, arrays, objects.
     *
     * Do not store the full structure object in Memory.
     */
    for (var i = 0; i < damagedStructures.length; i++) {
        Memory.rooms[room.name].RepairStructure.push(damagedStructures[i].id);
    }
}


function maybeGeneratePixel() {
    /*
     * Pixel generation is optional.
     *
     * enabled:
     * - false means Sushi will never generate pixels.
     * - true means Sushi may generate pixels when the bucket is healthy.
     *
     * bucketThreshold:
     * - Only generate pixels when Game.cpu.bucket is at or above this number.
     * - Higher numbers are safer because they leave more CPU saved for creeps.
     *
     * tickModulo:
     * - 100 means "only check every 100 ticks."
     * - Use 1 if you want to allow the check every tick.
     */
    var pixelCfg = {
        enabled: true,
        bucketThreshold: 9800,
        tickModulo: 10
    };

    if (!pixelCfg.enabled) {
        return;
    }

    /*
     * Some environments do not support pixel generation.
     */
    if (!Game.cpu || typeof Game.cpu.generatePixel !== 'function') {
        return;
    }

    /*
     * The sim shard is for simulation, not real pixel generation.
     */
    if (Game.shard && Game.shard.name === 'sim') {
        return;
    }

    /*
     * Some environments may not expose Game.cpu.bucket.
     */
    if (typeof Game.cpu.bucket !== 'number') {
        return;
    }

    if (Game.cpu.bucket < pixelCfg.bucketThreshold) {
        return;
    }

    if (pixelCfg.tickModulo > 1 && (Game.time % pixelCfg.tickModulo) !== 0) {
        return;
    }

    Game.cpu.generatePixel();
}

function ensureTrafficManagerSetting() {
    /*
     * Default traffic movement on, but keep the setting in Memory so it can be
     * disabled from the console without changing code:
     * Memory.settings.useTrafficManager = false
     */
    if (!Memory.settings) {
        Memory.settings = {};
    }

    if (Memory.settings.useTrafficManager === undefined) {
        Memory.settings.useTrafficManager = true;
    }
}

function isTrafficManagerEnabled() {
    ensureTrafficManagerSetting();
    return Memory.settings.useTrafficManager !== false;
}

function ensureWarRoomSetting() {
    /*
     * Automatic WarRoom scanning defaults off and can be enabled from the
     * console without changing code:
     * Memory.settings.useWarRoom = true
     */
    if (!Memory.settings) {
        Memory.settings = {};
    }

    if (Memory.settings.useWarRoom === undefined) {
        Memory.settings.useWarRoom = false;
    }
}

function isWarRoomEnabled() {
    ensureWarRoomSetting();
    return Memory.settings.useWarRoom === true;
}

function runTrafficManagerForVisibleRooms() {
    if (!isTrafficManagerEnabled()) {
        return;
    }

    /*
     * This is intentionally at the end of the tick:
     * - roles/tasks decide where creeps want to move
     * - utility.Travel.Creep registers those intended steps
     * - traffic manager resolves the room together
     * - traffic manager performs the real creep.move(direction) calls
     */
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        var costs = buildTrafficCostMatrix(room);

        trafficManager.run(room, costs, TRAFFIC_MANAGER_THRESHOLD);
    }
}

function buildTrafficCostMatrix(room) {
    /*
     * Sushi does not have a separate Harabi-style pathUtils matrix. This small
     * matrix is only for traffic-manager idle shuffling, so keep it cheap:
     * roads are preferred, containers are passable, hard obstacles are blocked.
     */
    var costs = new PathFinder.CostMatrix();
    var structures = room.find(FIND_STRUCTURES);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === STRUCTURE_ROAD) {
            costs.set(structure.pos.x, structure.pos.y, 1);
            continue;
        }

        if (structure.structureType === STRUCTURE_CONTAINER) {
            costs.set(structure.pos.x, structure.pos.y, 5);
            continue;
        }

        if (isTrafficBlockedStructure(structure)) {
            costs.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    var sites = room.find(FIND_CONSTRUCTION_SITES);

    for (var j = 0; j < sites.length; j++) {
        var site = sites[j];

        if (
            site.structureType === STRUCTURE_ROAD ||
            site.structureType === STRUCTURE_CONTAINER ||
            site.structureType === STRUCTURE_RAMPART
        ) {
            continue;
        }

        if (
            typeof OBSTACLE_OBJECT_TYPES !== 'undefined' &&
            OBSTACLE_OBJECT_TYPES.indexOf(site.structureType) !== -1
        ) {
            costs.set(site.pos.x, site.pos.y, 255);
        }
    }

    return costs;
}

function isTrafficBlockedStructure(structure) {
    if (structure.structureType === STRUCTURE_ROAD) {
        return false;
    }

    if (structure.structureType === STRUCTURE_CONTAINER) {
        return false;
    }

    if (structure.structureType === STRUCTURE_RAMPART) {
        return !structure.my && !structure.isPublic;
    }

    return (
        typeof OBSTACLE_OBJECT_TYPES !== 'undefined' &&
        OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) !== -1
    );
}


/*
 * Screeps calls module.exports.loop once every game tick.
 * A "tick" is one step of the simulation: creeps move once, spawns work once,
 * construction progresses, and your JavaScript runs from top to bottom.
 */
module.exports.loop = function () {

    /*
     * Cleanup runs before creep logic so stale shared routes do not keep getting
     * reused by roles later in this same tick.
     */
    travelUtility.cleanupRouteCaches();

        maybeGeneratePixel();
    /*
     * Automatic WarRoom radar only scans visible spawn rooms and their directly
     * adjacent rooms. This prevents far-away scouts or remote rooms from
     * pulling combat creeps across the map.
     *
     * Manual targetRoom and targetFlag orders still work when this scan is
     * disabled because combat roles read those assignments independently.
     */
    if (isWarRoomEnabled()) {
        WarRoom.run();
    }

    /*
     * RemotePlanner is intentionally light most ticks. Scouts do heavy refreshes
     * when they see rooms, and this run call mostly cleans stale assignments and
     * occasionally rescoring active candidates per owned room.
     */
    RemotePlanner.run();
    RoadPlanner.run();

    for (var towerRoomName in Game.rooms) {
        var towerRoom = Game.rooms[towerRoomName];

        if (towerRoom.controller && towerRoom.controller.my) {
            TowerLogic.run(towerRoom);
        }
    }


    for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];

    if (room.controller && room.controller.my && Game.time % 10 === 0) {
        updateRepairStructureMemory(room);
        /*
         * Road construction now belongs to Planner.Roads.js.   
         * The travel route cache remains enabled for movement/fallback only,
         * so creep-walked paths no longer become the main source of roads.
         */
        // travelUtility.buildRoadsFromRouteCache(room);
        }
    }
    /*
     * Game.rooms is a Screeps object containing only rooms you can currently see.
     * This loop asks the utility planner to check visible rooms every 10 ticks,
     * not every tick, because planning construction sites can use CPU.
     */
    for (var roomName in Game.rooms) {
    if (Game.time % 10 === 0) {
        /*
         * planSourceContainers(roomName) reads Memory.rooms[roomName].sources
         * and may write container planning data back into that room memory.
         */
       //utility.planSourceContainers(roomName);
    }}
    // Draw a flag on each source on the MAP.
    /*
     * Map visuals are temporary in Screeps. They disappear after the tick ends,
     * so this loop redraws source markers every tick for every visible room.
     */
    for (var roomName in Game.rooms) {
        utilityVisual.drawSourceFlags(roomName);
    }

    /*
     * Memory.creeps stores data by creep name and survives after a creep dies.
     * Game.creeps only contains living creeps right now.
     * If a name exists in Memory.creeps but not Game.creeps, the creep is dead,
     * so deleting that memory prevents old data from building up forever.
     */
    for(var name in Memory.creeps) {
        if(!Game.creeps[name]) {
            delete Memory.creeps[name];
            console.log('Clearing non-existing creep memory:', name);
        }
    }
    /*
     * Optional Season 10 expansion runs before normal spawn requests so it can
     * add Annex/Pioneer/SupplyRunner work to the origin room queue first.
     */
    if (Memory.settings && Memory.settings.season10ExpansionMode === true) {
        ExpansionLogic.run();
    }

    /*
     * Step 1:
     * Decide what the room needs.
     * This adds requests to Memory.rooms[roomName].spawnQueue.
     */
    var requestReport = spawnRequestManager.run();

    /*
     * Step 2:
     * Actually try to spawn from each owned spawn room's queue.
     */
    if (requestReport && requestReport.rooms) {
        for (var spawnRoomName in requestReport.rooms) {
            if (!requestReport.rooms.hasOwnProperty(spawnRoomName)) {
                continue;
            }

            spawnManager.runRoom(spawnRoomName);
        }
    }


    /*
     * Game.creeps contains every living creep you own, keyed by creep name.
     * This loop is the role dispatcher: it reads creep.memory.role and calls
     * the matching role module so each creep knows what behavior to run.
     */
    for(var name in Game.creeps) {
        var creep = Game.creeps[name];
        /*
         * Each if-statement checks one possible role name. The role names are
         * plain strings stored in creep memory when the creep is spawned.
         */
        if(creep.memory.role == 'ScoreRunner') {
            roleScoreRunner.run(creep);
            continue;
        }
        if(creep.memory.role == 'Tech') {
            roleTech.run(creep);
        }
        if(creep.memory.role == 'Foreman') {
            roleForeman.run(creep);
        }
        if(creep.memory.role == 'Extractor') {
            roleExtractor.run(creep);
        }
        if(creep.memory.role == 'Freighter') {
            roleFreighter.run(creep);
        }
        if(creep.memory.role == 'Annex') {
            roleAnnex.run(creep);
        }
        if(creep.memory.role == 'Artificer') {
            roleArtificer.run(creep);
        }
        if(creep.memory.role == 'Pioneer') {
            rolePioneer.run(creep);
        }
        if(creep.memory.role == 'SupplyRunner') {
            roleSupplyRunner.run(creep);
        }
        if(creep.memory.role == 'Scout') {
            roleScout.run(creep);
        }
        if(creep.memory.role == 'Ronin') {
            roleRonin.run(creep);
        }
        if(creep.memory.role == 'Volley') {
            roleVolley.run(creep);
        }
        if(creep.memory.role == 'Cleric') {
            roleCleric.run(creep);
        }
    }

    runTrafficManagerForVisibleRooms();
    Dashboard.run();
}
