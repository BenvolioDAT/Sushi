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
    ThoriumMiner: require('role.ThoriumMiner'),
    ThoriumHauler: require('role.ThoriumHauler'),
    ReactorClaimer: require('role.ReactorClaimer'),
    MineralMiner: require('role.MineralMiner'),
    ResourceCourier: require('role.ResourceCourier')
};
const TickIndex = require('HiveMind.Index');
const SquadController = require('Squad.Controller');

function run() {
    const squadControlled = SquadController.execute();
    for (const creep of TickIndex.get().allCreeps) {
        if (squadControlled.has(creep.name)) continue;
        const role = creep && creep.memory ? roles[creep.memory.role] : null;
        if (role && typeof role.run === 'function') role.run(creep);
    }
}

module.exports = { run, roles };
