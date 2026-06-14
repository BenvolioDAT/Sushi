/*
 * Logic.Quad.js
 *
 * First testing version of a four-creep ranged/heal squad. Each creep keeps a
 * fixed slot near the Attack flag, heals nearby allies, and shoots targets that
 * enter ranged-attack distance. Advanced synchronized quad pathing can be
 * added later without changing the old Ronin, Volley, or Cleric roles.
 */

var travel = require('utility.Travel.Creep');

var QUAD_ID = 'Alpha';
var DEFAULT_FLAG_NAME = 'Attack';

function ensureQuadMemory(creep, flag) {
    Memory.quads = Memory.quads || {};
    Memory.quads[QUAD_ID] = Memory.quads[QUAD_ID] || {
        quadId: QUAD_ID,
        targetFlagName: DEFAULT_FLAG_NAME,
        stage: 'testing'
    };

    Memory.quads[QUAD_ID].lastSeen = Game.time;
    Memory.quads[QUAD_ID].homeRoom = creep.memory.homeRoom;

    if (flag) {
        Memory.quads[QUAD_ID].targetRoom = flag.pos.roomName;
    } else {
        delete Memory.quads[QUAD_ID].targetRoom;
    }
}

function getMissingHits(creep) {
    return creep.hitsMax - creep.hits;
}

/*
 * Healing is chosen before combat. Self-heal protects this creep's HEAL part;
 * otherwise the most damaged nearby Alpha member gets first attention.
 */
function healNearby(creep) {
    if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
        return true;
    }

    var nearbyFriends = creep.room.find(FIND_MY_CREEPS, {
        filter: function(friend) {
            return friend.id !== creep.id &&
                friend.hits < friend.hitsMax &&
                creep.pos.inRangeTo(friend, 3);
        }
    });
    var quadFriends = nearbyFriends.filter(function(friend) {
        return friend.memory &&
            friend.memory.role === 'Quad' &&
            friend.memory.quadId === creep.memory.quadId;
    });
    var candidates = quadFriends.length > 0 ? quadFriends : nearbyFriends;

    if (candidates.length === 0) {
        return false;
    }

    candidates.sort(function(a, b) {
        return getMissingHits(b) - getMissingHits(a);
    });

    var target = candidates[0];

    if (creep.pos.isNearTo(target)) {
        creep.heal(target);
    } else {
        creep.rangedHeal(target);
    }

    return true;
}

function getCombatPartScore(hostile) {
    if (!hostile || typeof hostile.getActiveBodyparts !== 'function') {
        return 0;
    }

    return hostile.getActiveBodyparts(HEAL) * 3 +
        hostile.getActiveBodyparts(RANGED_ATTACK) * 2 +
        hostile.getActiveBodyparts(ATTACK) * 2;
}

function findBestHostile(creep, hostiles) {
    hostiles.sort(function(a, b) {
        var scoreDifference = getCombatPartScore(b) - getCombatPartScore(a);

        if (scoreDifference !== 0) {
            return scoreDifference;
        }

        return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
    });

    return hostiles[0];
}

function attackNearby(creep) {
    var hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: function(hostile) {
            return creep.pos.inRangeTo(hostile, 3);
        }
    });

    if (hostiles.length > 0) {
        var adjacentCount = 0;

        for (var index = 0; index < hostiles.length; index++) {
            if (creep.pos.isNearTo(hostiles[index])) {
                adjacentCount++;
            }
        }

        /* Mass attack is worthwhile against a cluster, especially up close. */
        if (adjacentCount >= 2 || hostiles.length >= 3) {
            creep.rangedMassAttack();
        } else {
            creep.rangedAttack(findBestHostile(creep, hostiles));
        }

        return true;
    }

    var structures = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType !== STRUCTURE_CONTROLLER &&
                creep.pos.inRangeTo(structure, 3);
        }
    });

    if (structures.length > 0) {
        creep.rangedAttack(creep.pos.findClosestByRange(structures));
        return true;
    }

    return false;
}

function isPassableFormationTile(room, x, y) {
    /* Avoid exits and coordinates outside the usable room interior. */
    if (x < 1 || x > 48 || y < 1 || y > 48) {
        return false;
    }

    if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) {
        return false;
    }

    var structures = room.lookForAt(LOOK_STRUCTURES, x, y);

    for (var index = 0; index < structures.length; index++) {
        var structure = structures[index];

        if (
            structure.structureType === STRUCTURE_ROAD ||
            structure.structureType === STRUCTURE_CONTAINER ||
            (
                structure.structureType === STRUCTURE_RAMPART &&
                (structure.my || structure.isPublic)
            )
        ) {
            continue;
        }

        return false;
    }

    return true;
}

function getSlotPosition(creep, flag) {
    var slot = Number(creep.memory.quadSlot);
    var offsets = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 }
    ];

    if (slot < 0 || slot > 3 || Math.floor(slot) !== slot) {
        return null;
    }

    var x = flag.pos.x + offsets[slot].x;
    var y = flag.pos.y + offsets[slot].y;

    if (!isPassableFormationTile(creep.room, x, y)) {
        return null;
    }

    return new RoomPosition(x, y, flag.pos.roomName);
}

function findCatchUpTarget(creep, flag) {
    var members = creep.room.find(FIND_MY_CREEPS, {
        filter: function(member) {
            return member.id !== creep.id &&
                member.memory &&
                member.memory.role === 'Quad' &&
                member.memory.quadId === creep.memory.quadId;
        }
    });

    if (members.length === 0) {
        return null;
    }

    var closest = creep.pos.findClosestByRange(members);

    /* Only a member already closer to the flag should lead a lagging creep. */
    if (
        closest &&
        creep.pos.getRangeTo(closest) > 4 &&
        closest.pos.getRangeTo(flag) < creep.pos.getRangeTo(flag)
    ) {
        return closest;
    }

    return null;
}

function moveWithFlag(creep, flag) {
    if (creep.room.name !== flag.pos.roomName) {
        travel.moveToRoom(creep, flag.pos.roomName, {
            range: 22,
            reusePath: 20,
            visualizePathStyle: { stroke: '#cc66ff' }
        });
        return;
    }

    var catchUpTarget = findCatchUpTarget(creep, flag);

    if (catchUpTarget) {
        travel.move(creep, catchUpTarget, {
            range: 2,
            reusePath: 5,
            visualizePathStyle: { stroke: '#cc66ff' }
        });
        return;
    }

    var slotPosition = getSlotPosition(creep, flag);

    if (slotPosition) {
        travel.move(creep, slotPosition, {
            range: 0,
            reusePath: 5,
            disableSharedRouteCache: true,
            visualizePathStyle: { stroke: '#cc66ff' }
        });
        return;
    }

    /* A wall, obstacle, or edge can invalidate a slot; stay near the flag. */
    travel.move(creep, flag, {
        range: 3,
        reusePath: 5,
        visualizePathStyle: { stroke: '#cc66ff' }
    });
}

function idleWithoutFlag(creep) {
    var homeRoom = creep.memory.homeRoom;

    if (homeRoom && creep.room.name !== homeRoom) {
        travel.moveToRoom(creep, homeRoom, {
            range: 22,
            reusePath: 20,
            visualizePathStyle: { stroke: '#66ccff' }
        });
        return;
    }

    /* In the home room, wait near a spawn (or the controller as a fallback). */
    var spawns = creep.room.find(FIND_MY_SPAWNS);
    var idleTarget = spawns.length > 0 ? spawns[0] : creep.room.controller;

    if (idleTarget && !creep.pos.inRangeTo(idleTarget, 3)) {
        travel.move(creep, idleTarget, {
            range: 3,
            reusePath: 10,
            visualizePathStyle: { stroke: '#66ccff' }
        });
    }
}

function drawDebug(creep, flag) {
    creep.room.visual.text('Q' + creep.memory.quadSlot, creep.pos.x, creep.pos.y - 0.6, {
        color: '#ff99ff',
        font: 0.5,
        stroke: '#000000',
        strokeWidth: 0.15
    });

    if (flag && flag.pos.roomName === creep.room.name) {
        creep.room.visual.line(creep.pos, flag.pos, {
            color: '#cc66ff',
            opacity: 0.25,
            width: 0.05
        });
    }
}

module.exports = {
    run: function(creep) {
        if (!creep || creep.spawning) {
            return;
        }

        creep.memory.quadId = creep.memory.quadId || QUAD_ID;
        creep.memory.targetFlagName = creep.memory.targetFlagName || DEFAULT_FLAG_NAME;

        var flag = Game.flags && Game.flags[creep.memory.targetFlagName];

        ensureQuadMemory(creep, flag);
        healNearby(creep);
        drawDebug(creep, flag);

        if (!flag) {
            idleWithoutFlag(creep);
            return;
        }

        attackNearby(creep);
        moveWithFlag(creep, flag);
    }
};
