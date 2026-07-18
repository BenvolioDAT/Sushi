/* CPU budget policy for the spawn-request facade. */

function getPlanningScale(cpuStatus) {
    if (cpuStatus.mode === 'high') {
        return Math.min(2.5, Math.max(1, cpuStatus.limit / 30));
    }
    return cpuStatus.mode === 'critical' ? 0.5 : 1;
}

function getPlanningBudget(cpuStatus, cpuPolicy) {
    return Math.max(0.25, Math.min(
        cpuStatus.remaining,
        cpuPolicy.spawnPlanningCpuBudget * getPlanningScale(cpuStatus)
    ));
}

function shouldSkipNormalPlanning(cpuStatus, used, budget) {
    return cpuStatus.mode === 'critical' || used > budget;
}

module.exports = {
    getPlanningScale: getPlanningScale,
    getPlanningBudget: getPlanningBudget,
    shouldSkipNormalPlanning: shouldSkipNormalPlanning
};
