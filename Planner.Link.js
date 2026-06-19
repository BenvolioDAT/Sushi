function planStorage(ctx, room, plan, reserved, anchor) {
    return ctx.planStorageLink(room, plan, reserved, anchor);
}

function planController(ctx, room, plan, reserved, anchor) {
    return ctx.planControllerLink(room, plan, reserved, anchor);
}

function planSources(ctx, room, plan, reserved, anchor) {
    return ctx.planSourceLinks(room, plan, reserved, anchor);
}

module.exports = {
    planStorage: planStorage,
    planController: planController,
    planSources: planSources
};
