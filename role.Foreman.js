var utility = require('utility');
var utilityCreep = require('utility.Creep');

var roleForeman = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        utility.scanRoom(creep);
        utility.createSourceFlagsFromMemory(creep);
        utilityCreep.updateWorkingState(creep, 'foremanWorking');

        if(creep.memory.foremanWorking) {
            utilityCreep.fillRoomEnergy(creep);
        } else {
            utilityCreep.collectEnergy(creep);
        }
    }
};

module.exports = roleForeman;
