// All roles dispatched as combat units, including the WORK-based breacher.
const roles = new Set(['Ronin', 'Volley', 'Cleric', 'CoreBreaker', 'Breacher']);
module.exports = { isCombatRole: role => roles.has(role) };
