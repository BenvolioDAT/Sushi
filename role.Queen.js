var utility = require('utility');
var utilityCreep = require('utility.Creep');

var roleQueen = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        utility.scanRoom(creep);
        utility.createSourceFlagsFromMemory(creep);
        utilityCreep.updateWorkingState(creep, 'queenWorking');

        if(creep.memory.queenWorking) {
            utilityCreep.fillRoomEnergy(creep);
        } else {
            utilityCreep.collectEnergy(creep);
        }
    }
};

module.exports = roleQueen;
