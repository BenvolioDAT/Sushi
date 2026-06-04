var creepUtility = require('utility.Creep');
var travel = require('utility.Travel.Creep');

var roleTech = {
    run: function(creep) {
        /*
         * Tech is the upgrader role. creep.memory.upgrading is its mode flag:
         * true means spend energy on the controller, false means collect energy.
         */
        if (creep.memory.upgrading && creepUtility.isEmpty(creep)) {
            creep.memory.upgrading = false;
        }

        /*
         * When the creep becomes full, switch to upgrade mode. The helper hides
         * the store-capacity check so this role stays easy to read.
         */
        if (!creep.memory.upgrading && creepUtility.isFull(creep)) {
            creep.memory.upgrading = true;
        }

        if (creep.memory.upgrading) {
            /*
             * creep.room.controller is the controller in the room the creep is
             * currently standing in. Some rooms may not have one, so check first.
             */
            if (creep.room.controller) {
                /*
                 * upgradeController returns ERR_NOT_IN_RANGE when the controller
                 * is valid but too far away. The travel wrapper moves to range 3,
                 * which is enough for controller upgrading.
                 */
                if (creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
                    travel.move(creep, creep.room.controller, {
                        range: 3
                    });
                }
            }

            return;
        }

        /*
         * Not upgrading means the Tech needs energy. getEnergy tries several
         * sources in order: dropped energy, tombstones, ruins, storage,
         * containers, and finally harvesting.
         */
        creepUtility.getEnergy(creep);
    }
};

module.exports = roleTech;
