var roleForeman = require('role.Foreman');
var roleExtractor = require('role.Extractor');
var roleTech = require('role.Tech');
var roleFreighter = require('role.Freighter');
var roleArtificer = require('role.Artificer');
var roleScout = require('role.Scout');

var utility_spawn = require('utility.spawn');
var utilityVisual = require('utility.Visual');
var utility = require('utility');

var spawnManager = require('spawn.manager');
var spawnRequestManager = require('spawn.request.manager');

module.exports.loop = function () {
    for (var roomName in Game.rooms) {
    if (Game.time % 10 === 0) {
        utility.planSourceContainers(roomName);
    }}
    // Draw a flag on each source on the MAP.
    for (var roomName in Game.rooms) {
        utilityVisual.drawSourceFlags(roomName);
    }

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
    var roomName = 'W1N1';

    spawnManager.requestRoleCount(
        roomName,
        'Veinseeker',
        4,
        [WORK, CARRY, MOVE],
        20
    );

    spawnManager.requestRoleCount(
        roomName,
        'Upgrader',
        2,
        [WORK, CARRY, MOVE],
        5
    );

    spawnManager.requestRoleCount(
        roomName,
        'Queen',
        1,
        [CARRY, CARRY, MOVE],
        30
    );

    spawnManager.requestRoleCount(
        roomName,
        'Trucker',
        2,
        [CARRY, MOVE],
        10
    );

    spawnManager.runRoom(roomName);
   /* 
    
    var upgrader = _.filter(Game.creeps, (creep) => creep.memory.role == 'Upgrader');
    //console.log('Upgrader:' + upgrader.length);

    var harvesters = _.filter(Game.creeps, (creep) => creep.memory.role == 'harvester');
    //console.log('Harvesters: ' + harvesters.length);

    if(harvesters.length < 4) {
        var newName = utility_spawn.genCreepName('Harvester');
        console.log('Spawning new harvester: ' + newName);
        Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, 
            {memory: {role: 'harvester'}});
    }
    
    else if(upgrader.length <4) {
        var newName = utility_spawn.genCreepName('Upgrader');
        console.log('Spawning new Upgrader: ' + newName);
        Game.spawns['Spawn1'].spawnCreep([WORK,CARRY,MOVE], newName, 
            {memory: {role: 'Upgrader'}});
    }
    
    if(Game.spawns['Spawn1'].spawning) { 
        var spawningCreep = Game.creeps[Game.spawns['Spawn1'].spawning.name];
        Game.spawns['Spawn1'].room.visual.text(
            '🛠️' + spawningCreep.memory.role,
            Game.spawns['Spawn1'].pos.x + 1, 
            Game.spawns['Spawn1'].pos.y, 
            {align: 'left', opacity: 0.8});
    }
*/

    for(var name in Game.creeps) {
        var creep = Game.creeps[name];
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