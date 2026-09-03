/*
 * role.Artificer.js
 *
 * Builder role with limited repair duty.
 *
 * Artificers normally build construction sites, then upgrade the controller.
 * When the room has repair work, only MAX_REPAIR_ARTIFICERS are allowed to
 * claim repair targets. That cap prevents every builder from abandoning
 * construction because one road is damaged.
 */
var creepUtility = require('utility.Creep');
var utilityTravelCreep = require('utility.Travel.Creep');
var Economy = require('HiveMind.Economy');
var HiveMemory = require('HiveMind.Memory');
var ColonyState = require('HiveMind.ColonyState');
var roleTech = require('role.Tech');

var MAX_REPAIR_ARTIFICERS = 2;

var REPAIR_LIST_MEMORY_KEY = 'RepairStructure';
var REPAIR_WORKERS_MEMORY_KEY = 'ArtificerRepairWorkers';
var REPAIR_CLAIMS_MEMORY_KEY = 'ArtificerRepairClaims';

var REPAIR_WORKER_STALE_TICKS = 25;

var REMOTE_ROAD_REPAIR_START_PERCENT = 0.60;
var REMOTE_CONTAINER_REPAIR_START_PERCENT = 0.80;
var REMOTE_WORK_EMPTY_SCAN_COOLDOWN = 15;

/* Small energy amounts remain fallbacks, but larger refills are tried first. */
var MIN_USEFUL_ENERGY_AMOUNT = 50;
var HEALTHY_SPAWN_FILL = 0.50;
var CONTROLLER_DANGER_TICKS = 5000;
var BUILD_REACHABLE_CACHE_TTL = 25;
var BUILD_UNREACHABLE_CACHE_TTL = 5;

/*
 * Higher priority structures are chosen before lower priority structures.
 * Assignment statements keep Screeps structure constants safe as object keys.
 */
var STRUCTURE_BUILD_PRIORITY = {};
STRUCTURE_BUILD_PRIORITY[STRUCTURE_SPAWN] = 100;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_EXTENSION] = 90;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_TOWER] = 85;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_STORAGE] = 80;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_CONTAINER] = 70;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_LINK] = 65;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_TERMINAL] = 60;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_ROAD] = 30;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_RAMPART] = 20;
STRUCTURE_BUILD_PRIORITY[STRUCTURE_WALL] = 10;

var roleArtificer = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        var homeRoomName = creep.memory.homeRoom || creep.room.name;
        if(creep.memory.season11Maintenance && !getSeason11OperationMaintenanceTarget(creep)) {
            clearRemoteWorkTarget(creep);
            clearSeason11MaintenanceAssignment(creep);
        }
        var spend = getSpendingPolicy(creep, homeRoomName);
        getRememberedBuildTarget(creep, spend);

        if (!spend.remote) {
            clearRemoteWorkTarget(creep);
            if(creep.room.name !== homeRoomName) {
                setTask(creep, 'IDLE', 'remote spending blocked; returning home');
                utilityTravelCreep.moveToRoom(creep, homeRoomName, {
                    range: 22,
                    visualizePathStyle: {stroke: '#bbbbbb'}
                });
                return;
            }
        }

        setupRepairMemory(creep.room);
        cleanRepairMemory(creep.room);

        updateWorkingState(creep);

        if(!hasRepairWork(creep.room)) {
            clearRepairDuty(creep);
        }

        if(creep.memory.builderWorking) {
            runPermittedWork(creep, spend);
        } else {
            collectForNextTask(creep, spend);
        }
    }
};

function updateWorkingState(creep) {
    if(creep.memory.builderWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.builderWorking = false;
    }

    if(!creep.memory.builderWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.builderWorking = true;
    }
}

function runPermittedWork(creep, spend) {
    if(spend.emergencyFill) {
        setTask(creep, 'EMERGENCY_FILL', 'economy collapse; refill spawn energy', null);
        creepUtility.transferEnergy(creep, spend.emergencyFillTarget);
        return;
    }

    if(spend.criticalMaintenance && tryRepairWork(creep, true)) {
        setTask(creep, 'CRITICAL_REPAIR', 'critical maintenance permitted', 'criticalMaintenance');
        return;
    }

    if(spend.criticalInfrastructure && buildLocalConstruction(creep, true)) {
        setTask(creep, 'BUILD_LOCAL', 'critical local construction permitted', 'criticalInfrastructure');
        return;
    }

    if(spend.construction && tryRepairWork(creep, false)) {
        setTask(creep, 'REPAIR', 'normal maintenance permitted', 'construction');
        return;
    }

    if(spend.construction && buildLocalConstruction(creep)) {
        setTask(creep, 'BUILD_LOCAL', 'important local construction available', 'construction');
        return;
    }

    if(spend.remote && doRemoteInfrastructureWork(creep)) {
        setTask(creep, 'BUILD_REMOTE', 'remote infrastructure permitted', 'remote');
        return;
    }

    var upgradePolicy = getControllerUpgradePolicy(creep, spend);
    if(upgradePolicy.allowed) {
        setTask(creep, 'UPGRADE_FALLBACK', upgradePolicy.reason, null);
        upgradeController(creep);
        return;
    }

    setTask(creep, 'IDLE', upgradePolicy.reason || 'no permitted work', null);
    idleNearBase(creep);
}

function collectForNextTask(creep, spend) {
    var nextTask = chooseNextTask(creep, spend);

    if(nextTask.name === 'IDLE') {
        setTask(creep, 'IDLE', 'no permitted work or energy use', null);
        idleNearBase(creep);
        return;
    }

    creep.memory.artificerNextTask = nextTask.name;
    setTask(creep, 'COLLECT', 'for ' + nextTask.name, nextTask.category);

    if(nextTask.name === 'UPGRADE_FALLBACK') {
        roleTech.getEnergyForTech(creep);
        return;
    }

    collectEnergyForArtificer(creep);
}

function chooseNextTask(creep, spend) {
    if(spend.emergencyFill) return {name: 'EMERGENCY_FILL', category: null};
    if(spend.criticalMaintenance && hasRepairWork(creep.room, true)) {
        return {name: 'CRITICAL_REPAIR', category: 'criticalMaintenance'};
    }
    if(spend.criticalInfrastructure && hasLocalConstructionWork(creep, true)) {
        return {name: 'BUILD_LOCAL', category: 'criticalInfrastructure'};
    }
    if(spend.construction && hasRepairWork(creep.room, false)) {
        return {name: 'REPAIR', category: 'construction'};
    }
    if(spend.construction && hasLocalConstructionWork(creep)) {
        return {name: 'BUILD_LOCAL', category: 'construction'};
    }
    if(spend.remote && (getRememberedRemoteWorkTarget(creep) || findRemoteInfrastructureTarget(creep))) {
        return {name: 'BUILD_REMOTE', category: 'remote'};
    }
    var upgradePolicy = getControllerUpgradePolicy(creep, spend);
    if(upgradePolicy.allowed) return {name: 'UPGRADE_FALLBACK', category: null};
    return {name: 'IDLE', category: null};
}

function setTask(creep, task, reason, category) {
    creep.memory.artificerTask = task;
    creep.memory.artificerReason = reason;
    creep.memory.artificerDiagnostic = 'Artificer: ' + task + ' — ' + reason;
    if(category) creep.memory.artificerWorkCategory = category;
    else delete creep.memory.artificerWorkCategory;
    if(task !== 'COLLECT') delete creep.memory.artificerNextTask;
}

function getSpendingPolicy(creep, homeRoomName) {
    var economy = Economy.get(homeRoomName);
    var survival = economy && economy.state === Economy.STATES.SURVIVAL;
    var spawnFill = economy && typeof economy.spawnFill === 'number' ? economy.spawnFill :
        creep.room.energyCapacityAvailable > 0 ? creep.room.energyAvailable / creep.room.energyCapacityAvailable : 1;
    var emergencyFillTarget = survival && spawnFill < HEALTHY_SPAWN_FILL ?
        creepUtility.findClosestSpawnOrExtensionNeedingEnergy(creep) : null;
    return {
        economy: economy,
        emergencyFill: !!emergencyFillTarget,
        emergencyFillTarget: emergencyFillTarget,
        criticalMaintenance: Economy.canSpend(homeRoomName, 'criticalMaintenance'),
        criticalInfrastructure: Economy.canSpend(homeRoomName, 'criticalInfrastructure'),
        construction: Economy.canSpend(homeRoomName, 'construction'),
        remote: Economy.canSpend(homeRoomName, 'remote')
    };
}

function tryRepairWork(creep, criticalOnly) {
    if(!hasRepairWork(creep.room, criticalOnly)) return false;
    if(!claimRepairWorkerSlot(creep)) return false;
    return repairClaimedTarget(creep, criticalOnly);
}

function setupRepairMemory(room) {
    /*
     * This function creates the Memory buckets used by the repair-claim system.
     *
     * RepairStructure:
     * - shared list of damaged structure ids, written by main.js.
     *
     * ArtificerRepairWorkers:
     * - map of creepName -> last tick seen as an active repair worker.
     *
     * ArtificerRepairClaims:
     * - map of targetId -> creepName so two Artificers do not choose the same
     *   damaged structure unless the old claim expires.
     */
    if(!Memory.rooms) {
        Memory.rooms = {};
    }

    if(!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }

    if(!Memory.rooms[room.name][REPAIR_LIST_MEMORY_KEY]) {
        Memory.rooms[room.name][REPAIR_LIST_MEMORY_KEY] = [];
    }

    if(!Memory.rooms[room.name][REPAIR_WORKERS_MEMORY_KEY]) {
        Memory.rooms[room.name][REPAIR_WORKERS_MEMORY_KEY] = {};
    }

    if(!Memory.rooms[room.name][REPAIR_CLAIMS_MEMORY_KEY]) {
        Memory.rooms[room.name][REPAIR_CLAIMS_MEMORY_KEY] = {};
    }
}

function cleanRepairMemory(room) {
    var roomMemory = Memory.rooms[room.name];
    var workers = roomMemory[REPAIR_WORKERS_MEMORY_KEY];
    var claims = roomMemory[REPAIR_CLAIMS_MEMORY_KEY];

    var creepName;

    /*
     * Remove dead or stale repair workers. Staleness matters because a creep can
     * switch jobs or stop running this branch without dying; after enough ticks,
     * another Artificer should be allowed to take that repair slot.
     */
    for(creepName in workers) {
        if(!workers.hasOwnProperty(creepName)) {
            continue;
        }

        if(!Game.creeps[creepName]) {
            delete workers[creepName];
            continue;
        }

        if(Game.time - workers[creepName] > REPAIR_WORKER_STALE_TICKS) {
            delete workers[creepName];
        }
    }

    /*
     * Remove bad target claims. A claim is bad if the creep died, the target is
     * gone, the structure no longer needs repair, or the creep no longer owns a
     * live repair-worker slot.
     */
    for(var targetId in claims) {
        if(!claims.hasOwnProperty(targetId)) {
            continue;
        }

        creepName = claims[targetId];

        var target = Game.getObjectById(targetId);

        if(!Game.creeps[creepName]) {
            delete claims[targetId];
            continue;
        }

        if(!target) {
            delete claims[targetId];
            continue;
        }

        if(!structureNeedsRepair(target)) {
            delete claims[targetId];
            continue;
        }

        if(!workers[creepName]) {
            delete claims[targetId];
        }
    }
}

function claimRepairWorkerSlot(creep) {
    var roomMemory = Memory.rooms[creep.room.name];
    var workers = roomMemory[REPAIR_WORKERS_MEMORY_KEY];

    /*
     * If this creep already has a repair-worker slot, keep it fresh.
     */
    if(workers[creep.name]) {
        workers[creep.name] = Game.time;
        return true;
    }

    /*
     * Count current repair workers.
     */
    var count = 0;

    for(var creepName in workers) {
        if(workers.hasOwnProperty(creepName)) {
            count++;
        }
    }

    /*
     * Only allow 2 Artificers to be repair workers.
     */
    if(count >= MAX_REPAIR_ARTIFICERS) {
        return false;
    }

    workers[creep.name] = Game.time;
    return true;
}

function isRepairWorker(creep) {
    var roomMemory = Memory.rooms[creep.room.name];
    var workers = roomMemory[REPAIR_WORKERS_MEMORY_KEY];

    return !!workers[creep.name];
}

function hasRepairWork(room, criticalOnly) {
    var roomMemory = Memory.rooms[room.name];
    var repairList = roomMemory[REPAIR_LIST_MEMORY_KEY];

    if(!repairList || repairList.length === 0) {
        return false;
    }

    for(var i = 0; i < repairList.length; i++) {
        var target = Game.getObjectById(repairList[i]);

        if(target && structureNeedsRepair(target) && repairClassMatches(target, criticalOnly)) {
            return true;
        }
    }

    return false;
}

function repairClaimedTarget(creep, criticalOnly) {
    /*
     * First try to keep repairing the target this creep already picked.
     * This makes the Artificer stay on one job until it is done.
     */
    var oldTarget = getRememberedRepairTarget(creep);

    if(oldTarget && repairClassMatches(oldTarget, criticalOnly)) {
        return repairTarget(creep, oldTarget);
    }
    if(oldTarget) releaseRepairTarget(creep);

    /*
     * No remembered target, so claim a new one from room memory.
     */
    var newTarget = claimNewRepairTarget(creep, criticalOnly);

    if(newTarget) {
        return repairTarget(creep, newTarget);
    }

    return false;
}

function getRememberedRepairTarget(creep) {
    if(!creep.memory.repairTargetId) {
        return null;
    }

    var target = Game.getObjectById(creep.memory.repairTargetId);

    if(!target || !structureNeedsRepair(target)) {
        releaseRepairTarget(creep);
        return null;
    }

    var roomMemory = Memory.rooms[creep.room.name];
    var claims = roomMemory[REPAIR_CLAIMS_MEMORY_KEY];
    var claimedBy = claims[target.id];

    /*
     * If nobody has the target, claim it.
     */
    if(!claimedBy) {
        claims[target.id] = creep.name;
        return target;
    }

    /*
     * If this creep has the claim, keep it.
     */
    if(claimedBy === creep.name) {
        return target;
    }

    /*
     * Someone else has it. Forget this target.
     */
    delete creep.memory.repairTargetId;
    return null;
}

function claimNewRepairTarget(creep, criticalOnly) {
    var roomMemory = Memory.rooms[creep.room.name];
    var repairList = roomMemory[REPAIR_LIST_MEMORY_KEY];
    var claims = roomMemory[REPAIR_CLAIMS_MEMORY_KEY];

    if(!repairList || repairList.length === 0) {
        return null;
    }

    for(var i = 0; i < repairList.length; i++) {
        var targetId = repairList[i];
        var target = Game.getObjectById(targetId);

        if(!target) {
            continue;
        }

        if(!structureNeedsRepair(target)) {
            continue;
        }

        if(!repairClassMatches(target, criticalOnly)) {
            continue;
        }

        /*
         * If another Artificer already claimed this target, skip it.
         */
        if(claims[targetId] && claims[targetId] !== creep.name) {
            continue;
        }

        /*
         * Claim the target.
         */
        claims[targetId] = creep.name;
        creep.memory.repairTargetId = targetId;

        return target;
    }

    return null;
}

function isCriticalRepairStructure(structure) {
    if(!structure) return false;
    return structure.structureType === STRUCTURE_SPAWN ||
        structure.structureType === STRUCTURE_EXTENSION ||
        structure.structureType === STRUCTURE_TOWER ||
        structure.structureType === STRUCTURE_STORAGE ||
        structure.structureType === STRUCTURE_CONTAINER ||
        structure.structureType === STRUCTURE_LINK ||
        structure.structureType === STRUCTURE_TERMINAL;
}

function repairClassMatches(target, criticalOnly) {
    if(criticalOnly === undefined) return true;
    return isCriticalRepairStructure(target) === criticalOnly;
}

function releaseRepairTarget(creep) {
    if(!creep || !creep.room || !creep.memory.repairTargetId) {
        return;
    }

    var roomMemory = Memory.rooms[creep.room.name];

    if(roomMemory && roomMemory[REPAIR_CLAIMS_MEMORY_KEY]) {
        var claims = roomMemory[REPAIR_CLAIMS_MEMORY_KEY];

        if(claims[creep.memory.repairTargetId] === creep.name) {
            delete claims[creep.memory.repairTargetId];
        }
    }

    delete creep.memory.repairTargetId;
}

function clearRepairDuty(creep) {
    var roomMemory = Memory.rooms[creep.room.name];

    roomMemory[REPAIR_WORKERS_MEMORY_KEY] = {};
    roomMemory[REPAIR_CLAIMS_MEMORY_KEY] = {};

    delete creep.memory.repairTargetId;
}

function structureNeedsRepair(structure) {
    /*
     * This uses the repair rule you added to utility.Creep.js.
     *
     * If utility.Creep.js does not export shouldRepairStructure yet,
     * this fallback still works, but it will repair anything damaged.
     */
    if(creepUtility.shouldRepairStructure) {
        return creepUtility.shouldRepairStructure(structure);
    }

    return structure && structure.hits < structure.hitsMax;
}

function repairTarget(creep, target) {
    /*
     * creep.repair works from range 3.
     */
    var result = creep.repair(target);

    if(result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, target, {
            visualizePathStyle: {
                stroke: '#ffaa00'
            }
        });
    }

    return true;
}

function collectEnergyForArtificer(creep) {
    /*
     * Artificer energy collection mirrors Repair: use stored or dropped energy
     * first, then harvest only if no reusable energy is available. If the creep
     * is already in its remote work room, it refills there instead of walking
     * home empty.
     */
    if(creep.memory.remoteWorkTargetId && creep.memory.remoteWorkRoomName === creep.room.name) {
        if(collectRemoteEnergy(creep)) {
            return;
        }
    }

    var ignoredTargetIds = {};
    var target = findStoredEnergy(creep, ignoredTargetIds);

    /*
     * Pickup and withdraw can fail even after a target was found. Handle the
     * result and try another target instead of silently standing beside a bad
     * one forever.
     */
    while(target) {
        if(useEnergyTarget(creep, target)) {
            return;
        }

        if(!target.id) {
            break;
        }

        ignoredTargetIds[target.id] = true;
        target = findStoredEnergy(creep, ignoredTargetIds);
    }

    /*
     * A partial-energy creep should not get stuck forever in collect mode. If
     * no reusable target worked, let it spend the energy it already carries.
     */
    if(creep.store[RESOURCE_ENERGY] > 0) {
        creep.memory.builderWorking = true;
        return;
    }

    var source = creep.pos.findClosestByPath(FIND_SOURCES);

    if(source && creep.harvest(source) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function useEnergyTarget(creep, target) {
    var result;

    if(!target) {
        return false;
    }

    /*
     * Dropped resources use pickup, while structures and remains use withdraw.
     * The result must be handled so a failed action does not look successful.
     */
    if(target.resourceType) {
        result = creep.pickup(target);
    } else {
        result = creep.withdraw(target, RESOURCE_ENERGY);
    }

    if(result === OK) {
        return true;
    }

    if(result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, target, {
            range: 1,
            visualizePathStyle: {
                stroke: '#ffaa00'
            }
        });
        return true;
    }

    /*
     * ERR_FULL means collection is finished, so switch to work mode next tick.
     */
    if(result === ERR_FULL) {
        creep.memory.builderWorking = true;
        return true;
    }

    return false;
}

function buildLocalConstruction(creep, importantOnly) {
    var homeRoomName = getHomeRoomName(creep);

    if(homeRoomName && creep.room.name !== homeRoomName) {
        return false;
    }

    /*
     * Construction wins over controller upgrading because new structures often
     * unlock capacity, defense, or logistics. Remote infrastructure is checked
     * only after the local room has no construction work.
     */
    var target = getRememberedBuildTarget(creep);
    var ignoredTargetIds = {};

    /*
     * buildTargetId helps the Artificer stay focused on one construction site.
     * A new higher-priority site can still override a remembered lower-priority
     * site so important structures are not delayed.
     */
    if(target && (!importantOnly || isImportantConstructionSite(target)) &&
        !hasHigherPriorityConstructionSite(creep, target, importantOnly)) {
        if(buildTarget(creep, target)) return true;
        ignoredTargetIds[target.id] = true;
    }

    target = findBestLocalConstructionSite(creep, importantOnly, ignoredTargetIds);

    if(!target) {
        clearBuildTarget(creep);
        return false;
    }

    rememberBuildTarget(creep, target);
    return buildTarget(creep, target);
}

function hasLocalConstructionWork(creep, importantOnly) {
    var homeRoomName = getHomeRoomName(creep);
    if(homeRoomName && creep.room.name !== homeRoomName) return false;
    var sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
    if(!sites || sites.length === 0) return false;
    return sites.some(function(site) {
        return isValidLocalConstructionSite(creep, site) &&
            (!importantOnly || isImportantConstructionSite(site)) &&
            isConstructionSiteReachable(creep, site);
    });
}

function isImportantConstructionSite(site) {
    if(!site) return false;
    return site.structureType === STRUCTURE_SPAWN ||
        site.structureType === STRUCTURE_EXTENSION ||
        site.structureType === STRUCTURE_TOWER ||
        site.structureType === STRUCTURE_STORAGE ||
        site.structureType === STRUCTURE_CONTAINER ||
        site.structureType === STRUCTURE_LINK ||
        site.structureType === STRUCTURE_TERMINAL;
}

function getConstructionSitePriority(site) {
    if(!site || !site.structureType) {
        return 0;
    }

    return STRUCTURE_BUILD_PRIORITY[site.structureType] || 0;
}

function getRememberedBuildTarget(creep, spend) {
    if(!creep.memory.buildTargetId) {
        return null;
    }

    var target = Game.getObjectById(creep.memory.buildTargetId);
    var homeRoomName = getHomeRoomName(creep);

    if(
        !target ||
        !target.pos ||
        target.pos.roomName !== homeRoomName ||
        target.progress === undefined ||
        target.progressTotal === undefined ||
        target.progress >= target.progressTotal ||
        target.my === false ||
        spend && !isConstructionSitePermitted(target, spend) ||
        !isConstructionSiteReachable(creep, target)
    ) {
        clearBuildTarget(creep);
        return null;
    }

    return target;
}

function isConstructionSitePermitted(site, spend) {
    if(!site || !spend) return false;
    return !!(spend.construction ||
        spend.criticalInfrastructure && isImportantConstructionSite(site));
}

function isConstructionSiteReachable(creep, site) {
    if(!creep || !creep.pos || !site || !site.pos) return false;
    if(creep.pos.inRangeTo(site, 3)) return true;
    var cached = getCachedConstructionReachability(creep, site);
    if(cached !== null) return cached;
    var reachable = creep.pos.findClosestByPath(
        [site],
        {range: 3, ignoreCreeps: true}
    ) === site;
    cacheConstructionReachability(creep, site, reachable);
    return reachable;
}

function getConstructionReachabilityCache() {
    if(!global.__sushiArtificerReachability) {
        global.__sushiArtificerReachability = {};
    }
    var cache = global.__sushiArtificerReachability;
    if(Game.time % BUILD_REACHABLE_CACHE_TTL === 0 && cache.__lastCleanup !== Game.time) {
        cache.__lastCleanup = Game.time;
        for(var key in cache) {
            if(key !== '__lastCleanup' && cache[key].expires < Game.time) delete cache[key];
        }
    }
    return cache;
}

function getConstructionReachabilityKey(creep, site) {
    return (creep.name || creep.id || 'unknown') + ':' + site.id;
}

function getCachedConstructionReachability(creep, site) {
    var entry = getConstructionReachabilityCache()[getConstructionReachabilityKey(creep, site)];
    if(!entry || entry.expires < Game.time || entry.roomName !== site.pos.roomName ||
        entry.targetX !== site.pos.x || entry.targetY !== site.pos.y) {
        return null;
    }
    if(!entry.reachable &&
        (entry.creepX !== creep.pos.x || entry.creepY !== creep.pos.y)) {
        return null;
    }
    return entry.reachable;
}

function cacheConstructionReachability(creep, site, reachable) {
    getConstructionReachabilityCache()[getConstructionReachabilityKey(creep, site)] = {
        reachable: reachable,
        expires: Game.time + (reachable ? BUILD_REACHABLE_CACHE_TTL : BUILD_UNREACHABLE_CACHE_TTL),
        roomName: site.pos.roomName,
        targetX: site.pos.x,
        targetY: site.pos.y,
        creepX: creep.pos.x,
        creepY: creep.pos.y
    };
}

function hasHigherPriorityConstructionSite(creep, currentTarget, importantOnly) {
    var currentPriority = getConstructionSitePriority(currentTarget);
    return !!findBestLocalConstructionSite(creep, importantOnly, null, currentPriority);
}

function findBestLocalConstructionSite(creep, importantOnly, ignoredTargetIds, minimumPriority) {
    var sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);

    if(!sites || sites.length === 0) {
        return null;
    }

    var sitesByPriority = {};
    var priorities = [];

    for(var i = 0; i < sites.length; i++) {
        if(!isValidLocalConstructionSite(creep, sites[i]) ||
            importantOnly && !isImportantConstructionSite(sites[i]) ||
            ignoredTargetIds && ignoredTargetIds[sites[i].id]) {
            continue;
        }
        var priority = getConstructionSitePriority(sites[i]);
        if(minimumPriority !== undefined && priority <= minimumPriority) continue;

        if(!sitesByPriority[priority]) {
            sitesByPriority[priority] = [];
            priorities.push(priority);
        }
        sitesByPriority[priority].push(sites[i]);
    }

    priorities.sort(function(a, b) { return b - a; });

    for(var priorityIndex = 0; priorityIndex < priorities.length; priorityIndex++) {
        var candidates = sitesByPriority[priorities[priorityIndex]];
        var inRange = candidates.filter(function(site) {
            return creep.pos.inRangeTo(site, 3);
        });
        if(inRange.length > 0) {
            return creep.pos.findClosestByRange(inRange) || inRange[0];
        }
        var cachedReachable = [];
        var uncheckedCandidates = [];
        for(var cacheIndex = 0; cacheIndex < candidates.length; cacheIndex++) {
            var cached = getCachedConstructionReachability(creep, candidates[cacheIndex]);
            if(cached === true) cachedReachable.push(candidates[cacheIndex]);
            else if(cached === null) uncheckedCandidates.push(candidates[cacheIndex]);
        }
        if(cachedReachable.length > 0) {
            return creep.pos.findClosestByRange(cachedReachable) || cachedReachable[0];
        }
        if(uncheckedCandidates.length === 0) continue;
        var reachable = creep.pos.findClosestByPath(
            uncheckedCandidates,
            {range: 3, ignoreCreeps: true}
        );
        if(reachable) {
            cacheConstructionReachability(creep, reachable, true);
            return reachable;
        }
        for(var candidateIndex = 0; candidateIndex < uncheckedCandidates.length; candidateIndex++) {
            cacheConstructionReachability(creep, uncheckedCandidates[candidateIndex], false);
        }
    }

    return null;
}

function isValidLocalConstructionSite(creep, site) {
    return !!(site && site.pos && site.pos.roomName === getHomeRoomName(creep) &&
        site.progress !== undefined && site.progressTotal !== undefined &&
        site.progress < site.progressTotal && site.my !== false);
}

function rememberBuildTarget(creep, target) {
    creep.memory.buildTargetId = target.id;
}

function clearBuildTarget(creep) {
    delete creep.memory.buildTargetId;
}

function buildTarget(creep, target) {
    var result = creep.build(target);

    if(result === ERR_NOT_IN_RANGE) {
        var moveResult = utilityTravelCreep.move(creep, target, {
            range: 3,
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
        if(moveResult === ERR_NO_PATH || moveResult === ERR_NOT_FOUND ||
            moveResult === ERR_INVALID_TARGET || moveResult === ERR_INVALID_ARGS) {
            cacheConstructionReachability(creep, target, false);
            clearBuildTarget(creep);
            return false;
        }
        return true;
    }

    if(result === OK) {
        return true;
    }

    if(result === ERR_INVALID_TARGET || result === ERR_NOT_OWNER) {
        cacheConstructionReachability(creep, target, false);
    }
    clearBuildTarget(creep);
    return false;
}

function upgradeController(creep) {
    var homeRoomName = getHomeRoomName(creep);

    /*
     * Artificers should not spend spare energy on remote controllers. If remote
     * work is done while they are away from home, send them home before using
     * controller upgrading as the fallback job.
     */
    if(homeRoomName && creep.room.name !== homeRoomName) {
        utilityTravelCreep.moveToRoom(creep, homeRoomName, {range: 22, visualizePathStyle: {stroke: '#ffffff'}});
        return;
    }

    if(creep.room.controller && creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function getControllerUpgradePolicy(creep, spend) {
    var homeRoomName = getHomeRoomName(creep);
    var economy = spend.economy;
    var state = economy && economy.state;
    var controllerDanger = !!(creep.room.controller &&
        creep.room.controller.ticksToDowngrade < CONTROLLER_DANGER_TICKS);

    if(controllerDanger && Economy.canSpend(homeRoomName, 'controllerSafety')) {
        return {allowed: true, category: 'controllerSafety', reason: 'controller downgrade safety'};
    }

    if(state === Economy.STATES.SURVIVAL) {
        return {allowed: false, reason: 'SURVIVAL blocks normal controller energy'};
    }

    var colony = ColonyState.get(homeRoomName);
    var baselinePhase = colony && (colony.lifecycle === 'BOOTSTRAP' || colony.lifecycle === 'GROWTH');
    if(baselinePhase && !essentialEconomySatisfied(creep, economy, colony)) {
        return {allowed: false, reason: 'essential economy needs are not satisfied'};
    }

    if(state === Economy.STATES.RECOVERY) {
        if(!recoveryUpgradeConditionsMet(creep, economy)) {
            return {allowed: false, reason: 'RECOVERY controller helper conditions not met'};
        }
        if(hasHealthyTech(homeRoomName)) {
            return {allowed: false, reason: 'Tech owns baseline controller progress'};
        }
        if(!Economy.canSpend(homeRoomName, 'controllerGrowth')) {
            return {allowed: false, reason: 'controller-growth spending blocked'};
        }
        if(!claimRecoveryControllerHelper(creep, homeRoomName)) {
            return {allowed: false, reason: 'RECOVERY controller helper already assigned'};
        }
        return {allowed: true, category: 'controllerGrowth', reason: 'temporary RECOVERY baseline progress'};
    }

    var category = baselinePhase ? 'controllerGrowth' : 'upgradeSurplus';
    if(!Economy.canSpend(homeRoomName, category)) {
        return {allowed: false, reason: category + ' spending blocked'};
    }

    return {allowed: true, category: category, reason: 'no permitted repair or construction'};
}

function essentialEconomySatisfied(creep, economy, colony) {
    if(colony && colony.coreFloor && colony.coreFloor.complete === false) return false;
    if(!economy) return true;
    if(economy.harvest && typeof economy.harvest.workActive === 'number' && economy.harvest.workActive <= 0) {
        return false;
    }
    if(economy.haul && typeof economy.haul.localCarry === 'number' && economy.haul.localCarry < 1) {
        return false;
    }
    return !hasImmediateOwnedRoomThreat(creep.room.name);
}

function recoveryUpgradeConditionsMet(creep, economy) {
    if(!economy || !economy.harvest || !(economy.harvest.workActive > 0)) return false;
    if(!economy.haul || !(economy.haul.localCarry >= 1)) return false;
    if(hasImmediateOwnedRoomThreat(creep.room.name)) return false;
    return typeof economy.spawnFill === 'number' && economy.spawnFill >= HEALTHY_SPAWN_FILL;
}

function hasImmediateOwnedRoomThreat(roomName) {
    var threat = HiveMemory.ensure().threats[roomName];
    return !!(threat && threat.harmfulHostileCount > 0);
}

function hasHealthyTech(homeRoomName) {
    for(var creepName in Game.creeps) {
        if(!Game.creeps.hasOwnProperty(creepName)) continue;
        var unit = Game.creeps[creepName];
        if(!unit || !unit.memory || unit.memory.role !== 'Tech') continue;
        var unitHome = unit.memory.homeRoom || unit.room && unit.room.name;
        if(unitHome === homeRoomName && (unit.ticksToLive === undefined || unit.ticksToLive > 50)) return true;
    }
    return false;
}

function claimRecoveryControllerHelper(creep, homeRoomName) {
    if(!global.__sushiArtificerControllerHelpers ||
        global.__sushiArtificerControllerHelpers.tick !== Game.time) {
        global.__sushiArtificerControllerHelpers = {tick: Game.time, rooms: {}};
    }
    var helpers = global.__sushiArtificerControllerHelpers.rooms;
    var identity = creep.name || creep.id;
    if(!helpers[homeRoomName]) helpers[homeRoomName] = identity;
    return helpers[homeRoomName] === identity;
}

function idleNearBase(creep) {
    var anchor = creep.room.storage || creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(anchor && creep.pos.getRangeTo(anchor) > 2) {
        utilityTravelCreep.move(creep, anchor, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}


function doRemoteInfrastructureWork(creep) {
    var target = getRememberedRemoteWorkTarget(creep);

    if(!target) {
        if(travelToRememberedRemoteWorkPosition(creep)) {
            return true;
        }

        target = findRemoteInfrastructureTarget(creep);
    }

    if(!target) {
        return false;
    }

    doBuildOrRepairTarget(creep, target, creep.memory.remoteWorkType);
    return true;
}

function getRememberedRemoteWorkTarget(creep) {
    if(!creep.memory.remoteWorkTargetId) {
        return null;
    }

    var roomName = creep.memory.remoteWorkRoomName;

    if(creep.memory.season11Maintenance) {
        var currentMaintenance = getSeason11OperationMaintenanceTarget(creep);
        if(!currentMaintenance || currentMaintenance.id !== creep.memory.remoteWorkTargetId) {
            clearRemoteWorkTarget(creep);
            return null;
        }
    }

    var target = Game.getObjectById(creep.memory.remoteWorkTargetId);

    if(!target) {
        /*
         * Game.getObjectById returns null for objects in rooms we cannot see.
         * Keep the target while traveling there, and only forget it after the
         * creep reaches that room and still cannot find the object.
         */
        if(roomName && creep.room.name === roomName) {
            clearRemoteWorkTarget(creep);
        }

        return null;
    }

    if(creep.memory.season11Maintenance && !isSafeSeason11MaintenanceTarget(creep, target)) {
        clearRemoteWorkTarget(creep);
        return null;
    }

    if(creep.memory.remoteWorkType === 'repairRemoteContainer' || creep.memory.remoteWorkType === 'repairRemoteRoad') {
        if(target.hits >= target.hitsMax) {
            clearRemoteWorkTarget(creep);
            return null;
        }
    } else if(target.progressTotal !== undefined && target.progress >= target.progressTotal) {
        clearRemoteWorkTarget(creep);
        return null;
    }

    return target;
}


function travelToRememberedRemoteWorkPosition(creep) {
    var roomName = creep.memory.remoteWorkRoomName;

    if(!creep.memory.remoteWorkTargetId || !roomName || creep.room.name === roomName) {
        return false;
    }

    if(creep.memory.remoteWorkX === undefined || creep.memory.remoteWorkY === undefined) {
        utilityTravelCreep.moveToRoom(creep, roomName, {
            range: 22,
            allowHostile: creep.memory.season11Maintenance ? false : undefined,
            visualizePathStyle: {stroke: '#ffffff'}
        });
        return true;
    }

    utilityTravelCreep.move(creep, new RoomPosition(creep.memory.remoteWorkX, creep.memory.remoteWorkY, roomName), {
        range: 3,
        allowHostile: creep.memory.season11Maintenance ? false : undefined,
        visualizePathStyle: {
            stroke: '#ffffff'
        }
    });
    return true;
}

function findRemoteInfrastructureTarget(creep) {
    if(creep.memory.remoteWorkNextScan && Game.time < creep.memory.remoteWorkNextScan) {
        return null;
    }

    if(creep.memory.season11Maintenance) {
        var maintenance = getSeason11OperationMaintenanceTarget(creep);
        var seasonTarget = maintenance && Game.getObjectById(maintenance.id);
        if(seasonTarget && isSafeSeason11MaintenanceTarget(creep, seasonTarget)) {
            creep.memory.season11RepairTargetId = maintenance.id;
            creep.memory.season11SupportRoom = maintenance.roomName;
            rememberRemoteWorkTarget(creep, seasonTarget, maintenance.workType);
            return seasonTarget;
        }
        creep.memory.remoteWorkNextScan = Game.time + REMOTE_WORK_EMPTY_SCAN_COOLDOWN;
        return null;
    }

    var homeRoomName = getHomeRoomName(creep);
    var remoteRooms = getActiveRemoteRoomNames(homeRoomName);
    var target;

    if(remoteRooms.length === 0) {
        creep.memory.remoteWorkNextScan = Game.time + REMOTE_WORK_EMPTY_SCAN_COOLDOWN;
        return null;
    }

    target = findBestRemoteConstructionSite(creep, remoteRooms, STRUCTURE_CONTAINER);
    if(target) {
        rememberRemoteWorkTarget(creep, target, 'buildRemoteContainer');
        return target;
    }

    target = findBestRemoteConstructionSite(creep, remoteRooms, STRUCTURE_ROAD);
    if(target) {
        rememberRemoteWorkTarget(creep, target, 'buildRemoteRoad');
        return target;
    }

    target = findBestRemoteRepairTarget(creep, remoteRooms, STRUCTURE_CONTAINER);
    if(target) {
        rememberRemoteWorkTarget(creep, target, 'repairRemoteContainer');
        return target;
    }

    target = findBestRemoteRepairTarget(creep, remoteRooms, STRUCTURE_ROAD);
    if(target) {
        rememberRemoteWorkTarget(creep, target, 'repairRemoteRoad');
        return target;
    }

    creep.memory.remoteWorkNextScan = Game.time + REMOTE_WORK_EMPTY_SCAN_COOLDOWN;
    return null;
}

function getSeason11OperationMaintenanceTarget(creep) {
    var operation = creep.memory.operationId &&
        HiveMemory.ensure().operations[creep.memory.operationId];
    var lease = operation && operation.season11MaintenanceLease;
    var target = operation && operation.season11MaintenanceTarget;
    return operation && operation.season11 === true && target && lease &&
        lease.creepName === creep.name && lease.targetId === target.id &&
        lease.expiresTick >= Game.time ? target : null;
}

function isSafeSeason11MaintenanceTarget(creep, target) {
    var roomName = creep.memory.season11SupportRoom;
    if(!roomName || !target || !target.pos || target.pos.roomName !== roomName ||
        target.my === false || !(target.hits < target.hitsMax) ||
        target.structureType !== STRUCTURE_CONTAINER && target.structureType !== STRUCTURE_ROAD) return false;
    var homeRoomName = getHomeRoomName(creep);
    var homeRoom = Game.rooms && Game.rooms[homeRoomName];
    if(!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return false;
    if(typeof FIND_HOSTILE_CREEPS !== 'undefined' && typeof homeRoom.find === 'function' &&
        (homeRoom.find(FIND_HOSTILE_CREEPS) || []).length > 0) return false;
    var room = Game.rooms && Game.rooms[roomName];
    if(!room || !room.controller || !room.controller.my) return false;
    if(typeof FIND_HOSTILE_CREEPS !== 'undefined' && typeof room.find === 'function' &&
        (room.find(FIND_HOSTILE_CREEPS) || []).length > 0) return false;
    return true;
}

function clearSeason11MaintenanceAssignment(creep) {
    if(!creep.memory.season11Maintenance) return;
    delete creep.memory.operationId;
    delete creep.memory.demandId;
    delete creep.memory.season11Maintenance;
    delete creep.memory.season11SupportRoom;
    delete creep.memory.season11RepairTargetId;
}

function rememberRemoteWorkTarget(creep, target, workType) {
    creep.memory.remoteWorkTargetId = target.id;
    creep.memory.remoteWorkRoomName = target.pos.roomName;
    creep.memory.remoteWorkX = target.pos.x;
    creep.memory.remoteWorkY = target.pos.y;
    creep.memory.remoteWorkType = workType;
    creep.memory.remoteWorkHomeRoom = getHomeRoomName(creep);
}

function clearRemoteWorkTarget(creep) {
    delete creep.memory.remoteWorkTargetId;
    delete creep.memory.remoteWorkRoomName;
    delete creep.memory.remoteWorkX;
    delete creep.memory.remoteWorkY;
    delete creep.memory.remoteWorkType;
    delete creep.memory.remoteWorkHomeRoom;
}

function getHomeRoomName(creep) {
    if(creep.memory.homeRoom) {
        return creep.memory.homeRoom;
    }

    if(creep.memory.home) {
        return creep.memory.home;
    }

    if(HiveMemory.ensure().identity.firstSpawnRoom) {
        return HiveMemory.ensure().identity.firstSpawnRoom;
    }

    return creep.room.name;
}

function getActiveRemoteRoomNames(homeRoomName) {
    var roomMemory = Memory.rooms && Memory.rooms[homeRoomName];
    var planner = roomMemory && roomMemory.remotePlanner;
    var roomNames = [];
    var seen = {};

    if(!planner || !planner.sourceInfos || !planner.activeSourceIds) {
        return roomNames;
    }

    for(var i = 0; i < planner.activeSourceIds.length; i++) {
        var sourceId = planner.activeSourceIds[i];
        var sourceInfo = planner.sourceInfos[sourceId];
        var remoteRoomName = getRemoteRoomNameFromSourceInfo(sourceInfo, homeRoomName);

        if(!remoteRoomName || remoteRoomName === homeRoomName || seen[remoteRoomName] || !Game.rooms[remoteRoomName]) {
            continue;
        }

        seen[remoteRoomName] = true;
        roomNames.push(remoteRoomName);
    }

    return roomNames;
}

function getRemoteRoomNameFromSourceInfo(sourceInfo, homeRoomName) {
    if(!sourceInfo) {
        return null;
    }

    if(sourceInfo.roomName) {
        return sourceInfo.roomName;
    }

    if(sourceInfo.sourceRoomName) {
        return sourceInfo.sourceRoomName;
    }

    if(typeof sourceInfo.room === 'string') {
        return sourceInfo.room;
    }

    if(sourceInfo.pos && sourceInfo.pos.roomName) {
        return sourceInfo.pos.roomName;
    }

    if(sourceInfo.roadCoords) {
        for(var roomName in sourceInfo.roadCoords) {
            if(sourceInfo.roadCoords.hasOwnProperty(roomName) && roomName !== homeRoomName && Game.rooms[roomName]) {
                return roomName;
            }
        }
    }

    return null;
}

function findBestRemoteConstructionSite(creep, remoteRooms, structureType) {
    return findBestRemoteTarget(creep, remoteRooms, function(room) {
        return room.find(FIND_MY_CONSTRUCTION_SITES, {
            filter: function(site) {
                return site.structureType === structureType;
            }
        });
    });
}

function findBestRemoteRepairTarget(creep, remoteRooms, structureType) {
    return findBestRemoteTarget(creep, remoteRooms, function(room) {
        return room.find(FIND_STRUCTURES, {
            filter: function(structure) {
                return structure.structureType === structureType && remoteStructureNeedsRepair(structure);
            }
        });
    });
}

function findBestRemoteTarget(creep, remoteRooms, roomTargetFinder) {
    var firstTarget = null;
    var closestTarget = null;
    var closestRange = 999;

    for(var i = 0; i < remoteRooms.length; i++) {
        var roomName = remoteRooms[i];
        var room = Game.rooms[roomName];

        if(!room) {
            continue;
        }

        var targets = roomTargetFinder(room);

        if(!targets || targets.length === 0) {
            continue;
        }

        if(!firstTarget) {
            firstTarget = targets[0];
        }

        if(creep.room.name === roomName) {
            for(var j = 0; j < targets.length; j++) {
                var range = creep.pos.getRangeTo(targets[j]);

                if(range < closestRange) {
                    closestRange = range;
                    closestTarget = targets[j];
                }
            }
        }
    }

    return closestTarget || firstTarget;
}

function remoteStructureNeedsRepair(structure) {
    if(!structure || structure.hits >= structure.hitsMax) {
        return false;
    }

    if(structure.structureType === STRUCTURE_CONTAINER) {
        return structure.hits < structure.hitsMax * REMOTE_CONTAINER_REPAIR_START_PERCENT;
    }

    if(structure.structureType === STRUCTURE_ROAD) {
        return structure.hits < structure.hitsMax * REMOTE_ROAD_REPAIR_START_PERCENT;
    }

    return false;
}

function doBuildOrRepairTarget(creep, target, workType) {
    var result;

    if(workType === 'buildRemoteContainer' || workType === 'buildRemoteRoad') {
        result = creep.build(target);
    } else {
        result = creep.repair(target);
    }

    if(result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, target, {
            range: 3,
            allowHostile: creep.memory.season11Maintenance ? false : undefined,
            visualizePathStyle: {stroke: '#ffffff'}
        });
    }
}

function collectRemoteEnergy(creep) {
    var ignoredTargetIds = {};
    var target = findRemoteStoredEnergy(creep, ignoredTargetIds);

    while(target) {
        if(useEnergyTarget(creep, target)) {
            return true;
        }

        if(!target.id) {
            break;
        }

        ignoredTargetIds[target.id] = true;
        target = findRemoteStoredEnergy(creep, ignoredTargetIds);
    }

    if(creep.store[RESOURCE_ENERGY] > 0) {
        creep.memory.builderWorking = true;
        return true;
    }

    target = findClosestActiveRemoteSource(creep);

    if(target) {
        if(creep.harvest(target) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {range: 1, visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return true;
    }

    return false;
}

function findRemoteStoredEnergy(creep, ignoredTargetIds) {
    var minimumUsefulAmount = getMinimumUsefulEnergyAmount(creep);
    var target = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return (
                resource.resourceType === RESOURCE_ENERGY &&
                getStoredEnergyAmount(resource) >= minimumUsefulAmount &&
                !isIgnoredEnergyTarget(resource, ignoredTargetIds)
            );
        }
    });

    if(target) {
        return target;
    }

    target = creep.pos.findClosestByRange(FIND_TOMBSTONES, {
        filter: function(tombstone) {
            return (
                getStoredEnergyAmount(tombstone) > 0 &&
                !isIgnoredEnergyTarget(tombstone, ignoredTargetIds)
            );
        }
    });

    if(target) {
        return target;
    }

    target = creep.pos.findClosestByRange(FIND_RUINS, {
        filter: function(ruin) {
            return getStoredEnergyAmount(ruin) > 0 && !isIgnoredEnergyTarget(ruin, ignoredTargetIds);
        }
    });

    if(target) {
        return target;
    }

    target = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                getStoredEnergyAmount(structure) >= minimumUsefulAmount &&
                !isIgnoredEnergyTarget(structure, ignoredTargetIds)
            );
        }
    });

    if(target) {
        return target;
    }

    target = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                getStoredEnergyAmount(structure) > 0 &&
                !isIgnoredEnergyTarget(structure, ignoredTargetIds)
            );
        }
    });

    if(target) {
        return target;
    }

    return creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return (
                resource.resourceType === RESOURCE_ENERGY &&
                getStoredEnergyAmount(resource) > 0 &&
                !isIgnoredEnergyTarget(resource, ignoredTargetIds)
            );
        }
    });
}

function findClosestActiveRemoteSource(creep) {
    var homeRoomName = creep.memory.remoteWorkHomeRoom || getHomeRoomName(creep);
    var roomMemory = Memory.rooms && Memory.rooms[homeRoomName];
    var planner = roomMemory && roomMemory.remotePlanner;
    var closestSource = null;
    var closestRange = 999;

    if(!planner || !planner.activeSourceIds || !planner.sourceInfos) {
        return creep.pos.findClosestByRange(FIND_SOURCES);
    }

    for(var i = 0; i < planner.activeSourceIds.length; i++) {
        var sourceId = planner.activeSourceIds[i];
        var sourceInfo = planner.sourceInfos[sourceId];
        var sourceRoomName = getRemoteRoomNameFromSourceInfo(sourceInfo, homeRoomName);

        if(sourceRoomName !== creep.room.name) {
            continue;
        }

        var source = Game.getObjectById(sourceId);

        if(!source) {
            continue;
        }

        var range = creep.pos.getRangeTo(source);

        if(range < closestRange) {
            closestRange = range;
            closestSource = source;
        }
    }

    return closestSource || creep.pos.findClosestByRange(FIND_SOURCES);
}

function getStoredEnergyAmount(target) {
    if(!target) {
        return 0;
    }

    if(target.resourceType) {
        return target.resourceType === RESOURCE_ENERGY ? target.amount : 0;
    }

    if(target.store && typeof target.store.getUsedCapacity === 'function') {
        return target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }

    if(target.store) {
        return target.store[RESOURCE_ENERGY] || 0;
    }

    return 0;
}

function getMinimumUsefulEnergyAmount(creep) {
    var freeCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);

    return Math.max(1, Math.min(MIN_USEFUL_ENERGY_AMOUNT, freeCapacity));
}

function findStoredEnergy(creep, ignoredTargetIds) {
    var minimumUsefulAmount = getMinimumUsefulEnergyAmount(creep);

    /*
     * Pick up dropped energy first when the pile is large enough to be worth
     * the trip. Tiny piles are checked later so a full container can win.
     *
     * creep.pos.findClosestByPath searches from this creep's current position,
     * so this only looks in the room the creep is currently standing in.
     */
    var droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return (
                resource.resourceType === RESOURCE_ENERGY &&
                getStoredEnergyAmount(resource) >= minimumUsefulAmount &&
                !isIgnoredEnergyTarget(resource, ignoredTargetIds)
            );
        }
    });

    if(droppedEnergy) {
        return droppedEnergy;
    }

    /*
     * If no dropped energy exists, use storage.
     */
    if(
        creep.room.storage &&
        getStoredEnergyAmount(creep.room.storage) > 0 &&
        !isIgnoredEnergyTarget(creep.room.storage, ignoredTargetIds)
    ) {
        return creep.room.storage;
    }

    /*
     * If no storage energy is available, prefer a container with enough energy
     * to provide a useful refill.
     */
    var container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                getStoredEnergyAmount(structure) >= minimumUsefulAmount &&
                !isIgnoredEnergyTarget(structure, ignoredTargetIds)
            );
        }
    });

    if(container) {
        return container;
    }

    /*
     * Small containers and drops are still reusable when no better option is
     * available. Containers come first here to avoid chasing a one-energy pile.
     */
    container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                getStoredEnergyAmount(structure) > 0 &&
                !isIgnoredEnergyTarget(structure, ignoredTargetIds)
            );
        }
    });

    if(container) {
        return container;
    }

    droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return (
                resource.resourceType === RESOURCE_ENERGY &&
                getStoredEnergyAmount(resource) > 0 &&
                !isIgnoredEnergyTarget(resource, ignoredTargetIds)
            );
        }
    });

    if(droppedEnergy) {
        return droppedEnergy;
    }

    return null;
}

function isIgnoredEnergyTarget(target, ignoredTargetIds) {
    return !!(target && target.id && ignoredTargetIds && ignoredTargetIds[target.id]);
}

module.exports = roleArtificer;
