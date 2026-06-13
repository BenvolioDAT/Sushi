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
    'ScoreRunner'
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
    var rooms = [];

    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];

        if (room && room.controller && room.controller.my) {
            rooms.push(room);
        }
    }

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
        byRoom: {}
    };

    for (var creepName in Game.creeps) {
        var creep = Game.creeps[creepName];

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
    var queue = roomMemory && roomMemory.spawnQueue;
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
    var queue = roomMemory && roomMemory.spawnQueue;
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

function packCoord(pos) {
    return pos.x + (pos.y * 50);
}

function hasPlannedRoadNearSource(homeRoomName, source) {
    if (!homeRoomName || !source || !source.pos) {
        return false;
    }

    var homeMemory = Memory.rooms && Memory.rooms[homeRoomName];
    var roadPlanner = homeMemory && homeMemory.roadPlanner;

    if (!roadPlanner || !roadPlanner.rooms) {
        return false;
    }

    var roomPlan = roadPlanner.rooms[source.pos.roomName];

    if (!roomPlan || !Array.isArray(roomPlan.roadCoords)) {
        return false;
    }

    var roadLookup = {};

    for (var i = 0; i < roomPlan.roadCoords.length; i++) {
        roadLookup[roomPlan.roadCoords[i]] = true;
    }

    for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
            var x = source.pos.x + dx;
            var y = source.pos.y + dy;

            if (x < 0 || x > 49 || y < 0 || y > 49) {
                continue;
            }

            if (roadLookup[packCoord({ x: x, y: y })]) {
                return true;
            }
        }
    }

    return false;
}

function makeSourceStat(homeRoomName, sourceMemory, sourceId, index) {
    sourceMemory = sourceMemory || {};
    sourceId = sourceMemory.id || sourceId;

    var source = sourceId ? Game.getObjectById(sourceId) : null;
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
        containerKnown: !!sourceMemory.containerId,
        roadPlanned: source ?
            hasPlannedRoadNearSource(homeRoomName, source) :
            !!sourceMemory.roadPlanned,
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
        activeLookup[sourceId] = true;
        result.totalIncome += safeNumber(info.netIncome);
        result.active.push({
            sourceId: sourceId,
            roomName: info.roomName || '?',
            distance: safeNumber(info.distance),
            netIncome: safeNumber(info.netIncome),
            score: safeNumber(info.score),
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

function getStoredEnergy(structure) {
    if (!structure || !structure.store) {
        return 0;
    }

    if (typeof structure.store.getUsedCapacity === 'function') {
        return safeNumber(structure.store.getUsedCapacity(RESOURCE_ENERGY));
    }

    return safeNumber(structure.store[RESOURCE_ENERGY]);
}

function drawGlobalPanel(visual, ownedRoomCount, totalCreeps) {
    var x = 1;
    var y = 1;
    var width = 48;
    var height = 2;
    var cpuUsed = Game.cpu && Game.cpu.getUsed ? Game.cpu.getUsed() : 0;
    var cpuLimit = Game.cpu ? safeNumber(Game.cpu.limit) : 0;
    var tickLimit = Game.cpu ? safeNumber(Game.cpu.tickLimit) : 0;
    var bucket = Game.cpu ? safeNumber(Game.cpu.bucket) : 0;
    var cpuColor = cpuLimit > 0 && cpuUsed > cpuLimit ? COLORS.danger :
        cpuLimit > 0 && cpuUsed > cpuLimit * 0.75 ? COLORS.warning : COLORS.good;
    var bucketColor = bucket < 3000 ? COLORS.danger : bucket < 8000 ? COLORS.warning : COLORS.good;

    drawPanel(visual, x, y, width, height, null);
    drawText(visual, 'SUSHI', x, y + 0.35, COLORS.title, 0.72);
    drawText(visual, 'Tick ' + Game.time, x + 4.2, y + 0.35, COLORS.text, 0.6);
    drawText(visual, 'CPU ' + round(cpuUsed, 1) + '/' + compactNumber(cpuLimit), x + 10.1, y + 0.35, cpuColor, 0.6);
    drawText(visual, 'TickLimit ' + compactNumber(tickLimit), x + 18.2, y + 0.35, COLORS.text, 0.6);
    drawText(visual, 'Bucket ' + compactNumber(bucket), x + 28.2, y + 0.35, bucketColor, 0.6);
    drawText(visual, 'Rooms ' + ownedRoomCount, x + 37.2, y + 0.35, COLORS.text, 0.6);
    drawText(visual, 'Creeps ' + totalCreeps, x + 43, y + 0.35, COLORS.text, 0.6);
}

function drawRoomPanel(visual, room, sourceStats, remoteStats, roomCreeps) {
    var x = 1;
    var y = 3.7;
    var width = 18;
    var height = 12.2;
    var controller = room.controller;
    var queue = getSpawnQueueInfo(room.name);
    var progressText = controller && controller.progressTotal ?
        round(percent(controller.progress, controller.progressTotal), 1) + '%' : 'max';
    var progressColor = controller && controller.progressTotal && percent(controller.progress, controller.progressTotal) < 25 ?
        COLORS.warning : COLORS.good;
    var storageEnergy = getStoredEnergy(room.storage);
    var terminalEnergy = getStoredEnergy(room.terminal);
    var freighters = roomCreeps.freighters;
    var roles = roomCreeps.roles;
    var rowY = y + 1;

    drawPanel(visual, x, y, width, height, 'ROOM ' + room.name);
    drawRow(visual, ['RCL', controller ? controller.level : 0, 'Progress', { text: progressText, color: progressColor }], x, rowY, [2.3, 2, 4.2, 4]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Storage', { text: room.storage ? compactNumber(storageEnergy) : 'none', color: room.storage ? COLORS.good : COLORS.muted }], x, rowY, [5.3, 5]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Terminal', { text: room.terminal ? compactNumber(terminalEnergy) : 'none', color: room.terminal ? COLORS.good : COLORS.muted }], x, rowY, [5.3, 5]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Spawn queue', { text: queue.length, color: queue.length > 3 ? COLORS.warning : COLORS.text }], x, rowY, [7, 4]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Next', queue.role ? truncate(queue.role, 9) + ' ' + queue.bodyCost + 'e' : 'none'], x, rowY, [3.2, 12]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Sources', sourceStats.length, 'Remote', { text: remoteStats.activeCount, color: remoteStats.activeCount ? COLORS.good : COLORS.muted }], x, rowY, [4.2, 2, 4.2, 3]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Remote income', { text: round(remoteStats.totalIncome, 2) + '/t', color: remoteStats.totalIncome > 0 ? COLORS.good : COLORS.muted }], x, rowY, [7.4, 6]);
    rowY += LINE_HEIGHT;
    drawRow(visual, ['Creeps', roomCreeps.total], x, rowY, [4.2, 3]);
    rowY += LINE_HEIGHT;
    drawText(
        visual,
        'Freight L' + freighters.local + ' R' + freighters.remote + ' D' + freighters.delivery + ' I' + freighters.idle,
        x,
        rowY,
        roles.Freighter > 0 ? COLORS.good : COLORS.warning
    );
    rowY += LINE_HEIGHT;
    drawText(visual, 'Fore ' + roles.Foreman + ' Ext ' + roles.Extractor + ' Tech ' + roles.Tech, x, rowY, COLORS.text);
    rowY += LINE_HEIGHT;
    drawText(visual, 'Art ' + roles.Artificer + ' Scout ' + roles.Scout + ' Ronin ' + roles.Ronin, x, rowY, COLORS.text);
    rowY += LINE_HEIGHT;
    drawText(visual, 'Volley ' + roles.Volley + ' Cleric ' + roles.Cleric + ' Score ' + roles.ScoreRunner, x, rowY, COLORS.text);
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
        { text: 'Cont', color: COLORS.title },
        { text: 'Road', color: COLORS.title },
        { text: 'CPlan', color: COLORS.title }
    ], x, headerY, columnWidths);

    for (var i = 0; i < sourceStats.length; i++) {
        var stat = sourceStats[i];
        var rowY = headerY + ((i + 1) * LINE_HEIGHT);
        var haulAge = stat.haulLastSeen > 0 ? Game.time - stat.haulLastSeen : 0;
        var haulColor = !stat.haulTargetId || stat.haulAmount <= 0 ? COLORS.muted :
            haulAge > 25 ? COLORS.danger :
            stat.haulAmount > stat.reservedCarry ? COLORS.good : COLORS.warning;

        drawRow(visual, [
            stat.index,
            stat.energy === '?' ? { text: '?', color: COLORS.muted } : compactNumber(stat.energy),
            stat.assignedMiners,
            { text: compactNumber(stat.haulAmount), color: haulColor },
            compactNumber(stat.reservedCarry),
            { text: stat.containerKnown ? 'Y' : 'N', color: stat.containerKnown ? COLORS.good : COLORS.muted },
            { text: stat.roadPlanned ? 'Y' : 'N', color: stat.roadPlanned ? COLORS.good : COLORS.muted },
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
    var columnWidths = [7, 4.5, 4.5, 3.5, 8.5];
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
        { text: 'Score', color: COLORS.title },
        { text: 'Dist', color: COLORS.title },
        { text: 'State', color: COLORS.title }
    ], x, rowY, columnWidths);

    for (var i = 0; i < activeRows.length; i++) {
        var active = activeRows[i];
        rowY += LINE_HEIGHT;
        drawRow(visual, [
            active.roomName,
            { text: round(active.netIncome, 2), color: active.netIncome > 0 ? COLORS.good : COLORS.warning },
            round(active.score, 2),
            active.distance,
            { text: 'active', color: COLORS.good }
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
            round(rejected.netIncome, 2),
            round(rejected.score, 2),
            rejected.distance,
            { text: truncate(rejected.reason, 14), color: COLORS.danger }
        ], x, rowY, columnWidths);
    }

    var hiddenRows = remoteStats.active.length + remoteStats.rejected.length - activeRows.length - rejectedRows.length;
    if (hiddenRows > 0) {
        rowY += LINE_HEIGHT;
        drawText(visual, '+' + hiddenRows + ' more', x, rowY, COLORS.muted);
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
}

var Dashboard = {
    run: function() {
        if (!Memory.settings) {
            Memory.settings = {};
        }

        if (Memory.settings.showDashboard === undefined) {
            Memory.settings.showDashboard = true;
        }

        if (Memory.settings.showDashboard === false) {
            return;
        }

        var ownedRooms = getOwnedRooms();
        var ownedRoomCount = ownedRooms.length;
        if (ownedRooms.length === 0) {
            return;
        }

        var selectedRoomName = Memory.settings.dashboardRoom;
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
    }
};

module.exports = Dashboard;
