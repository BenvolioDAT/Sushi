function planSources(ctx, room, plan, reserved, anchor) {
    return ctx.planSourceContainers(room, plan, reserved, anchor);
}

function planController(ctx, room, plan, reserved, anchor) {
    return ctx.planControllerContainer(room, plan, reserved, anchor);
}

function planMineralContainer(ctx, room, plan, reserved, anchor) {
    return ctx.planMineralContainer(room, plan, reserved, anchor);
}

module.exports = {
    planSources: planSources,
    planController: planController,
    planMineralContainer: planMineralContainer
};
