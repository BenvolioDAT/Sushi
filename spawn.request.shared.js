/* Dependency-free accounting helpers shared by spawn request systems. */

function addCount(map, key, amount) {
    if (key) {
        map[key] = (map[key] || 0) + (amount || 1);
    }
}

function addBodyPartCount(map, role, partType, amount) {
    if (!role || !partType || amount <= 0) {
        return;
    }
    if (!map[role]) {
        map[role] = {};
    }
    addCount(map[role], partType, amount);
}

function getBodyPartCount(map, role, partType) {
    return map && map[role] ? map[role][partType] || 0 : 0;
}

function countBodyParts(body, bodyPartType) {
    let count = 0;
    for (let i = 0; body && i < body.length; i++) {
        if (body[i] === bodyPartType) {
            count++;
        }
    }
    return count;
}

function countQueueRequestsAtTick(queue, tick) {
    let count = 0;
    for (let i = 0; queue && i < queue.length; i++) {
        if (queue[i] && queue[i].requestedAt === tick) {
            count++;
        }
    }
    return count;
}

function sortSpawnQueue(queue) {
    if (!queue) {
        return;
    }
    queue.sort(function (a, b) {
        return b.priority !== a.priority ?
            b.priority - a.priority : a.requestedAt - b.requestedAt;
    });
}

module.exports = {
    addCount: addCount,
    addBodyPartCount: addBodyPartCount,
    getBodyPartCount: getBodyPartCount,
    countBodyParts: countBodyParts,
    countQueueRequestsAtTick: countQueueRequestsAtTick,
    sortSpawnQueue: sortSpawnQueue
};
