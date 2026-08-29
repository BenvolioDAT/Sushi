function resourceType() {
    return typeof RESOURCE_THORIUM !== 'undefined' ? RESOURCE_THORIUM : null;
}

function reactorFindConstant() {
    return typeof FIND_REACTORS !== 'undefined' ? FIND_REACTORS : null;
}

function isAvailable() {
    return resourceType() !== null && reactorFindConstant() !== null;
}

function canClaim(creep) {
    if (creep) return typeof creep.claimReactor === 'function';
    return typeof Creep !== 'undefined' && Creep.prototype && typeof Creep.prototype.claimReactor === 'function';
}

function findReactors(room) {
    if (!room || typeof room.find !== 'function' || reactorFindConstant() === null) return [];
    try {
        return room.find(reactorFindConstant()) || [];
    }
    catch (error) {
        return [];
    }
}

function claim(creep, reactor) {
    if (!creep || !reactor) return typeof ERR_INVALID_ARGS !== 'undefined' ? ERR_INVALID_ARGS : -10;
    if (!canClaim(creep)) return typeof ERR_INVALID_TARGET !== 'undefined' ? ERR_INVALID_TARGET : -7;
    return creep.claimReactor(reactor);
}

function harvestThorium(creep, mineral) {
    if (!creep || !mineral) return typeof ERR_INVALID_ARGS !== 'undefined' ? ERR_INVALID_ARGS : -10;
    if (!isAvailable() || mineral.mineralType !== resourceType() || typeof creep.harvest !== 'function') {
        return typeof ERR_INVALID_TARGET !== 'undefined' ? ERR_INVALID_TARGET : -7;
    }
    return creep.harvest(mineral);
}

function storeAmount(reactor) {
    const type = resourceType();
    if (!reactor || !reactor.store || !type) return 0;
    return typeof reactor.store.getUsedCapacity === 'function' ?
        reactor.store.getUsedCapacity(type) || 0 : reactor.store[type] || 0;
}

function storeCapacity(reactor) {
    const type = resourceType();
    if (!reactor || !reactor.store || !type) return 0;
    return typeof reactor.store.getCapacity === 'function' ?
        reactor.store.getCapacity(type) || 0 : reactor.storeCapacity || 0;
}

function snapshot(reactor) {
    if (!reactor || !reactor.id) return null;
    return {
        id: reactor.id,
        roomName: reactor.pos && reactor.pos.roomName || reactor.room && reactor.room.name || null,
        x: reactor.pos && reactor.pos.x,
        y: reactor.pos && reactor.pos.y,
        my: reactor.my === true,
        owner: reactor.owner && reactor.owner.username || null,
        thorium: storeAmount(reactor),
        capacity: storeCapacity(reactor),
        continuousWork: Math.max(0, Number(reactor.continuousWork) || 0)
    };
}

function capabilities() {
    return {
        available: isAvailable(),
        resourceType: resourceType(),
        reactorFindConstant: reactorFindConstant(),
        claim: canClaim()
    };
}

module.exports = {
    resourceType,
    reactorFindConstant,
    isAvailable,
    canClaim,
    findReactors,
    claim,
    harvestThorium,
    storeAmount,
    storeCapacity,
    snapshot,
    capabilities
};
