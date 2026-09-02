var cpuStatusUtility = require('CPU.Status');
var Season11 = require('Logic.Season11');
var Season11Operations = require('Season11.Operations');
var TickIndex = require('HiveMind.Index');
var Economy = require('HiveMind.Economy');
var HiveMemory = require('HiveMind.Memory');
var ColonyState = require('HiveMind.ColonyState');

var COLORS = {
    background: '#111111',
    border: '#00ffaa',
    title: '#00ffff',
    text: '#dddddd',
    muted: '#888888',
    good: '#55ff88',
    warning: '#ffcc44',
    danger: '#ff5555'
};

var ROLE_NAMES = [
    'Foreman',
    'Extractor',
    'Freighter',
    'Tech',
    'Artificer',
    'Scout',
    'Ronin',
    'Volley',
    'Cleric',
    'ThoriumMiner',
    'ThoriumHauler',
    'ReactorClaimer'
];

var LINE_HEIGHT = 0.7;
var TEXT_SIZE = 0.55;

function safeNumber(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
}

function percent(value, max) {
    value = safeNumber(value);
    max = safeNumber(max);

    if (max <= 0) {
        return 0;
    }

    return Math.max(0, Math.min(100, (value / max) * 100));
}

function round(value, decimals) {
    var multiplier = Math.pow(10, decimals || 0);
    return Math.round(safeNumber(value) * multiplier) / multiplier;
}

function compactNumber(value) {
    value = safeNumber(value);
    var absolute = Math.abs(value);

    if (absolute >= 1000000) {
        return round(value / 1000000, 1) + 'm';
    }

    if (absolute >= 1000) {
        return round(value / 1000, 1) + 'k';
    }

    return String(round(value, 1));
}

function getHaulAge(lastSeen) {
    return lastSeen > 0 ? Game.time - lastSeen : null;
}

function getAgeColor(age, muted) {
    if (muted || age === null) {
        return COLORS.muted;
    }

    if (age <= 25) {
        return COLORS.good;
    }

    if (age <= 100) {
        return COLORS.warning;
    }

    return COLORS.danger;
}

function truncate(value, maxLength) {
    var text = value === undefined || value === null ? '' : String(value);

    if (text.length <= maxLength) {
        return text;
    }

    return text.substring(0, Math.max(0, maxLength - 1)) + '~';
}

function drawText(visual, text, x, y, color, size, align) {
    visual.text(String(text), x, y, {
        align: align || 'left',
        color: color || COLORS.text,
        font: size || TEXT_SIZE,
        opacity: 0.95,
        stroke: '#000000',
        strokeWidth: 0.08
    });
}

function drawPanel(visual, x, y, width, height, title) {
    visual.rect(x - 0.3, y - 0.5, width, height, {
        fill: COLORS.background,
        opacity: 0.55,
        stroke: COLORS.border,
        strokeWidth: 0.05
    });

    if (title) {
        drawText(visual, title, x, y + 0.05, COLORS.title, 0.62);
        visual.line(x, y + 0.25, x + width - 0.65, y + 0.25, {
            color: COLORS.border,
            opacity: 0.45,
            width: 0.03
        });
    }
}

function drawRow(visual, columns, x, y, columnWidths) {
    var cursor = x;

    for (var i = 0; i < columns.length; i++) {
        var cell = columns[i];
        var text = cell && typeof cell === 'object' ? cell.text : cell;
        var color = cell && typeof cell === 'object' ? cell.color : COLORS.text;
        var size = cell && typeof cell === 'object' ? cell.size : TEXT_SIZE;

        drawText(visual, text, cursor, y, color, size);
        cursor += columnWidths[i] || 0;
    }
}

function getOwnedRooms() {
    var rooms = TickIndex.get().ownedRooms.slice();

    rooms.sort(function(a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    return rooms;
}

function createRoomCreepStats() {
    var roles = {};

    for (var i = 0; i < ROLE_NAMES.length; i++) {
        roles[ROLE_NAMES[i]] = 0;
    }

    return {
        total: 0,
        roles: roles,
        freighters: {
            local: 0,
            remote: 0,
            delivery: 0,
            idle: 0
        }
    };
}

function buildCreepStats() {
    var stats = {
        total: 0,
        byRoom: {},
        freighterDetails: []
    };

    var indexedCreeps = TickIndex.get().allCreeps;
    for (var creepIndex = 0; creepIndex < indexedCreeps.length; creepIndex++) {
        var creep = indexedCreeps[creepIndex];

        if (!creep || !creep.memory) {
            continue;
        }

        stats.total++;

        var homeRoom = creep.memory.homeRoom || (creep.room && creep.room.name);
        if (!homeRoom) {
            continue;
        }

        if (!stats.byRoom[homeRoom]) {
            stats.byRoom[homeRoom] = createRoomCreepStats();
        }

        var roomStats = stats.byRoom[homeRoom];
        var role = creep.memory.role;
        roomStats.total++;

        if (roomStats.roles[role] !== undefined) {
            roomStats.roles[role]++;
        }

        if (role === 'Freighter') {
            if (creep.memory.freighterJob === 'local') {
                roomStats.freighters.local++;
            }
            else if (creep.memory.freighterJob === 'remote') {
                roomStats.freighters.remote++;
            }
            else if (creep.memory.freighterJob === 'remoteDelivery') {
                roomStats.freighters.delivery++;
            }
            else {
                roomStats.freighters.idle++;
            }

            stats.freighterDetails.push({
                job: creep.memory.freighterJob || null,
                pickupRoom: creep.memory.pickupRoom || null,
                legacyRemoteRoom: creep.memory.freighterRemoteRoom ||
                    creep.memory.remoteRoomName || creep.memory.remoteRoom || null,
                pickupSourceId: creep.memory.pickupSourceId ||
                    creep.memory.freighterPickupSourceId || null,
                currentRoom: creep.room && creep.room.name ? creep.room.name : null
            });
        }
    }

    return stats;
}

function getCreepCountsByRole(roomName, creepStats) {
    if (creepStats.byRoom[roomName]) {
        return creepStats.byRoom[roomName];
    }

    return createRoomCreepStats();
}

function getSpawnQueueLength(roomName) {
    var roomMemory = Memory.rooms && Memory.rooms[roomName];
    var queue = roomMemory && roomMemory.spawn && roomMemory.spawn.queue;
    return Array.isArray(queue) ? queue.length : 0;
}

function getBodyCost(body) {
    if (!Array.isArray(body) || typeof BODYPART_COST === 'undefined') {
        return 0;
    }

    var cost = 0;

    for (var i = 0; i < body.length; i++) {
        var part = body[i] && body[i].type ? body[i].type : body[i];
        cost += safeNumber(BODYPART_COST[part]);
    }

    return cost;
}

function getSpawnQueueInfo(roomName) {
    var roomMemory = Memory.rooms && Memory.rooms[roomName];
    var queue = roomMemory && roomMemory.spawn && roomMemory.spawn.queue;
    var first = Array.isArray(queue) && queue.length > 0 ? queue[0] : null;

    return {
        length: getSpawnQueueLength(roomName),
        role: first && first.role ? first.role : null,
        bodyCost: first ? getBodyCost(first.body) : 0
    };
}

function getAssignedMinerCount(assignedMiner) {
    if (Array.isArray(assignedMiner)) {
        return assignedMiner.length;
    }

    return typeof assignedMiner === 'string' && assignedMiner ? 1 : 0;
}

function makeSourceStat(homeRoomName, sourceMemory, sourceId, index) {
    sourceMemory = sourceMemory || {};
    sourceId = sourceMemory.id || sourceId;

    var source = sourceId ? Game.getObjectById(sourceId) : null;
    var hasHaulData = !!sourceMemory.haul;
    var haul = sourceMemory.haul || {};

    return {
        index: index,
        sourceId: sourceId,
        energy: source && typeof source.energy === 'number' ? source.energy : '?',
        assignedMiners: getAssignedMinerCount(sourceMemory.assignedMiner),
        haulTargetId: haul.targetId || null,
        haulAmount: safeNumber(haul.amount),
        reservedCarry: safeNumber(haul.reservedCarry),
        haulLastSeen: safeNumber(haul.lastSeen),
        hasHaulData: hasHaulData,
        containerKnown: !!sourceMemory.containerId,
        containerPlanned: !!(
            sourceMemory.containerPlanned ||
            sourceMemory.containerPlannedPos ||
            sourceMemory.constructionPlanned
        )
    };
}

function getRoomSourceStats(room) {
    var result = [];
    var roomMemory = Memory.rooms && Memory.rooms[room.name];
    var sourceMemory = roomMemory && roomMemory.sources;
    var sourceIds = [];

    if (sourceMemory) {
        for (var sourceId in sourceMemory) {
            if (sourceMemory.hasOwnProperty(sourceId)) {
                sourceIds.push(sourceId);
            }
        }
    }

    sourceIds.sort();

    for (var i = 0; i < sourceIds.length; i++) {
        var id = sourceIds[i];
        result.push(makeSourceStat(room.name, sourceMemory[id], id, i + 1));
    }

    if (result.length === 0) {
        var visibleSources = room.find(FIND_SOURCES);

        for (var j = 0; j < visibleSources.length; j++) {
            result.push(makeSourceStat(room.name, { id: visibleSources[j].id }, visibleSources[j].id, j + 1));
        }
    }

    return result;
}

function getSourceHaulSnapshot(roomName, sourceId) {
    var roomMemory = Memory.rooms && Memory.rooms[roomName];
    var sources = roomMemory && roomMemory.sources;
    var sourceMemory = sources && sources[sourceId];
    var haul = sourceMemory && sourceMemory.haul;

    return {
        hasHaulData: !!haul,
        targetId: haul && haul.targetId ? haul.targetId : null,
        targetType: haul && haul.targetType ? haul.targetType : null,
        amount: haul ? safeNumber(haul.amount) : 0,
        reservedCarry: haul ? safeNumber(haul.reservedCarry) : 0,
        lastSeen: haul ? safeNumber(haul.lastSeen) : 0
    };
}

function getRemoteStats(room) {
    var roomMemory = Memory.rooms && Memory.rooms[room.name];
    var planner = roomMemory && roomMemory.remotePlanner;
    var result = {
        planner: planner,
        activeCount: 0,
        totalIncome: 0,
        active: [],
        rejected: []
    };

    if (!planner) {
        return result;
    }

    var activeSourceIds = Array.isArray(planner.activeSourceIds) ? planner.activeSourceIds : [];
    var sourceInfos = planner.sourceInfos || {};
    var activeLookup = {};

    result.activeCount = activeSourceIds.length;

    for (var i = 0; i < activeSourceIds.length; i++) {
        var sourceId = activeSourceIds[i];
        var info = sourceInfos[sourceId] || {};
        var haul = getSourceHaulSnapshot(info.roomName, sourceId);
        activeLookup[sourceId] = true;
        result.totalIncome += safeNumber(info.netIncome);
        result.active.push({
            sourceId: sourceId,
            roomName: info.roomName || '?',
            distance: safeNumber(info.distance),
            netIncome: safeNumber(info.netIncome),
            haulTargetId: haul.targetId,
            haulTargetType: haul.targetType,
            haulAmount: haul.amount,
            reservedCarry: haul.reservedCarry,
            haulLastSeen: haul.lastSeen,
            hasHaulData: haul.hasHaulData,
            reason: ''
        });
    }

    for (var inactiveSourceId in sourceInfos) {
        if (!sourceInfos.hasOwnProperty(inactiveSourceId) || activeLookup[inactiveSourceId]) {
            continue;
        }

        var inactiveInfo = sourceInfos[inactiveSourceId];
        if (!inactiveInfo || !inactiveInfo.rejectReason) {
            continue;
        }

        result.rejected.push({
            sourceId: inactiveSourceId,
            roomName: inactiveInfo.roomName || '?',
            distance: safeNumber(inactiveInfo.distance),
            netIncome: safeNumber(inactiveInfo.netIncome),
            score: safeNumber(inactiveInfo.score),
            reason: inactiveInfo.rejectReason
        });
    }

    var seenRejects = {};
    for (var rejectedIndex = 0; rejectedIndex < result.rejected.length; rejectedIndex++) {
        seenRejects[result.rejected[rejectedIndex].roomName + ':' + result.rejected[rejectedIndex].reason] = true;
    }

    var remotes = planner.remotes || {};
    for (var remoteRoomName in remotes) {
        if (!remotes.hasOwnProperty(remoteRoomName)) {
            continue;
        }

        var remoteInfo = remotes[remoteRoomName];
        var rejectReason = remoteInfo && (remoteInfo.lastRejectReason || remoteInfo.rejectReason);
        var rejectKey = remoteRoomName + ':' + rejectReason;

        if (!rejectReason || seenRejects[rejectKey]) {
            continue;
        }

        result.rejected.push({
            sourceId: null,
            roomName: remoteRoomName,
            distance: safeNumber(remoteInfo.totalDistance),
            netIncome: safeNumber(remoteInfo.netEnergyPerTick),
            score: safeNumber(remoteInfo.score),
            reason: rejectReason
        });
        seenRejects[rejectKey] = true;
    }

    result.rejected.sort(function(a, b) {
        return a.roomName < b.roomName ? -1 : a.roomName > b.roomName ? 1 : 0;
    });

    return result;
}

function getActiveRemoteRoomsForDashboard(ownedRooms) {
    var groupsByRoom = {};

    for (var i = 0; i < ownedRooms.length; i++) {
        var homeRoom = ownedRooms[i];
        var remoteStats = getRemoteStats(homeRoom);

        for (var j = 0; j < remoteStats.active.length; j++) {
            var active = remoteStats.active[j];
            var remoteRoomName = active.roomName;

            if (!remoteRoomName || remoteRoomName === '?') {
                continue;
            }

            if (!groupsByRoom[remoteRoomName]) {
                groupsByRoom[remoteRoomName] = {
                    roomName: remoteRoomName,
                    homeRoomName: homeRoom.name,
                    sources: [],
                    sourceIds: {},
                    netIncome: 0
                };
            }

            var group = groupsByRoom[remoteRoomName];
            if (group.sourceIds[active.sourceId]) {
                continue;
            }

            group.sourceIds[active.sourceId] = true;
            group.sources.push(active);
            group.netIncome += safeNumber(active.netIncome);
        }
    }

    var groups = [];
    for (var roomName in groupsByRoom) {
        if (groupsByRoom.hasOwnProperty(roomName)) {
            groups.push(groupsByRoom[roomName]);
        }
    }

    groups.sort(function(a, b) {
        return a.roomName < b.roomName ? -1 : a.roomName > b.roomName ? 1 : 0;
    });

    return groups;
}

function getRemoteFreighterCounts(remoteRoomName, sourceIds, creepStats) {
    var result = {
        remote: 0,
        delivery: 0
    };
    var details = creepStats.freighterDetails || [];

    for (var i = 0; i < details.length; i++) {
        var detail = details[i];

        if (detail.job === 'remote' && detail.pickupRoom === remoteRoomName) {
            result.remote++;
            continue;
        }

        if (detail.job !== 'remoteDelivery') {
            continue;
        }

        var matchesRememberedRoom = detail.pickupRoom === remoteRoomName ||
            detail.legacyRemoteRoom === remoteRoomName;
        var matchesRememberedSource = detail.pickupSourceId && sourceIds[detail.pickupSourceId];
        var matchesCurrentRoom = !detail.pickupRoom && !detail.legacyRemoteRoom &&
            !detail.pickupSourceId && detail.currentRoom === remoteRoomName;

        if (matchesRememberedRoom || matchesRememberedSource || matchesCurrentRoom) {
            result.delivery++;
        }
    }

    return result;
}

function getStoredEnergy(structure) {
    if (!structure || !structure.store) {
        return 0;
    }

    if (typeof structure.store.getUsedCapacity === 'function') {
        return safeNumber(structure.store.getUsedCapacity(RESOURCE_ENERGY));
    }

    return safeNumber(structure.store[RESOURCE_ENERGY]);
}

function getRemoteDangerStatus(room) {
    var hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    var invaderCoreType = typeof STRUCTURE_INVADER_CORE !== 'undefined' ?
        STRUCTURE_INVADER_CORE : 'invaderCore';
    var invaderCores = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === invaderCoreType;
        }
    });

    if (hostileCreeps.length > 0 || invaderCores.length > 0) {
        var detail = hostileCreeps.length > 0 ? ' H' + hostileCreeps.length : '';
        detail += invaderCores.length > 0 ? ' Core' : '';

        return {
            text: 'danger' + detail,
            color: COLORS.danger
        };
    }

    return {
        text: 'active',
        color: COLORS.good
    };
}

function getRemoteTargetTypeLabel(targetType) {
    if (targetType === 'container') {
        return 'Cont';
    }

    if (targetType === 'dropped' || targetType === 'drop') {
        return 'Drop';
    }

    return '-';
}

function getLiveRemoteSourceData(remoteRoom, remoteSources) {
    var containers = remoteRoom.find(FIND_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });
    var drops = remoteRoom.find(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY;
        }
    });
    var countedContainers = {};
    var countedDrops = {};
    var result = {
        containerEnergy: 0,
        droppedEnergy: 0,
        reservedCarry: 0,
        worstAge: null,
        sourceRows: []
    };

    for (var i = 0; i < remoteSources.length; i++) {
        var remoteSource = remoteSources[i];
        var source = remoteSource.sourceId ? Game.getObjectById(remoteSource.sourceId) : null;
        var sourceVisible = !!(source && source.pos && source.pos.roomName === remoteRoom.name);
        var sourceContainerEnergy = 0;
        var sourceDroppedEnergy = 0;

        if (sourceVisible) {
            for (var containerIndex = 0; containerIndex < containers.length; containerIndex++) {
                var container = containers[containerIndex];
                if (source.pos.getRangeTo(container) > 2) {
                    continue;
                }

                var containerEnergy = getStoredEnergy(container);
                sourceContainerEnergy += containerEnergy;

                if (!countedContainers[container.id]) {
                    countedContainers[container.id] = true;
                    result.containerEnergy += containerEnergy;
                }
            }

            for (var dropIndex = 0; dropIndex < drops.length; dropIndex++) {
                var drop = drops[dropIndex];
                if (source.pos.getRangeTo(drop) > 3) {
                    continue;
                }

                sourceDroppedEnergy += safeNumber(drop.amount);

                if (!countedDrops[drop.id]) {
                    countedDrops[drop.id] = true;
                    result.droppedEnergy += safeNumber(drop.amount);
                }
            }
        }

        var targetType = remoteSource.haulTargetType;
        var targetLabel = getRemoteTargetTypeLabel(targetType);
        var displayAmount = safeNumber(remoteSource.haulAmount);
        var liveTarget = remoteSource.haulTargetId ? Game.getObjectById(remoteSource.haulTargetId) : null;

        if (targetLabel === 'Cont' && sourceVisible) {
            displayAmount = sourceContainerEnergy;
        }
        else if (targetLabel === 'Drop' && sourceVisible) {
            displayAmount = sourceDroppedEnergy;
        }
        else if (liveTarget && liveTarget.structureType === STRUCTURE_CONTAINER) {
            targetLabel = 'Cont';
            displayAmount = getStoredEnergy(liveTarget);
        }
        else if (liveTarget && liveTarget.resourceType === RESOURCE_ENERGY) {
            targetLabel = 'Drop';
            displayAmount = safeNumber(liveTarget.amount);
        }
        else if (sourceContainerEnergy > 0) {
            targetLabel = 'Cont';
            displayAmount = sourceContainerEnergy;
        }
        else if (sourceDroppedEnergy > 0) {
            targetLabel = 'Drop';
            displayAmount = sourceDroppedEnergy;
        }

        var age = getHaulAge(remoteSource.haulLastSeen);
        if (age !== null && (result.worstAge === null || age > result.worstAge)) {
            result.worstAge = age;
        }

        result.reservedCarry += safeNumber(remoteSource.reservedCarry);
        result.sourceRows.push({
            index: i + 1,
            targetLabel: targetLabel,
            amount: displayAmount,
            reservedCarry: safeNumber(remoteSource.reservedCarry),
            age: age,
            hasHaulData: remoteSource.hasHaulData
        });
    }

    return result;
}

function getSpawnStatus(room, queue) {
    var spawns = room.find(FIND_MY_SPAWNS);

    for (var i = 0; i < spawns.length; i++) {
        var spawn = spawns[i];

        if (!spawn.spawning) {
            continue;
        }

        var spawningName = spawn.spawning.name;
        var spawningCreep = Game.creeps[spawningName];
        var role = spawningCreep && spawningCreep.memory && spawningCreep.memory.role;

        return {
            text: 'Spawn ' + truncate(role || spawningName || 'creep', 12),
            color: COLORS.title
        };
    }

    if (spawns.length === 0) {
        return {
            text: 'Spawn none',
            color: COLORS.danger
        };
    }

    if (queue.length === 0) {
        return {
            text: 'Spawn idle',
            color: COLORS.good
        };
    }

    if (room.energyAvailable < queue.bodyCost) {
        return {
            text: 'Spawn waiting energy',
            color: COLORS.warning
        };
    }

    return {
        text: 'Spawn ready',
        color: COLORS.good
    };
}

function getThreatStatus() {
    var threat = HiveMemory.ensure().warRoom.activeThreat;

    if (!threat) {
        return {
            text: 'Threat none',
            color: COLORS.muted
        };
    }

    var age = threat.lastSeen > 0 ? Game.time - threat.lastSeen : 0;
    var stale = threat.lastSeen > 0 && age > 50;
    var text = stale ? 'Threat stale ' : 'Threat ';
    text += (threat.roomName || '?') + ' ' + (threat.type || '?') + ' ' + (threat.owner || 'unknown');

    if (threat.threatParts) {
        text += ' A' + safeNumber(threat.threatParts.attack) +
            ' R' + safeNumber(threat.threatParts.ranged) +
            ' H' + safeNumber(threat.threatParts.heal) +
            ' W' + safeNumber(threat.threatParts.work);
    }

    return {
        text: text,
        color: COLORS.danger
    };
}

function getBuildCount(room) {
    var count = 0;
    var sites = Game.constructionSites || {};

    for (var siteId in sites) {
        if (!sites.hasOwnProperty(siteId)) {
            continue;
        }

        var site = sites[siteId];
        if (site && site.pos && site.pos.roomName === room.name) {
            count++;
        }
    }

    return count;
}

function getRepairCount(roomName) {
    var roomMemory = Memory.rooms && Memory.rooms[roomName];
    var repairs = roomMemory && roomMemory.RepairStructure;
    return Array.isArray(repairs) ? repairs.length : 0;
}

function getBacklogColor(count, warningAt, dangerAt) {
    return count >= dangerAt ? COLORS.danger :
        count >= warningAt ? COLORS.warning : COLORS.good;
}

function drawGlobalPanel(visual, ownedRoomCount, totalCreeps) {
    var x = 1;
    var y = 1;
    var width = 48;
    var height = 2;
    var cpuStatus = cpuStatusUtility.getCpuStatus();
    var cpuUsed = cpuStatus.used;
    var cpuLimit = cpuStatus.runtimeLimit;
    var bucket = cpuStatus.bucket;
    var cpuColor = cpuLimit > 0 && cpuUsed > cpuLimit ? COLORS.danger :
        cpuLimit > 0 && cpuUsed > cpuLimit * 0.75 ? COLORS.warning : COLORS.good;
    var bucketColor = bucket < 3000 ? COLORS.danger : bucket < 8000 ? COLORS.warning : COLORS.good;

    drawPanel(visual, x, y, width, height, null);
    drawText(visual, 'SUSHI', x, y + 0.35, COLORS.title, 0.72);
    drawText(visual, 'Tick ' + Game.time, x + 4.2, y + 0.35, COLORS.text, 0.6);
    drawText(visual, 'CPU ' + round(cpuUsed, 1) + '/' + compactNumber(cpuLimit), x + 10.1, y + 0.35, cpuColor, 0.6);
    drawText(visual, cpuStatus.mode.toUpperCase(), x + 19, y + 0.35, cpuColor, 0.6);
    drawText(visual, 'Bucket ' + compactNumber(bucket), x + 24.2, y + 0.35, bucketColor, 0.6);
    drawText(visual, 'Rooms ' + ownedRoomCount, x + 33, y + 0.35, COLORS.text, 0.6);
    drawText(visual, 'Creeps ' + totalCreeps, x + 41, y + 0.35, COLORS.text, 0.6);
}

function drawRoomPanel(visual, room, sourceStats, remoteStats, roomCreeps) {
    var x = 1;
    var y = 3.7;
    var width = 18;
    var showRoleCounts = HiveMemory.getConfig('visuals').dashboardShowRoleCounts === true;
    var height = showRoleCounts ? 20.9 : 18.8;
    var controller = room.controller;
    var roomMemory = Memory.rooms && Memory.rooms[room.name];
    var queue = getSpawnQueueInfo(room.name);
    var progressText = controller && controller.progressTotal ?
        round(percent(controller.progress, controller.progressTotal), 1) + '%' : 'max';
    var progressColor = controller && controller.progressTotal && percent(controller.progress, controller.progressTotal) < 25 ?
        COLORS.warning : COLORS.good;
    var storageEnergy = getStoredEnergy(room.storage);
    var terminalEnergy = getStoredEnergy(room.terminal);
    var spawnStatus = getSpawnStatus(room, queue);
    var threatStatus = getThreatStatus();
    var buildCount = getBuildCount(room);
    var repairCount = getRepairCount(room.name);
    var freighters = roomCreeps.freighters;
    var economy = Economy.get(room.name);
    var colony = ColonyState.get(room.name);
    var spawnGovernor = roomMemory && roomMemory.spawn && roomMemory.spawn.governor || {};
    var roles = roomCreeps.roles;
    var hasTechWork = roomMemory && typeof roomMemory.techDesiredWork === 'number';
    var techWorkText = hasTechWork ?
        safeNumber(roomMemory.techLivingWork) + '/' + safeNumber(roomMemory.techDesiredWork) :
        '-/-';
    var techQueuedWork = hasTechWork ? safeNumber(roomMemory.techQueuedWork) : 0;
    var techCpuMultiplier = roomMemory ?
        safeNumber(roomMemory.techCpuMultiplier) : 1;
    var hasArtificerWork = roomMemory &&
        typeof roomMemory.artificerDesiredWork === 'number';
    var artificerWorkText = hasArtificerWork ?
        safeNumber(roomMemory.artificerLivingWork) + '/' +
            safeNumber(roomMemory.artificerDesiredWork) : '-/-';
    var artificerQueuedWork = hasArtificerWork ?
        safeNumber(roomMemory.artificerQueuedWork) : 0;
    var hasExtractorWork = roomMemory &&
        typeof roomMemory.extractorDesiredWork === 'number';
    var extractorWorkText = hasExtractorWork ?
        safeNumber(roomMemory.extractorLivingWork) + '/' +
            safeNumber(roomMemory.extractorDesiredWork) : '-/-';
    var extractorQueuedWork = hasExtractorWork ?
        safeNumber(roomMemory.extractorQueuedWork) : 0;
    var hasFreighterCarry = roomMemory &&
        typeof roomMemory.freighterDesiredCarry === 'number';
    var freighterCarryText = hasFreighterCarry ?
        safeNumber(roomMemory.freighterLivingCarry) + '/' +
            safeNumber(roomMemory.freighterDesiredCarry) : '-/-';
    var freighterQueuedCarry = hasFreighterCarry ?
        safeNumber(roomMemory.freighterQueuedCarry) : 0;
    var remoteBacklog = roomMemory ?
        safeNumber(roomMemory.freighterRemoteBacklog) : 0;
    var worstHaulAge = roomMemory ?
        safeNumber(roomMemory.freighterWorstHaulAge) : 0;
    var rowY = y + 1;

    drawPanel(visual, x, y, width, height, 'ROOM ' + room.name);
    drawRow(visual, ['RCL', controller ? controller.level : 0, 'Progress', { text: progressText, color: progressColor }], x, rowY, [2.3, 2, 4.2, 4]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Storage', { text: room.storage ? compactNumber(storageEnergy) : 'none', color: room.storage ? COLORS.good : COLORS.muted }], x, rowY, [5.3, 5]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Terminal', { text: room.terminal ? compactNumber(terminalEnergy) : 'none', color: room.terminal ? COLORS.good : COLORS.muted }], x, rowY, [5.3, 5]);
    rowY += LINE_HEIGHT;
    drawRow(visual, [
        'Energy',
        safeNumber(room.energyAvailable) + '/' + safeNumber(room.energyCapacityAvailable),
        '|',
        spawnStatus
    ], x, rowY, [3.8, 5.6, 1, 7.2]);
    rowY += LINE_HEIGHT;
    if (economy) {
        var economyColor = economy.state === 'SURVIVAL' ? COLORS.danger :
            economy.state === 'RECOVERY' ? COLORS.warning : COLORS.good;
        drawText(visual, 'ECO ' + economy.state + ' - ' + truncate(economy.reason, 24), x, rowY, economyColor);
        rowY += LINE_HEIGHT;
        drawText(visual, 'Income ' + round(economy.harvest.actualOrEstimatedIncome, 1) + '/' +
            round(economy.harvest.expectedIncome, 1) + ' W ' + economy.harvest.workActive + '/' +
            economy.harvest.workRequired, x, rowY, COLORS.text);
        rowY += LINE_HEIGHT;
        drawText(visual, 'Haul ' + economy.haul.localCarry + '/' + economy.haul.requiredCarry +
            ' backlog ' + compactNumber(economy.haul.backlog), x, rowY, COLORS.text);
        rowY += LINE_HEIGHT;
    }
    if (colony) {
        var lifecycleColor = colony.alert === 'SIEGE' ? COLORS.danger :
            colony.alert === 'THREATENED' ? COLORS.warning : COLORS.good;
        drawText(visual, 'COLONY ' + colony.lifecycle + ' - ' + colony.objective, x, rowY, lifecycleColor);
        rowY += LINE_HEIGHT;
        var growthPhase = colony.lifecycle === 'BOOTSTRAP' || colony.lifecycle === 'GROWTH';
        var growthText = colony.milestoneTimedOut ?
            'Milestone STALLED - ' + truncate(colony.unmet && colony.unmet[0] || colony.milestone, 20) :
            !growthPhase ? 'Lifecycle ACTIVE - band ' + colony.priorityBand :
            colony.growthAllowed ?
                'Growth ACTIVE - ' + (colony.baselineTechRequired ? 'baseline Tech' : 'floor covered') :
                'Growth PAUSED - ' + truncate(colony.blockedReason || colony.reason, 21);
        drawText(visual, growthText, x, rowY,
            colony.milestoneTimedOut || growthPhase && !colony.growthAllowed ? COLORS.warning : COLORS.good);
        rowY += LINE_HEIGHT;
        var floorSuffix = spawnGovernor.mandatoryFloorBypassUsed ? ' +1 floor' : '';
        drawText(visual, 'Governor ' + safeNumber(spawnGovernor.nonCombatTotal) + '/' +
            safeNumber(spawnGovernor.maxCreeps) + floorSuffix + ' Stock ' +
            compactNumber(colony.protectedStockpileEnergy) + ' Down ' +
            compactNumber(colony.controllerDowngradeTicks), x, rowY, COLORS.text);
        rowY += LINE_HEIGHT;
    }
    drawRow(visual, ['Spawn queue', { text: queue.length, color: queue.length > 3 ? COLORS.warning : COLORS.text }], x, rowY, [7, 4]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Next', queue.role ? truncate(queue.role, 9) + ' ' + queue.bodyCost + 'e' : 'none'], x, rowY, [3.2, 12]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Sources', sourceStats.length, 'Remote', { text: remoteStats.activeCount, color: remoteStats.activeCount ? COLORS.good : COLORS.muted }], x, rowY, [4.2, 2, 4.2, 3]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Remote income', { text: round(remoteStats.totalIncome, 2) + '/t', color: remoteStats.totalIncome > 0 ? COLORS.good : COLORS.muted }], x, rowY, [7.4, 6]);
    rowY += LINE_HEIGHT;
    drawText(visual, threatStatus.text, x, rowY, threatStatus.color, 0.5);
    rowY += LINE_HEIGHT;
    drawRow(visual, [
        'Build',
        { text: buildCount, color: getBacklogColor(buildCount, 10, 50) },
        'Repair',
        { text: repairCount, color: getBacklogColor(repairCount, 25, 100) }
    ], x, rowY, [3.4, 2.5, 4.2, 3]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Creeps', roomCreeps.total], x, rowY, [4.2, 3]);
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Extract W ' + extractorWorkText +
            (extractorQueuedWork > 0 ? ' +' + extractorQueuedWork + 'q' : ''),
        x,
        rowY,
        hasExtractorWork ? COLORS.text : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Tech W ' + techWorkText + (techQueuedWork > 0 ? ' +' + techQueuedWork + 'q' : '') +
            ' x' + round(techCpuMultiplier || 1, 2),
        x,
        rowY,
        hasTechWork ? COLORS.text : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Art W ' + artificerWorkText +
            (artificerQueuedWork > 0 ? ' +' + artificerQueuedWork + 'q' : ''),
        x,
        rowY,
        hasArtificerWork ? COLORS.text : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Freight C ' + freighterCarryText +
            (freighterQueuedCarry > 0 ? ' +' + freighterQueuedCarry + 'q' : ''),
        x,
        rowY,
        hasFreighterCarry ? COLORS.text : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Remote haul ' + compactNumber(remoteBacklog) +
            ' age ' + (worstHaulAge > 0 ? worstHaulAge : '-'),
        x,
        rowY,
        remoteBacklog > 0 ? COLORS.text : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Freight L' + freighters.local + ' R' + freighters.remote + ' D' + freighters.delivery + ' I' + freighters.idle,
        x,
        rowY,
        roles.Freighter > 0 ? COLORS.good : COLORS.warning
    );
    rowY += LINE_HEIGHT;

    if (showRoleCounts) {
        drawText(visual, 'Fore ' + roles.Foreman + ' Ext ' + roles.Extractor + ' Tech ' + roles.Tech, x, rowY, COLORS.text);
        rowY += LINE_HEIGHT;
        drawText(visual, 'Art ' + roles.Artificer + ' Scout ' + roles.Scout + ' Ronin ' + roles.Ronin, x, rowY, COLORS.text);
        rowY += LINE_HEIGHT;
        drawText(visual, 'Volley ' + roles.Volley + ' Cleric ' + roles.Cleric, x, rowY, COLORS.text);
    }
}

function drawSourcePanel(visual, sourceStats) {
    var x = 20;
    var y = 3.7;
    var width = 29;
    var height = Math.max(4.2, 2.15 + (sourceStats.length * LINE_HEIGHT));
    var columnWidths = [2, 4, 3.2, 4.2, 4, 3.2, 3.2, 3.2];
    var headerY = y + 1;

    drawPanel(visual, x, y, width, height, 'LOCAL SOURCES');
    drawRow(visual, [
        { text: '#', color: COLORS.title },
        { text: 'Energy', color: COLORS.title },
        { text: 'Ext', color: COLORS.title },
        { text: 'Haul', color: COLORS.title },
        { text: 'Res', color: COLORS.title },
        { text: 'Age', color: COLORS.title },
        { text: 'Cont', color: COLORS.title },
        { text: 'CPlan', color: COLORS.title }
    ], x, headerY, columnWidths);

    for (var i = 0; i < sourceStats.length; i++) {
        var stat = sourceStats[i];
        var rowY = headerY + ((i + 1) * LINE_HEIGHT);
        var haulAge = getHaulAge(stat.haulLastSeen);
        var missingHaulTarget = !stat.hasHaulData || !stat.haulTargetId;
        var haulColor = missingHaulTarget ? COLORS.muted :
            stat.haulAmount > stat.reservedCarry ? COLORS.good : COLORS.warning;

        drawRow(visual, [
            stat.index,
            stat.energy === '?' ? { text: '?', color: COLORS.muted } : compactNumber(stat.energy),
            stat.assignedMiners,
            { text: compactNumber(stat.haulAmount), color: haulColor },
            compactNumber(stat.reservedCarry),
            { text: haulAge === null ? '-' : haulAge, color: getAgeColor(haulAge, missingHaulTarget) },
            { text: stat.containerKnown ? 'Y' : 'N', color: stat.containerKnown ? COLORS.good : COLORS.muted },
            { text: stat.containerPlanned ? 'Y' : 'N', color: stat.containerPlanned ? COLORS.good : COLORS.muted }
        ], x, rowY, columnWidths);
    }

    if (sourceStats.length === 0) {
        drawText(visual, 'No source memory or visible sources', x, headerY + LINE_HEIGHT, COLORS.muted);
    }

    return {
        y: y,
        height: height
    };
}

function drawRemotePanel(visual, remoteStats, sourcePanel) {
    var x = 20;
    var y = sourcePanel.y + sourcePanel.height + 0.5;
    var width = 29;
    var availableRows = Math.max(1, Math.floor((49 - y - 2) / LINE_HEIGHT));
    var totalDataRows = remoteStats.active.length + remoteStats.rejected.length;
    var showHiddenRow = totalDataRows > availableRows;
    var dataCapacity = showHiddenRow ? Math.max(0, availableRows - 1) : availableRows;
    var activeRows = remoteStats.active.slice(0, dataCapacity);
    var remainingRows = dataCapacity - activeRows.length;
    var rejectedRows = remoteStats.rejected.slice(0, Math.max(0, remainingRows));
    var hasRejectedHeader = rejectedRows.length > 0 && remainingRows > rejectedRows.length;
    var shownRows = activeRows.length + rejectedRows.length + (hasRejectedHeader ? 1 : 0) + (showHiddenRow ? 1 : 0);
    var height = Math.max(4.2, 2.15 + (shownRows * LINE_HEIGHT));
    var columnWidths = [6.2, 3.8, 3.2, 3.4, 3.4, 3.4, 5.8];
    var rowY = y + 1;
    var title = remoteStats.planner ?
        'REMOTES ' + remoteStats.activeCount + ' active | ' + round(remoteStats.totalIncome, 2) + '/t' :
        'REMOTES';

    drawPanel(visual, x, y, width, height, title);

    if (!remoteStats.planner) {
        drawText(visual, 'remote planner: none', x, rowY, COLORS.muted);
        return;
    }

    drawRow(visual, [
        { text: 'Room', color: COLORS.title },
        { text: 'Net', color: COLORS.title },
        { text: 'Dist', color: COLORS.title },
        { text: 'Haul', color: COLORS.title },
        { text: 'Res', color: COLORS.title },
        { text: 'Age', color: COLORS.title },
        { text: 'State', color: COLORS.title }
    ], x, rowY, columnWidths);

    for (var i = 0; i < activeRows.length; i++) {
        var active = activeRows[i];
        var age = getHaulAge(active.haulLastSeen);
        var stateColor = !active.hasHaulData || age === null ? COLORS.warning :
            age > 100 ? COLORS.danger :
            age > 25 ? COLORS.warning : COLORS.good;
        rowY += LINE_HEIGHT;
        drawRow(visual, [
            active.roomName,
            { text: round(active.netIncome, 2), color: active.netIncome > 0 ? COLORS.good : COLORS.warning },
            active.distance,
            compactNumber(active.haulAmount),
            compactNumber(active.reservedCarry),
            { text: age === null ? '-' : age, color: getAgeColor(age, !active.hasHaulData) },
            { text: 'active', color: stateColor }
        ], x, rowY, columnWidths);
    }

    if (hasRejectedHeader) {
        rowY += LINE_HEIGHT;
        drawText(visual, 'Inactive / rejected', x, rowY, COLORS.warning, 0.52);
    }

    for (var rejectedIndex = 0; rejectedIndex < rejectedRows.length; rejectedIndex++) {
        var rejected = rejectedRows[rejectedIndex];
        rowY += LINE_HEIGHT;
        drawRow(visual, [
            rejected.roomName,
            { text: round(rejected.netIncome, 2), color: rejected.netIncome > 0 ? COLORS.good : COLORS.warning },
            rejected.distance,
            0,
            0,
            { text: '-', color: COLORS.muted },
            { text: truncate(rejected.reason, 10), color: COLORS.danger }
        ], x, rowY, columnWidths);
    }

    var hiddenRows = remoteStats.active.length + remoteStats.rejected.length - activeRows.length - rejectedRows.length;
    if (hiddenRows > 0) {
        rowY += LINE_HEIGHT;
        drawText(visual, '+' + hiddenRows + ' more', x, rowY, COLORS.muted);
    }
}

function drawSeason11Panel(visual) {
    var diagnostics = Season11.getDiagnostics();
    var operationSummary = Season11Operations.getDashboard();
    var x = 1;
    var y = 20.7;
    var width = 18;
    var height = 10.2;
    var rowY = y + 1;
    var apiColor = diagnostics.apiAvailable ? COLORS.good : COLORS.muted;
    var reactor = diagnostics.selectedReactor;
    var alerts = [];

    for (var i = 0; i < diagnostics.alerts.length; i++) {
        alerts.push(diagnostics.alerts[i].code);
    }

    drawPanel(visual, x, y, width, height, 'SEASON 11');
    drawRow(visual, [
        'Mode',
        { text: diagnostics.mode, color: apiColor },
        diagnostics.apiAvailable ? 'API' : 'NO API'
    ], x, rowY, [3.2, 5.2, 5]);
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Known ' + compactNumber(diagnostics.knownThoriumRemaining) +
            ' Stored ' + compactNumber(diagnostics.storedThorium),
        x,
        rowY,
        diagnostics.knownThoriumRemaining > 0 ? COLORS.text : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Transit ' + compactNumber(diagnostics.inTransit) +
            ' M' + diagnostics.miners + ' H' + diagnostics.haulers +
            ' C' + diagnostics.claimers,
        x,
        rowY,
        diagnostics.inTransit > 0 ? COLORS.good : COLORS.text
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Reactor ' + (reactor ? reactor.roomName : 'none'),
        x,
        rowY,
        reactor ? COLORS.text : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Owner ' + (reactor && reactor.owner ? truncate(reactor.owner, 11) : 'none'),
        x,
        rowY,
        reactor && reactor.my ? COLORS.good : reactor && reactor.owner ?
            COLORS.warning : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        reactor ? 'T ' + reactor.thorium + '/' + reactor.capacity +
            ' continuous ' + compactNumber(reactor.continuousWork) :
            'T -/1000 continuous -',
        x,
        rowY,
        reactor && reactor.thorium > 0 ? COLORS.good : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        reactor ? 'Score ' + reactor.scorePerTick + '/t empty ' +
            reactor.ticksUntilEmpty + ' ETA ' +
            (diagnostics.nextDeliveryEta === null ? '-' : diagnostics.nextDeliveryEta) :
            'Score 0/t empty - ETA -',
        x,
        rowY,
        reactor && reactor.my ? COLORS.text : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Ops ' + (operationSummary.activeOperations || 0) + ' ' +
            (operationSummary.reactorState || 'INERT') +
            ' H' + (operationSummary.harvestOperations || 0) +
            ' L' + (operationSummary.haulOperations || 0),
        x,
        rowY,
        operationSummary.contestThreat > 0 ? COLORS.warning : COLORS.text
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Flow ' + (operationSummary.throughput && operationSummary.throughput.perTick || 0) +
            '/t threat ' + (operationSummary.contestThreat || 0) +
            ' CPU ' + (operationSummary.operationCpu || 0),
        x,
        rowY,
        operationSummary.contestThreat > 0 ? COLORS.danger : COLORS.muted
    );
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        alerts.length > 0 ? 'ALERT ' + truncate(alerts.join(' '), 24) :
            'Alerts none',
        x,
        rowY,
        alerts.length > 0 ? COLORS.danger : COLORS.good,
        0.5
    );
}

function drawRemoteRoomDashboard(remoteRoom, homeRoomName, remoteSources, creepStats) {
    var x = 1;
    var y = 1;
    var width = 22;
    var visual = new RoomVisual(remoteRoom.name);
    var sourceIds = {};
    var netIncome = 0;

    for (var sourceIndex = 0; sourceIndex < remoteSources.length; sourceIndex++) {
        sourceIds[remoteSources[sourceIndex].sourceId] = true;
        netIncome += safeNumber(remoteSources[sourceIndex].netIncome);
    }

    var liveData = getLiveRemoteSourceData(remoteRoom, remoteSources);
    var dangerStatus = getRemoteDangerStatus(remoteRoom);
    var haulers = getRemoteFreighterCounts(remoteRoom.name, sourceIds, creepStats);
    var visibleSourceRows = liveData.sourceRows.slice(0, 4);
    var hiddenSourceCount = liveData.sourceRows.length - visibleSourceRows.length;
    var rowCount = 4 + visibleSourceRows.length + (hiddenSourceCount > 0 ? 1 : 0);
    var height = 2.15 + (rowCount * LINE_HEIGHT);
    var rowY = y + 1;

    drawPanel(visual, x, y, width, height, 'REMOTE ' + homeRoomName + ' -> ' + remoteRoom.name);
    drawRow(visual, [
        'State',
        dangerStatus,
        'Sources',
        remoteSources.length
    ], x, rowY, [3.3, 6.8, 4.2, 3]);
    rowY += LINE_HEIGHT;
    drawRow(visual, [
        'Net',
        { text: round(netIncome, 2) + '/t', color: netIncome > 0 ? COLORS.good : COLORS.warning },
        'Cont',
        { text: compactNumber(liveData.containerEnergy), color: liveData.containerEnergy > 0 ? COLORS.good : COLORS.muted }
    ], x, rowY, [3.3, 6.8, 4.2, 3]);
    rowY += LINE_HEIGHT;
    drawRow(visual, [
        'Drop',
        { text: compactNumber(liveData.droppedEnergy), color: liveData.droppedEnergy > 0 ? COLORS.good : COLORS.muted },
        'Reserved',
        compactNumber(liveData.reservedCarry)
    ], x, rowY, [3.3, 6.8, 4.2, 3]);
    rowY += LINE_HEIGHT;
    drawRow(visual, [
        'Worst age',
        {
            text: liveData.worstAge === null ? '-' : liveData.worstAge,
            color: getAgeColor(liveData.worstAge, liveData.worstAge === null)
        },
        'Haul',
        'R' + haulers.remote + ' D' + haulers.delivery
    ], x, rowY, [5.8, 4.3, 4.2, 3]);

    for (var i = 0; i < visibleSourceRows.length; i++) {
        var sourceRow = visibleSourceRows[i];
        rowY += LINE_HEIGHT;
        drawRow(visual, [
            { text: 'S' + sourceRow.index, color: COLORS.title },
            { text: sourceRow.targetLabel, color: sourceRow.targetLabel === '-' ? COLORS.muted : COLORS.text },
            { text: compactNumber(sourceRow.amount), color: sourceRow.amount > 0 ? COLORS.good : COLORS.muted },
            'Res',
            compactNumber(sourceRow.reservedCarry),
            'Age',
            {
                text: sourceRow.age === null ? '-' : sourceRow.age,
                color: getAgeColor(sourceRow.age, !sourceRow.hasHaulData)
            }
        ], x, rowY, [2, 3.2, 4, 2.6, 3.5, 2.7, 2]);
    }

    if (hiddenSourceCount > 0) {
        rowY += LINE_HEIGHT;
        drawText(visual, '+' + hiddenSourceCount + ' more sources', x, rowY, COLORS.muted);
    }
}

function drawDashboard(room, ownedRoomCount, creepStats) {
    var visual = new RoomVisual(room.name);
    var sourceStats = getRoomSourceStats(room);
    var remoteStats = getRemoteStats(room);
    var roomCreeps = getCreepCountsByRole(room.name, creepStats);

    drawGlobalPanel(visual, ownedRoomCount, creepStats.total);
    drawRoomPanel(visual, room, sourceStats, remoteStats, roomCreeps);
    var sourcePanel = drawSourcePanel(visual, sourceStats);
    drawRemotePanel(visual, remoteStats, sourcePanel);
    drawSeason11Panel(visual);
}

var Dashboard = {
    run: function() {
        var settings = HiveMemory.getConfig('visuals');
        if (settings.showDashboard === false) {
            return;
        }

        var ownedRooms = getOwnedRooms();
        var ownedRoomCount = ownedRooms.length;
        if (ownedRooms.length === 0) {
            return;
        }

        var selectedRoomName = settings.dashboardRoom;
        if (selectedRoomName) {
            var selectedRoom = Game.rooms[selectedRoomName];

            if (!selectedRoom || !selectedRoom.controller || !selectedRoom.controller.my) {
                return;
            }

            ownedRooms = [selectedRoom];
        }

        var creepStats = buildCreepStats();

        for (var i = 0; i < ownedRooms.length; i++) {
            drawDashboard(ownedRooms[i], ownedRoomCount, creepStats);
        }

        if (settings.showRemoteRoomDashboard !== false) {
            var remoteGroups = getActiveRemoteRoomsForDashboard(ownedRooms);

            for (var remoteIndex = 0; remoteIndex < remoteGroups.length; remoteIndex++) {
                var remoteGroup = remoteGroups[remoteIndex];
                var remoteRoom = Game.rooms[remoteGroup.roomName];

                if (!remoteRoom) {
                    continue;
                }

                drawRemoteRoomDashboard(
                    remoteRoom,
                    remoteGroup.homeRoomName,
                    remoteGroup.sources,
                    creepStats
                );
            }
        }
    }
};

module.exports = Dashboard;
