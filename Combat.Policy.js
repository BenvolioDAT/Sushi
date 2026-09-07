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
    if (NPC_PLAYERS.has(username)) {
        hive.players[username].classification = CLASSIFICATIONS.NPC;
        hive.players[username].manual = false;
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
    if (NPC_PLAYERS.has(username)) return ensurePlayer(username).classification;
    const player = ensurePlayer(username);
    if (player.manual) return player.classification;
    const threshold = HiveMemory.getConfig('combat').diplomacy.hostileThreshold || 100;
    player.classification = decayedIncidentScore(player) >= threshold ? CLASSIFICATIONS.HOSTILE : CLASSIFICATIONS.NEUTRAL;
    return player.classification;
}

function setClassification(username, classification) {
    if (!Object.values(CLASSIFICATIONS).includes(classification)) return false;
    if (NPC_PLAYERS.has(username) || classification === CLASSIFICATIONS.NPC) return false;
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
    getClassification(username);
    return player;
}

function isAlly(subject) {
    return getClassification(subject) === CLASSIFICATIONS.ALLY;
}

function isExplicitHostile(subject) {
    const classification = getClassification(subject);
    return classification === CLASSIFICATIONS.HOSTILE || classification === CLASSIFICATIONS.NPC;
}

// Danger is an economic/tactical signal, never permission to attack.
function isDangerous(subject, capabilities = {}, context = {}) {
    const classification = getClassification(subject);
    if (classification === CLASSIFICATIONS.ALLY) return false;
    if (context.attackedUs || classification === CLASSIFICATIONS.NPC || classification === CLASSIFICATIONS.HOSTILE) return true;
    return (capabilities.melee || 0) > 0 || (capabilities.ranged || 0) > 0 ||
        (capabilities.claim || 0) > 0 || (capabilities.heal || 0) > 0 && context.supportingArmed === true;
}

function playerResponseMode() {
    const mode = HiveMemory.getConfig('combat').diplomacy.playerResponseMode;
    return ['defend', 'war'].includes(mode) ? mode : 'observe';
}

// Use the planner's selected/established sources, including temporarily unsafe ones.
function isDefenseRoom(roomName) {
    if (!roomName) return false;
    const room = Game.rooms && Game.rooms[roomName];
    if (room && room.controller && room.controller.my) return true;
    for (const memory of Object.values(Memory.rooms || {})) {
        const planner = memory && memory.remotePlanner;
        if (!planner) continue;
        const active = new Set(planner.activeSourceIds || []);
        for (const [id, info] of Object.entries(planner.sourceInfos || {})) {
            if (!info || !(active.has(id) || info.active || info.established ||
                ['ACTIVE', 'BOOTSTRAPPING', 'DEGRADED', 'SUSPENDED_ECONOMY'].includes(info.state))) continue;
            if (info.roomName === roomName || (info.route && info.route.roomSequence || []).includes(roomName)) return true;
        }
        const remote = planner.remotes && planner.remotes[roomName];
        if (remote && (remote.active || remote.status === 'active' || remote.managed === true)) return true;
    }
    return false;
}

function autoEngageReason(subject, context = {}) {
    const classification = getClassification(subject);
    if (classification === CLASSIFICATIONS.ALLY) return 'ALLY';
    if (classification === CLASSIFICATIONS.NPC) {
        if (HiveMemory.getConfig('combat').diplomacy.npcAutoDefense === false) return 'NPC_DEFENSE_DISABLED';
    } else {
        if (playerResponseMode() === 'observe') return 'PLAYER_OBSERVE_MODE';
        const player = ensurePlayer(usernameOf(subject));
        const recentIncident = player && player.lastIncident && Game.time - player.lastIncident.tick <= 1500;
        if (classification !== CLASSIFICATIONS.HOSTILE && !context.attackedUs && !recentIncident) return 'NO_CONFIRMED_AGGRESSION';
    }
    if (!isDefenseRoom(context.roomName)) return 'NO_ACTIVE_COLONY_INTEREST';
    return 'AUTO_DEFENSE_ALLOWED';
}

function mayAutoDefendAgainst(subject, context = {}) {
    return autoEngageReason(subject, context) === 'AUTO_DEFENSE_ALLOWED';
}

function mayAutoEngage(subject, context = {}) {
    return mayAutoDefendAgainst(subject, context);
}

// Compatibility helper for targeting consumers; safety consumers use isDangerous.
function shouldDefendAgainst(subject, capabilities = {}, attackedUs = false) {
    const roomName = subject && (subject.room && subject.room.name || subject.pos && subject.pos.roomName);
    return isDangerous(subject, capabilities, { attackedUs }) && mayAutoDefendAgainst(subject, { roomName, attackedUs });
}

function mayLaunchOffense(subject, manualDirective = false) {
    if (isAlly(subject)) return false;
    if (manualDirective === true) return true;
    if (getClassification(subject) === CLASSIFICATIONS.NPC) return HiveMemory.getConfig('combat').diplomacy.npcAutoDefense !== false;
    return playerResponseMode() === 'war' && getClassification(subject) === CLASSIFICATIONS.HOSTILE;
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
    isDangerous,
    isDefenseRoom,
    playerResponseMode,
    autoEngageReason,
    mayAutoDefendAgainst,
    mayAutoEngage,
    shouldDefendAgainst,
    mayLaunchOffense
};
