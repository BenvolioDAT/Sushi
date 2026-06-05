var roleForeman = require('role.Foreman');
var roleExtractor = require('role.Extractor');
var roleTech = require('role.Tech');
var roleFreighter = require('role.Freighter');
var roleArtificer = require('role.Artificer');
var roleScout = require('role.Scout');

var utility_spawn = require('utility.spawn');
var utilityVisual = require('utility.Visual');
var utility = require('utility');

var TowerLogic = require('Logic.Tower');

var spawnManager = require('spawn.manager');
var spawnRequestManager = require('spawn.request.manager');

/*
 * Screeps calls module.exports.loop once every game tick.
 * A "tick" is one step of the simulation: creeps move once, spawns work once,
 * construction progresses, and your JavaScript runs from top to bottom.
 */
module.exports.loop = function () {
    for (const room of Object.values(Game.rooms)) {
    if (room.controller && room.controller.my) {
        TowerLogic.run(room);
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
        utility.planSourceContainers(roomName);
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
     * Step 1:
     * Decide what the room needs.
     * This adds requests to Memory.rooms[roomName].spawnQueue.
     */
    var requestReport = spawnRequestManager.run();

    /*
     * Step 2:
     * Actually try to spawn from the queue.
     */
    if (requestReport && requestReport.roomName) {
        spawnManager.runRoom(requestReport.roomName);
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
        if(creep.memory.role == 'Artificer') {
            roleArtificer.run(creep);
        }
        if(creep.memory.role == 'Scout') {
            roleScout.run(creep);
        }
    }
}
