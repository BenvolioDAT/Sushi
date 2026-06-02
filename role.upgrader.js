var creepUtility = require('utility.Creep');
var travel = require('utility.Travel.Creep');

var roleUpgrader = {
    run: function(creep) {
        if (creep.memory.upgrading && creepUtility.isEmpty(creep)) {
            creep.memory.upgrading = false;
        }

        if (!creep.memory.upgrading && creepUtility.isFull(creep)) {
            creep.memory.upgrading = true;
        }

        if (creep.memory.upgrading) {
            if (creep.room.controller) {
                if (creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
                    travel.move(creep, creep.room.controller, {
                        range: 3
                    });
                }
            }

            return;
        }

        creepUtility.getEnergy(creep);
    }
};

module.exports = roleUpgrader;