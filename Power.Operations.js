const HiveMemory = require('HiveMind.Memory');
const DemandBoard = require('Spawn.DemandBoard');
const Economy = require('HiveMind.Economy');
const Intel = require('Power.Intel');

function config() { return HiveMemory.getConfig('power'); }

function evaluate(bank, options = {}) {
    const settings = { ...config().banks, ...options };
    const travelTicks = Math.max(0, Number(bank.routeDistance) || 0) * (settings.ticksPerRoom || 50);
    const spawnTicks = settings.assemblyTicks || 150;
    const reserve = settings.decayReserve || 100;
    const availableAttackTicks = Math.max(0, (bank.ticksToDecay || 0) - travelTicks - spawnTicks - reserve);
    const attackerDps = Math.max(1, settings.attackerDps || 180);
    const maximumAttackers = Math.max(1, settings.maxAttackers || 4);
    const attackers = availableAttackTicks > 0 ? Math.ceil((bank.hits || 0) / availableAttackTicks / attackerDps) : Infinity;
    const attackDps = Number.isFinite(attackers) ? attackers * attackerDps : 0;
    const killTicks = attackDps > 0 ? Math.ceil((bank.hits || 0) / attackDps) : Infinity;
    const carryCapacity = Math.max(50, settings.haulerCapacity || 800);
    const haulers = Math.ceil(Math.max(0, bank.power || 0) / carryCapacity);
    const reflectedDamage = attackDps * 0.5;
    const healingRequired = Math.ceil(reflectedDamage / Math.max(1, settings.healerPower || 36));
    let reason = null;
    if ((bank.power || 0) < (settings.minimumPower || 2500)) reason = 'POWER_BELOW_THRESHOLD';
    else if (!bank.homeRoom || !Number.isFinite(bank.routeDistance)) reason = 'NO_REACHABLE_HOME';
    else if (bank.routeDistance > (settings.maximumRouteRooms || 6)) reason = 'ROUTE_TOO_FAR';
    else if (bank.threat && bank.threat.hostileCreeps > (settings.maximumHostiles || 0)) reason = 'PLAYER_OR_CREEP_THREAT';
    else if (!Number.isFinite(attackers) || attackers > maximumAttackers) reason = 'CANNOT_KILL_BEFORE_DECAY';
    else if (healingRequired > (settings.maxHealers || 3)) reason = 'REFLECTED_DAMAGE_TOO_HIGH';
    return {
        viable: !reason, reason, attackers: Number.isFinite(attackers) ? attackers : 0,
        healers: Number.isFinite(attackers) ? healingRequired : 0,
        haulers, attackDps, killTicks, travelTicks, spawnTicks, availableAttackTicks,
        reflectedDamage, haulCapacity: haulers * carryCapacity,
        haulerDispatchIn: Math.max(0, killTicks - travelTicks - (settings.haulerArrivalMargin || 50))
    };
}

function operationFor(bank) {
    const power = Intel.state();
    return power.operations[bank.id] || (power.operations[bank.id] = {
        id: `power-bank:${bank.id}`, bankId: bank.id, state: 'DISCOVERED', createdAt: Game.time
    });
}

function countAssigned(operationId, role) {
    let count = 0;
    for (const creep of Object.values(Game.creeps || {})) {
        if (creep.memory && creep.memory.powerBankOperationId === operationId && creep.memory.role === role) count++;
    }
    return count;
}

function sync(bank) {
    const operation = operationFor(bank);
    if (operation.state === 'COMPLETE') return operation;
    operation.updatedAt = Game.time;
    operation.roomName = bank.roomName;
    operation.originRoom = bank.homeRoom;
    operation.viability = evaluate(bank);
    if (!operation.viability.viable) {
        operation.state = 'REJECTED';
        operation.reason = operation.viability.reason;
        return operation;
    }
    operation.recoveryTarget = Math.max(operation.recoveryTarget || 0, bank.power || 0);
    if (!Economy.canSpend(bank.homeRoom, 'combat')) {
        operation.state = 'EVALUATING';
        operation.reason = 'HOME_ECONOMY_BLOCKED';
        return operation;
    }
    const object = typeof Game.getObjectById === 'function' ? Game.getObjectById(bank.id) : null;
    const attackers = countAssigned(operation.id, 'Ronin');
    const healers = countAssigned(operation.id, 'Cleric');
    const haulers = countAssigned(operation.id, 'ResourceCourier');
    if (!object && bank.lastSeen === Game.time) operation.state = haulers ? 'LOOTING' : 'HAULERS_INBOUND';
    else if (attackers < operation.viability.attackers || healers < operation.viability.healers) operation.state = 'ASSEMBLING';
    else if (object && object.hits > 0 && Object.values(Game.creeps || {}).some(creep =>
        creep.memory && creep.memory.powerBankOperationId === operation.id && creep.room && creep.room.name !== bank.roomName)) {
        operation.state = 'TRAVELING';
    }
    else if (object && object.hits > 0) operation.state = 'ATTACKING';
    else operation.state = 'HAULERS_INBOUND';
    DemandBoard.emit({
        id: `${operation.id}:attackers`, operationId: operation.id, role: 'Ronin',
        count: operation.viability.attackers, priority: 78, originRoom: bank.homeRoom,
        economyCategory: 'combat',
        targetRoom: bank.roomName, validUntil: Game.time + 30, replacementBuffer: 0,
        memory: { powerBankOperationId: operation.id, powerBankId: bank.id },
        reason: 'Viable Power Bank operation'
    });
    DemandBoard.emit({
        id: `${operation.id}:healers`, operationId: operation.id, role: 'Cleric',
        count: operation.viability.healers, priority: 79, originRoom: bank.homeRoom,
        economyCategory: 'combat',
        targetRoom: bank.roomName, validUntil: Game.time + 30, replacementBuffer: 0,
        memory: { powerBankOperationId: operation.id, powerBankId: bank.id },
        reason: 'Heal reflected Power Bank damage'
    });
    const dispatchHaulers = operation.viability.haulerDispatchIn <= 25 || !object ||
        object.hits <= operation.viability.attackDps * (operation.viability.travelTicks + 75);
    if (dispatchHaulers) DemandBoard.emit({
        id: `${operation.id}:haulers`, operationId: operation.id, role: 'ResourceCourier',
        count: operation.viability.haulers, priority: 77, originRoom: bank.homeRoom,
        economyCategory: 'resources',
        targetRoom: bank.roomName, validUntil: Game.time + 30, replacementBuffer: 0,
        memory: { powerBankOperationId: operation.id, powerBankId: bank.id, powerBankHomeRoom: bank.homeRoom },
        reason: 'Arrive shortly before Power Bank destruction'
    });
    return operation;
}

function run() {
    const settings = config();
    if (settings.enabled === false || settings.banks.enabled === false) return { enabled: false };
    const banks = Object.values(Intel.state().banks).sort((a, b) => (b.power || 0) - (a.power || 0));
    const limit = Math.max(1, settings.banks.maxEvaluations || 3);
    return { enabled: true, operations: banks.slice(0, limit).map(sync) };
}

module.exports = { evaluate, operationFor, sync, run };
