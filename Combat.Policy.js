const HiveMemory = require('HiveMind.Memory');

const CLASSIFICATIONS = Object.freeze({
    ALLY: 'ally',
    NEUTRAL: 'neutral',
    HOSTILE: 'hostile',
    NPC: 'npc'
});
const NPC_PLAYERS = new Set(['Invader', 'Source Keeper']);

function usernameOf(subject) {
    if (typeof subject === 'string') return subject;
    return subject && subject.owner && subject.owner.username || null;
}

function ensurePlayer(username) {
    const hive = HiveMemory.ensure();
    if (!username) return null;
    if (!hive.players[username]) {
        hive.players[username] = {
            classification: NPC_PLAYERS.has(username) ? CLASSIFICATIONS.NPC : CLASSIFICATIONS.NEUTRAL,
            manual: false,
            incidentScore: 0,
            lastIncidentTick: null
        };
    }
    return hive.players[username];
}

function decayedIncidentScore(player, tick = Game.time) {
    if (!player || !player.incidentScore || player.lastIncidentTick === null) return 0;
    const settings = HiveMemory.getConfig('combat').diplomacy;
    const halfLife = Math.max(1, settings.incidentHalfLife || 5000);
    return player.incidentScore * Math.pow(0.5, Math.max(0, tick - player.lastIncidentTick) / halfLife);
}

function getClassification(subject) {
    const username = usernameOf(subject);
    if (!username) return CLASSIFICATIONS.NEUTRAL;
    if (NPC_PLAYERS.has(username)) return CLASSIFICATIONS.NPC;
    const player = ensurePlayer(username);
    if (player.manual) return player.classification;
    const threshold = HiveMemory.getConfig('combat').diplomacy.hostileThreshold || 100;
    return decayedIncidentScore(player) >= threshold ? CLASSIFICATIONS.HOSTILE : CLASSIFICATIONS.NEUTRAL;
}

function setClassification(username, classification) {
    if (!Object.values(CLASSIFICATIONS).includes(classification)) return false;
    const player = ensurePlayer(username);
    if (!player) return false;
    player.classification = classification;
    player.manual = true;
    player.updatedTick = Game.time;
    return true;
}

function clearManualClassification(username) {
    const player = ensurePlayer(username);
    if (!player) return false;
    player.manual = false;
    player.classification = NPC_PLAYERS.has(username) ? CLASSIFICATIONS.NPC : CLASSIFICATIONS.NEUTRAL;
    return true;
}

function recordIncident(username, severity, details = {}) {
    const player = ensurePlayer(username);
    if (!player || player.classification === CLASSIFICATIONS.ALLY && player.manual) return player;
    const oldScore = decayedIncidentScore(player);
    player.incidentScore = Math.round((oldScore + Math.max(0, severity || 0)) * 100) / 100;
    player.lastIncidentTick = Game.time;
    player.lastIncident = {
        tick: Game.time,
        roomName: details.roomName || null,
        type: details.type || 'attack',
        targetId: details.targetId || null,
        severity: Math.max(0, severity || 0)
    };
    return player;
}

function isAlly(subject) {
    return getClassification(subject) === CLASSIFICATIONS.ALLY;
}

function isExplicitHostile(subject) {
    const classification = getClassification(subject);
    return classification === CLASSIFICATIONS.HOSTILE || classification === CLASSIFICATIONS.NPC;
}

function shouldDefendAgainst(subject, capabilities = {}, attackedUs = false) {
    const classification = getClassification(subject);
    if (classification === CLASSIFICATIONS.ALLY) return false;
    const harmful = (capabilities.melee || 0) > 0 ||
        (capabilities.ranged || 0) > 0 ||
        (capabilities.claim || 0) > 0;
    const potentialDismantle = (capabilities.dismantle || 0) > 0;
    if (classification === CLASSIFICATIONS.HOSTILE || classification === CLASSIFICATIONS.NPC) {
        return harmful || potentialDismantle || (capabilities.heal || 0) > 0;
    }
    return attackedUs || harmful;
}

function mayLaunchOffense(subject, manualDirective = false) {
    if (isAlly(subject)) return false;
    return manualDirective === true || isExplicitHostile(subject);
}

module.exports = {
    CLASSIFICATIONS,
    usernameOf,
    ensurePlayer,
    getClassification,
    setClassification,
    clearManualClassification,
    recordIncident,
    decayedIncidentScore,
    isAlly,
    isExplicitHostile,
    shouldDefendAgainst,
    mayLaunchOffense
};
