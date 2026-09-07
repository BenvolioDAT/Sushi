const HiveMemory = require('HiveMind.Memory');
const CombatMath = require('Combat.Math');
const travel = require('utility.Travel.Creep');

function run(creep) {
    if (!creep || creep.spawning || !creep.memory.operationId) return;
    const operation = HiveMemory.ensure().operations[creep.memory.operationId];
    if (!operation || operation.type !== 'CLEAR_NPC_STRONGHOLD' || operation.policyApproved !== true) return;
    const target = operation.targetId && Game.getObjectById(operation.targetId);
    if (!target || !target.pos) return;
    const squad = (operation.assignedSquads || []).map(id => HiveMemory.ensure().squads[id]).find(Boolean);
    const cover = squad && squad.leader && Game.creeps[squad.leader];
    if (cover && cover.room.name === creep.room.name && CombatMath.rangeBetween(creep, cover) > 2) {
        travel.move(creep, cover, { range: 2, reusePath: 2, trafficPriority: 96, squadId: squad.id, operationId: operation.id });
        return;
    }
    if (creep.room.name !== target.pos.roomName) {
        travel.moveToRoom(creep, target.pos.roomName, { range: 1, trafficPriority: 96, operationId: operation.id });
        return;
    }
    if (creep.pos.getRangeTo(target.pos) > 1) travel.move(creep, target, { range: 1, reusePath: 2, trafficPriority: 96, operationId: operation.id });
    else if (typeof creep.dismantle === 'function' && target.structureType !== 'invaderCore') creep.dismantle(target);
}

module.exports = { run };
