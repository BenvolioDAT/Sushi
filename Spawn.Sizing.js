/* Bounded energy reservations. Recomputed bodies are cached until capability or
 * capacity changes; ordinary energy refills never restart the wait deadline. */
const Bodies = require('BodyProfiles');
const Harvest = require('Harvest.Planning');
const WAIT_TICKS = 20;
function evaluate(room, request, preview, urgent) {
    const capacity = Harvest.energyCapacity(room);
    const economy = require('HiveMind.Economy').get(room.name);
    const signature = [capacity, request.requestedWorkParts, request.minimumWorkParts,
        request.requestedCarryParts, request.maxCarryParts,
        request.bodyProfile?.desiredWork, request.bodyProfile?.desiredCarry,
        !!request.bodyRequirements?.fixed, request.bodyRequirements?.fixed ? request.body.join(',') : request.role].join(':');
    let wait = request.spawnSizing;
    if (!wait || wait.signature !== signature || wait.since > Game.time) {
        let preferred = null;
        if (request.role === 'Extractor' && !request.bodyRequirements?.fixed)
            preferred = Harvest.body(room, request.requestedWorkParts || request.maxWorkParts || Bodies.metrics(request.body).WORK);
        if (request.role === 'Freighter' && !request.bodyRequirements?.fixed)
            preferred = Bodies.build('Freighter', { energyCapacity: capacity,
                desiredCarry: Math.min(request.requestedCarryParts || request.maxCarryParts || Bodies.metrics(request.body).CARRY,
                    Bodies.metrics(request.body).CARRY),
                provenRoads: request.bodyProfile?.provenRoads, routeProfile: request.bodyProfile?.routeProfile });
        const previousDeadline = request.role === 'Freighter' && wait && wait.since <= Game.time && wait.deadline;
        wait = request.spawnSizing = { signature, since: Game.time, deadline: previousDeadline || Game.time + WAIT_TICKS,
            preferredCost: preferred?.cost || Bodies.cost(request.body), lastEnergy: room.energyAvailable,
            lastProgress: Game.time };
    }
    if (room.energyAvailable > wait.lastEnergy) wait.lastProgress = Game.time;
    wait.lastEnergy = room.energyAvailable;
    const impossible = wait.preferredCost > capacity || !capacity;
    const efficientHauler = request.role === 'Freighter' && !request.freighterRenewal &&
        !request.bodyRequirements?.fixed && !request.replacementFor;
    const fundedHauler = efficientHauler && economy && ['STABLE', 'SURPLUS'].includes(economy.state) &&
        (economy.growth?.energyAboveReserve || 0) >= wait.preferredCost;
    const deteriorating = economy && (economy.state === 'SURVIVAL' || economy.energyTrend < -1 && !fundedHauler ||
        (economy.harvest?.actualOrEstimatedIncome || 0) <= 0 || economy.haul?.localCarry === 0);
    // Deterioration or urgent work ends an existing discretionary wait for good.
    if ((urgent || deteriorating) && preview.selection.affordable || Game.time >= wait.deadline) wait.released = true;
    const reserve = !impossible && !wait.released;
    const preferLarger = (request.role === 'Extractor' || efficientHauler) && preview.selection.affordable &&
        Bodies.cost(preview.body) < wait.preferredCost && economy && !urgent && !deteriorating;
    return { capacity, preferredCost: wait.preferredCost, reserve,
        wait: !!(preferLarger && reserve), reason: impossible ? 'insufficient maximum spawning capacity' :
            preferLarger && reserve ? (efficientHauler ? 'bounded wait for efficient hauling body' : 'bounded wait for efficient miner body') :
                wait.released ? 'spawn wait released; use affordable productive body' :
                    !preview.selection.affordable ? 'insufficient current energy' : 'affordable productive body' };
}
module.exports = { evaluate, WAIT_TICKS };
