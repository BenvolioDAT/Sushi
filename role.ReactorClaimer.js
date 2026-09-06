var travel = require('utility.Travel.Creep');
var Season11 = require('Logic.Season11');
var Season11Adapter = require('Season11.Adapter');

function moveFailed(result) {
    var noPath = typeof ERR_NO_PATH !== 'undefined' ? ERR_NO_PATH : -2;
    var invalidTarget = typeof ERR_INVALID_TARGET !== 'undefined' ?
        ERR_INVALID_TARGET : -7;
    var invalidArgs = typeof ERR_INVALID_ARGS !== 'undefined' ? ERR_INVALID_ARGS : -10;
    return result === noPath || result === invalidTarget || result === invalidArgs;
}

var roleReactorClaimer = {
    run: function(creep) {
        if (!creep || creep.spawning || !creep.memory ||
            !Season11.isOperatingMode() || creep.memory.season11ClaimFailed) {
            return;
        }

        var reactorId = creep.memory.season11ReactorId;
        var reactorRoom = creep.memory.season11ReactorRoom;
        var entry = Season11.ensureMemory().reactorPortfolio.reactors[reactorId];
        if (entry && !entry.owned && !entry.claimReady) return;
        var reactor = typeof Game.getObjectById === 'function' ?
            Game.getObjectById(reactorId) : null;

        if (!reactor) {
            if (creep.room.name !== reactorRoom) {
                var routeResult = travel.moveToRoom(creep, reactorRoom, {
                    range: 22,
                    reusePath: 20,
                    allowHostile: false,
                    visualizePathStyle: { stroke: '#ff66cc' }
                });
                if (moveFailed(routeResult)) {
                    Season11.noteRouteFailure(creep.room.name, reactorRoom,
                        creep.name + ' claimant route');
                }
            }
            return;
        }

        if (reactor.my === true) {
            if (creep.pos.getRangeTo(reactor) > 2) {
                travel.move(creep, reactor, { range: 2, reusePath: 10 });
            }
            return;
        }

        if (!Season11.mayClaimReactor(reactor)) {
            return;
        }

        if (!creep.pos.isNearTo(reactor)) {
            travel.move(creep, reactor, {
                range: 1,
                reusePath: 10,
                visualizePathStyle: { stroke: '#ff66cc' }
            });
            return;
        }

        /* The seasonal intent is issued only at the documented adjacent range. */
        if (Season11Adapter.canClaim(creep)) {
            var result = Season11Adapter.claim(creep, reactor);
            Season11.noteClaimResult(reactor.id, result);
            if (result !== 0 && result !== -9 && result !== -11 && result !== -4) creep.memory.season11ClaimFailed = true;
        }
    }
};

module.exports = roleReactorClaimer;
