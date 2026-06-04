var utility = require('utility');
var utilityCreep = require('utility.Creep');

var roleForeman = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Foreman is the base energy filler. It should only run when the creep
         * exists and is fully spawned onto the map.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * The Foreman doubles as early room setup support:
         * - scanRoom records source/controller/mineral data in Memory.rooms.
         * - createSourceFlagsFromMemory uses that memory to create source flags.
         */
        utility.scanRoom(creep);
        utility.createSourceFlagsFromMemory(creep);
        /*
         * foremanWorking is stored in creep.memory. The shared helper switches
         * it off when empty and on when full, creating a simple two-state job.
         */
        utilityCreep.updateWorkingState(creep, 'foremanWorking');

        /*
         * Working mode means "spend carried energy on the room."
         * Non-working mode means "go collect energy first."
         */
        if(creep.memory.foremanWorking) {
            utilityCreep.fillRoomEnergy(creep);
        } else {
            utilityCreep.collectEnergy(creep);
        }
    }
};

module.exports = roleForeman;
