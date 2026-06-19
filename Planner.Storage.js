function pickAnchor(ctx, room, oldPlan, spawns) {
    return ctx.pickStorageAnchor(room, oldPlan, spawns);
}

module.exports = {
    pickAnchor: pickAnchor
};
