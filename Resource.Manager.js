const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const DemandBoard = require('Spawn.DemandBoard');
const Economy = require('HiveMind.Economy');
const Minerals = require('Resource.Minerals');
const Links = require('Resource.Links');
const Labs = require('Resource.Labs');
const Terminals = require('Resource.Terminals');
const Observers = require('Resource.Observer');
const Season11Adapter = require('Season11.Adapter');

function isDedicatedThorium(resourceType) {
    const thorium = Season11Adapter.resourceType();
    return Season11Adapter.isAvailable() && thorium !== null && resourceType === thorium;
}

function jobBoard() {
    if (!global.__sushiResourceJobs || global.__sushiResourceJobs.tick !== Game.time) {
        global.__sushiResourceJobs = { tick: Game.time, jobs: new Map() };
    }
    return global.__sushiResourceJobs;
}

function scheduleState() {
    const hive = HiveMemory.ensure();
    if (!global.__sushiResourceSchedule || global.__sushiResourceSchedule.hive !== hive ||
        global.__sushiResourceSchedule.lastTick > Game.time) {
        global.__sushiResourceSchedule = { hive, lastTick: Game.time, mineralPlanTick: -Infinity, courierDemandTick: {} };
    }
    global.__sushiResourceSchedule.lastTick = Game.time;
    return global.__sushiResourceSchedule;
}

function roomOffset(roomName, interval) {
    return String(roomName).split('').reduce((sum, character) => sum + character.charCodeAt(0), 0) % interval;
}

function addJobs(jobs) {
    const board = jobBoard();
    for (const job of jobs || []) {
        if (!job || !job.id || !job.sourceId || !job.targetId || job.amount <= 0) continue;
        if (isDedicatedThorium(job.resourceType)) continue;
        const existing = board.jobs.get(job.id);
        board.jobs.set(job.id, existing ? {
            ...existing, ...job,
            amount: Math.max(existing.amount || 0, job.amount || 0),
            priority: Math.max(existing.priority || 0, job.priority || 0)
        } : job);
    }
    return board;
}

function jobsForRoom(roomName) {
    return Array.from(jobBoard().jobs.values()).filter(job => job.roomName === roomName)
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

function currentReservations() {
    const reservations = new Map();
    for (const creep of TickIndex.get().creepsByRole.get('ResourceCourier') || []) {
        const id = creep.memory && creep.memory.resourceJobId;
        if (id) reservations.set(id, (reservations.get(id) || 0) + 1);
    }
    return reservations;
}

function getJobForCreep(creep) {
    if (!creep || !creep.memory) return null;
    const board = jobBoard();
    const remembered = creep.memory.resourceJobId && board.jobs.get(creep.memory.resourceJobId);
    if (remembered && remembered.roomName === creep.room.name && Game.getObjectById(remembered.sourceId) &&
        Game.getObjectById(remembered.targetId) && !isDedicatedThorium(remembered.resourceType)) return remembered;
    delete creep.memory.resourceJobId;
    const reservations = currentReservations();
    const selected = jobsForRoom(creep.room.name).find(job => !isDedicatedThorium(job.resourceType) &&
        (reservations.get(job.id) || 0) === 0 &&
        Game.getObjectById(job.sourceId) && Game.getObjectById(job.targetId)) || null;
    if (selected) creep.memory.resourceJobId = selected.id;
    return selected;
}

function clearJob(creep) {
    if (creep && creep.memory) delete creep.memory.resourceJobId;
}

function hasRequirements(requirements) {
    return Object.values(requirements || {}).some(list => Array.isArray(list) && list.length > 0);
}

function syncBoostRequests() {
    const hive = HiveMemory.ensure();
    for (const squad of Object.values(hive.squads)) {
        if (!squad || ['COMPLETE', 'ABORTED'].includes(squad.state) || !hasRequirements(squad.boostRequirements)) continue;
        const roomName = squad.originRoom;
        if (!roomName) continue;
        const request = Labs.requestBoost(squad.id, roomName, squad.boostRequirements, {
            priority: 90,
            acceptPartial: squad.acceptPartialBoosts
        });
        const compounds = Object.values(request.requirements).flat().map(item => item.compound);
        const room = Game.rooms[roomName];
        if (!room) continue;
        for (const compound of compounds) {
            const localAmount = Labs.amount(room.storage && room.storage.store, compound) +
                Labs.amount(room.terminal && room.terminal.store, compound);
            if (localAmount > 0) continue;
            const donor = TickIndex.get().ownedRooms.filter(candidate => candidate.name !== roomName && candidate.terminal &&
                Labs.amount(candidate.terminal.store, compound) >= 100)
                .sort((a, b) => Labs.amount(b.terminal.store, compound) - Labs.amount(a.terminal.store, compound) ||
                    a.name.localeCompare(b.name))[0];
            if (donor && room.terminal) {
                Terminals.requestTransfer({
                    fromRoom: donor.name,
                    toRoom: roomName,
                    resourceType: compound,
                    amount: Math.min(1000, Labs.amount(donor.terminal.store, compound)),
                    priority: 95,
                    validUntil: Game.time + 200,
                    reason: `Stage boost compound for ${squad.id}`
                });
                continue;
            }
            if (Labs.ingredientsFor(compound)) {
                Labs.configureReaction(roomName, compound, 1000, { priority: 90, operationId: squad.operationId });
                break;
            }
        }
    }
}

function needsCourier(roomName) {
    const hive = HiveMemory.ensure();
    const lab = hive.resources.labs[roomName];
    const mineral = hive.resources.rooms[roomName] && hive.resources.rooms[roomName].mineral;
    return !!(lab && (lab.state !== 'IDLE' || lab.reactionGoal) ||
        mineral && mineral.active && !isDedicatedThorium(mineral.mineralType));
}

function scrubGenericThoriumDemands() {
    if (!Season11Adapter.isAvailable()) return 0;
    const thorium = Season11Adapter.resourceType();
    let removed = 0;
    for (const demand of DemandBoard.getDemands()) {
        if (!demand || !['MineralMiner', 'ResourceCourier'].includes(demand.role)) continue;
        const memory = demand.memory || {};
        const mineralRoom = demand.operationId && demand.operationId.indexOf('mineral:') === 0;
        const roomName = demand.originRoom || demand.targetRoom;
        const saved = roomName && HiveMemory.ensure().resources.rooms[roomName];
        const savedMineral = saved && saved.mineral;
        const genericMineralDemand = mineralRoom && (memory.mineralType === thorium ||
            savedMineral && savedMineral.mineralType === thorium);
        const resourceOnlyCourier = demand.id === `resource:${roomName}:ResourceCourier` &&
            savedMineral && savedMineral.mineralType === thorium && !needsCourierWithoutMineral(roomName);
        if (memory.mineralType !== thorium && !genericMineralDemand && !resourceOnlyCourier) continue;
        if (DemandBoard.cancel(demand.id)) removed++;
    }
    return removed;
}

function needsCourierWithoutMineral(roomName) {
    const lab = HiveMemory.ensure().resources.labs[roomName];
    return !!(lab && (lab.state !== 'IDLE' || lab.reactionGoal));
}

function emitCourierDemand(roomName) {
    if (!needsCourier(roomName)) return null;
    return DemandBoard.emit({
        id: `resource:${roomName}:ResourceCourier`,
        operationId: `resource:${roomName}`,
        role: 'ResourceCourier',
        count: 1,
        priority: 48,
        originRoom: roomName,
        preferredSpawnRoom: roomName,
        targetRoom: roomName,
        replacementBuffer: 60,
        validUntil: Game.time + 30,
        reason: 'Lab, boost, terminal, and mineral logistics'
    });
}

function plan() {
    const settings = HiveMemory.getConfig('resources');
    scrubGenericThoriumDemands();
    if (settings.enabled === false) return { enabled: false };
    syncBoostRequests();
    const schedule = scheduleState();
    let minerals = [];
    if (settings.minerals !== false && Game.time - schedule.mineralPlanTick >= 11) {
        minerals = Minerals.plan();
        schedule.mineralPlanTick = Game.time;
    }
    for (const room of TickIndex.get().ownedRooms) {
        if (!Economy.canSpend(room, 'resources')) continue;
        if (needsCourier(room.name) && Game.time - (schedule.courierDemandTick[room.name] ?? -Infinity) >= 10) {
            emitCourierDemand(room.name);
            schedule.courierDemandTick[room.name] = Game.time;
        }
    }
    return { enabled: true, minerals };
}

function runRoom(room) {
    const settings = HiveMemory.getConfig('resources');
    if (settings.enabled === false) return { roomName: room.name, disabled: true };
    const discretionary = Economy.canSpend(room, 'resources');
    const report = { roomName: room.name, links: null, labs: null, observer: null, jobs: [], economyBlocked: !discretionary };
    if (settings.links !== false) report.links = Links.run(room);
    const savedMineral = HiveMemory.ensure().resources.rooms[room.name];
    const shouldObserveMineral = settings.minerals !== false &&
        (!savedMineral || !savedMineral.mineral || (Game.time + roomOffset(room.name, 10)) % 10 === 0);
    const mineralState = settings.minerals !== false ?
        (shouldObserveMineral ? Minerals.observe(room) : savedMineral) : null;
    addJobs(discretionary && settings.minerals !== false ? Minerals.jobs(room, mineralState) : []);
    const labState = HiveMemory.ensure().resources.labs[room.name];
    const labActive = labState && (labState.state !== 'IDLE' || labState.reactionGoal);
    if (discretionary && settings.labs !== false && (labActive || (Game.time + roomOffset(room.name, 5)) % 5 === 0)) {
        report.labs = Labs.run(room);
        addJobs(report.labs.jobs);
    }
    if (settings.observers !== false) {
        const byType = TickIndex.get().structuresByRoom.get(room.name);
        const observer = byType && (byType.get(STRUCTURE_OBSERVER) || [])[0];
        if (observer) report.observer = Observers.run(observer);
    }
    report.jobs = jobsForRoom(room.name).map(job => ({ ...job }));
    return report;
}

function runEmpireStructures() {
    const settings = HiveMemory.getConfig('resources');
    if (settings.enabled === false || settings.terminals === false || Game.time % 10 !== 0) return [];
    return Terminals.run();
}

module.exports = {
    plan,
    runRoom,
    runEmpireStructures,
    addJobs,
    jobsForRoom,
    getJobForCreep,
    clearJob,
    syncBoostRequests,
    emitCourierDemand,
    scrubGenericThoriumDemands
};
