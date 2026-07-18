const roles = {
    Foreman: require('role.Foreman'),
    Extractor: require('role.Extractor'),
    Tech: require('role.Tech'),
    Freighter: require('role.Freighter'),
    Annex: require('role.Annex'),
    Artificer: require('role.Artificer'),
    Pioneer: require('role.Pioneer'),
    SupplyRunner: require('role.SupplyRunner'),
    Scout: require('role.Scout'),
    Ronin: require('role.Ronin'),
    Volley: require('role.Volley'),
    Cleric: require('role.Cleric'),
    ScoreRunner: require('role.scorerunner')
};

function run() {
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        const role = creep && creep.memory ? roles[creep.memory.role] : null;
        if (role && typeof role.run === 'function') {
            role.run(creep);
        }
    }
}

module.exports = {
    run: run,
    roles: roles
};
