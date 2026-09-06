const HiveMemory = require('HiveMind.Memory');
const Index = require('HiveMind.Index');
const CPU = require('CPU.Status');
const Bodies = require('BodyProfiles');
const DEFAULTS = { interval: 5, absoluteMaximum: 150, spawnTarget: 0.75, queueHorizon: 300,
    cpuCritical: 0.55, cpuLow: 0.65, cpuHealthy: 0.78, cpuFull: 0.83 };
const safe = (v, fallback = 0) => Number.isFinite(v) ? Math.max(0, v) : fallback;
function config() { return Object.assign({}, DEFAULTS, HiveMemory.getConfig('capacity')); }
function roleCpu(role) {
    const hive = HiveMemory.ensure(), sample = hive.telemetry.populationRoles;
    const rolling = global.__sushiCpuRolling || hive.telemetry.cpu || {};
    const population = hive.capacity && Object.values(hive.capacity.rooms).reduce((sum, room) => sum + room.population.current, 0) || 0;
    const overhead = population ? ((rolling.phases || {}).traffic || 0) / population : 0;
    return Math.max(0.05, sample && sample[role] && sample[role].cpu || 0.2) + overhead;
}
function classify(request) {
    const m = request.memory || {}, role = request.role || m.role;
    const category = require('HiveMind.Economy').categoryForRequest(request);
    if (['controllerSafety', 'criticalController', 'criticalMaintenance', 'criticalInfrastructure', 'emergencyDefense', 'spawnFill'].includes(category) ||
        m.controllerGrowthFloor || role === 'Foreman') return 'MANDATORY';
    if (m.season11ReactorId || /^Thorium|Reactor/.test(role || '')) return 'STRATEGIC';
    if (['remoteMaintenance', 'remoteBootstrap', 'remoteIntel', 'resources', 'logistics', 'harvest'].includes(category)) return 'ECONOMIC';
    if (role === 'Tech') return 'GROWTH';
    if (role === 'Artificer') return 'INFRASTRUCTURE';
    if (['Ronin', 'Volley', 'Cleric'].includes(role)) return 'MILITARY';
    return 'STRATEGIC';
}
function cpuView(status, rolling, settings) {
    const target = status.bucket < 1800 ? settings.cpuCritical : status.bucket < 5000 ? settings.cpuLow :
        status.bucket >= 9500 ? settings.cpuFull : settings.cpuHealthy;
    const ceiling = status.limit * Math.min(0.9, Math.max(0.5, target));
    const used = safe(rolling && rolling.total, status.limit * 0.65);
    return { limit: status.limit, rollingUsed: used, targetCeiling: ceiling, bucket: status.bucket,
        headroom: Math.max(0, ceiling - Math.max(used, status.used)), mode: status.mode,
        phases: rolling && rolling.phases || {}, sampled: !!(rolling && rolling.samples) };
}
function spawnView(creeps, spawns, queue, settings) {
    let replacementLoad = 0, remaining = 0;
    const seen = new Set();
    for (const creep of creeps) {
        seen.add(creep.name);
        replacementLoad += (creep.body || []).length * 3 / Bodies.lifetime(creep.body || [], creep.memory);
    }
    for (const spawn of spawns) {
        if (!spawn.spawning) continue;
        remaining += safe(spawn.spawning.remainingTime);
        if (!seen.has(spawn.spawning.name)) replacementLoad += safe(spawn.spawning.needTime, 30) / 1500;
    }
    const queued = queue.filter(q => q && (!q.expiresAt || q.expiresAt >= Game.time));
    const plannedLoad = queued.reduce((sum, q) => sum + (q.body || []).length * 3 /
        Bodies.lifetime(q.body || [], q.memory), 0);
    const burstLoad = (remaining + queued.reduce((sum, q) => sum + (q.body || []).length * 3, 0)) / settings.queueHorizon;
    const count = spawns.length;
    const limit = count * Math.min(0.9, Math.max(0.5, settings.spawnTarget));
    return { count, replacementLoad, plannedLoad, burstLoad, emergencyReserve: count - limit,
        headroom: Math.max(0, limit - replacementLoad - plannedLoad - burstLoad),
        currentUtilization: count ? spawns.filter(s => s.spawning).length / count : 1,
        utilization: count ? (replacementLoad + plannedLoad + burstLoad) / count : 1 };
}
function currentSpawn(roomName, queue, settings) {
    const hive = HiveMemory.ensure();
    if (!global.__sushiCapacitySpawn || global.__sushiCapacitySpawn.tick !== Game.time || global.__sushiCapacitySpawn.hive !== hive)
        global.__sushiCapacitySpawn = { tick: Game.time, hive, rooms: {} };
    const cache = global.__sushiCapacitySpawn.rooms, index = Index.get();
    if (!cache[roomName]) cache[roomName] = spawnView(index.creepsByHomeRoom.get(roomName) || [],
        index.ownedSpawnsByRoom.get(roomName) || [], [], settings);
    const base = cache[roomName], pending = spawnView([], [], queue, settings);
    return { ...base, plannedLoad: pending.plannedLoad, burstLoad: base.burstLoad + pending.burstLoad,
        headroom: Math.max(0, base.headroom - pending.plannedLoad - pending.burstLoad),
        utilization: base.utilization + (pending.plannedLoad + pending.burstLoad) / Math.max(1, base.count) };
}
function commitments(roomName, queue, settings, excludeId) {
    const hive = HiveMemory.ensure(), index = Index.get(), assigned = {}, seen = new Set();
    const add = memory => { if (memory && memory.demandId) assigned[memory.demandId] = (assigned[memory.demandId] || 0) + 1; };
    for (const creep of index.creepsByHomeRoom.get(roomName) || []) {
        seen.add(creep.name);
        if (creep.ticksToLive === undefined || creep.ticksToLive > (creep.body || []).length * 3 + 50) add(creep.memory);
    }
    for (const spawn of index.ownedSpawnsByRoom.get(roomName) || []) {
        const name = spawn.spawning && spawn.spawning.name;
        if (name && !seen.has(name)) add(Memory.creeps && Memory.creeps[name]);
    }
    for (const request of queue) add(request.memory);
    const result = { load: 0, cpu: 0, count: 0 };
    for (const demand of Object.values(hive.demands)) {
        if (!demand || demand.validUntil < Game.time || (demand.preferredSpawnRoom || demand.originRoom) !== roomName) continue;
        const operation = demand.operationId && hive.operations[demand.operationId];
        if (operation && ['COMPLETE', 'ABORTED'].includes(operation.state)) continue;
        const missing = Math.max(0, Math.min(150, demand.count || 0) - (assigned[demand.id] || 0) - (demand.id === excludeId ? 1 : 0));
        if (!missing) continue;
        const body = demand.bodyRequirements && demand.bodyRequirements.body ||
            require('role.creepBodyConfig').getBody(demand.role, Game.rooms[roomName]) || [];
        // Unqueued commitments reserve maintenance; only the actual queue reserves an immediate burst.
        result.load += missing * body.length * 3 / Bodies.lifetime(body, demand.memory);
        result.cpu += missing * roleCpu(demand.role); result.count += missing;
    }
    return result;
}
function calculateRoom(input, settings = DEFAULTS) {
    const { cpu, spawn, energy, population, rcl } = input;
    const hard = Math.max(10, Math.min(settings.absoluteMaximum,
        20 + rcl * 4 + spawn.count * 20 + Math.floor(cpu.limit / 5)));
    const reason = !energy.healthy ? 'ECONOMY_RECOVERY' : cpu.mode === 'critical' || cpu.bucket < 4000 || cpu.headroom <= 0 ?
        'CPU_CAPACITY_EXHAUSTED' : spawn.headroom <= 0 ? 'SPAWN_LOAD_HIGH' :
        energy.known !== false && (energy.aboveReserve <= 0 || energy.trend < -1 || energy.sustainableNetIncome <= 0) ? 'ENERGY_BELOW_RESERVE' :
        input.threat ? 'DEFENSE_EMERGENCY' : 'CAPACITY_AVAILABLE';
    const available = reason === 'CAPACITY_AVAILABLE';
    const slots = available ? Math.max(0, Math.floor(Math.min(cpu.share / 0.2, spawn.headroom / 0.05,
        energy.sustainableNetIncome / 0.5, energy.aboveReserve / 1000))) : 0;
    const softCap = Math.min(hard, available ? Math.max(population.baseline, population.current + slots) :
        Math.max(population.mandatory, population.current - Math.max(1, Math.ceil(population.discretionary * 0.25))));
    const mode = !energy.healthy ? 'RECOVERY' : !available ? 'CONSERVE' : energy.aboveReserve > 100000 ?
        (slots >= 5 ? 'EXPAND' : 'SURPLUS') : 'NORMAL';
    return { mode, reason, cpu, spawn, energy, population: { ...population, softCap, hardSafetyCap: hard,
        headroom: Math.max(0, softCap - population.current), discretionarySlots: slots } };
}
function get(force = false) {
    const hive = HiveMemory.ensure(), settings = config(), status = CPU.getCpuStatus();
    const previous = hive.capacity;
    if (!force && previous && previous.tick <= Game.time && Game.time - previous.tick < settings.interval) return previous;
    const index = Index.get();
    const rooms = Object.values(Game.rooms).filter(r => r.controller && r.controller.my);
    const rolling = global.__sushiCpuRolling || hive.telemetry.cpu;
    const cpu = cpuView(status, rolling, settings), views = {};
    for (const room of rooms) {
        const economy = require('HiveMind.Economy').get(room.name) || {};
        const growth = economy.growth || {};
        const creeps = index.creepsByHomeRoom.get(room.name) || [];
        const spawns = index.ownedSpawnsByRoom.get(room.name) || [];
        const queue = HiveMemory.getRoomSpawnMemory(room.name).queue;
        const classes = {};
        let localCarry = 0;
        for (const creep of creeps) {
            let kind = classify(creep);
            const memory = creep.memory || {};
            if (memory.role === 'Extractor' && !memory.remoteMining &&
                (!memory.sourceRoom || memory.sourceRoom === room.name)) kind = 'MANDATORY';
            if (memory.role === 'Freighter' && require('HiveMind.Economy').isLocalFreighter(creep) &&
                localCarry < (economy.haul && economy.haul.requiredCarry || 0)) {
                kind = 'MANDATORY'; localCarry += Bodies.metrics(creep.body || []).CARRY;
            }
            classes[kind] = (classes[kind] || 0) + 1;
        }
        const baseline = HiveMemory.getConfig('spawn').maxCreepsPerRoomByRcl['RCL' + room.controller.level] || 10;
        const mandatory = classes.MANDATORY || 0;
        const spawn = spawnView(creeps, spawns, queue, settings);
        const committed = commitments(room.name, queue, settings);
        spawn.commitmentLoad = committed.load;
        spawn.headroom = Math.max(0, spawn.headroom - committed.load);
        views[room.name] = calculateRoom({ rcl: room.controller.level,
            cpu: { ...cpu, share: cpu.headroom / Math.max(1, rooms.length) },
            spawn,
            energy: { known: Number.isFinite(growth.storedEnergy), stored: safe(growth.storedEnergy), reserve: safe(growth.reserveTarget),
                aboveReserve: safe(growth.energyAboveReserve), grossIncome: safe(growth.localGrossIncome) + safe(growth.remoteGrossIncome),
                sustainableNetIncome: safe(growth.estimatedNetIncome), trend: economy.energyTrend || 0,
                healthy: !['SURVIVAL', 'RECOVERY'].includes(economy.state) && growth.mode !== 'RECOVERY' },
            population: { current: creeps.length, mandatory, economic: classes.ECONOMIC || 0,
                discretionary: creeps.length - mandatory, baseline, classes },
            threat: !!(hive.threats[room.name] && hive.threats[room.name].harmfulHostileCount) }, settings);
    }
    hive.capacity = { tick: Game.time, mode: cpu.headroom <= 0 || cpu.bucket < 4000 ? 'CONSERVE' :
        Object.values(views).some(v => ['SURPLUS', 'EXPAND'].includes(v.mode)) ? 'SURPLUS' : 'NORMAL', cpu,
        spawn: { count: Object.values(views).reduce((sum, r) => sum + r.spawn.count, 0),
            replacementLoad: Object.values(views).reduce((sum, r) => sum + r.spawn.replacementLoad, 0) }, rooms: views };
    return hive.capacity;
}
function evaluate(room, request, context, mandatory, revalidate) {
    const view = get().rooms[room.name];
    if (!view) return { allowed: true, reason: 'capacity awaiting owned-room snapshot' };
    const role = request.role || request.memory && request.memory.role;
    const kind = classify(request), settings = config();
    const own = revalidate && context.queue.includes(request) ? 1 : 0;
    const rawLiving = (Index.get().creepsByHomeRoom.get(room.name) || []).length;
    const total = Math.max(context.total - own, rawLiving + context.queued - own);
    const status = CPU.getCpuStatus();
    const cpu = cpuView(status, global.__sushiCpuRolling || HiveMemory.ensure().telemetry.cpu, settings);
    const queue = context.queue.filter(q => q !== request);
    const spawns = currentSpawn(room.name, queue, settings);
    const committed = commitments(room.name, queue, settings, request.demandId || request.memory && request.memory.demandId);
    spawns.headroom = Math.max(0, spawns.headroom - committed.load);
    const roleSamples = HiveMemory.ensure().telemetry.populationRooms || {};
    const utilization = roleSamples[room.name] && roleSamples[room.name][role];
    const queuedCpu = queue.reduce((sum, q) => sum + roleCpu(q.role), 0) + committed.cpu;
    const metrics = Bodies.metrics(request.body || [], request.memory || {});
    const claimed = new Set(queue.flatMap(q => q.replacementFor || []));
    const replacing = role === 'Tech' ? (request.replacementFor || []).map(name => Game.creeps[name]).filter(c =>
        c && c.memory.role === role && c.memory.homeRoom === room.name && !claimed.has(c.name) &&
        c.ticksToLive > 0 && c.ticksToLive <= 150) : [];
    const replacementWork = replacing.reduce((sum, c) => sum + Bodies.metrics(c.body || []).WORK, 0);
    const cpuReplacement = replacing.length > 0 && metrics.WORK <= replacementWork &&
        metrics.spawnTime <= Math.min(...replacing.map(c => c.ticksToLive)) && cpu.mode !== 'critical' && cpu.bucket >= 1800;
    const intelFloor = role === 'Scout' && require('HiveMind.Economy').categoryForRequest(request) === 'remoteIntel' &&
        (context.byRole.Scout || 0) - own < 1;
    let reason = total >= view.population.hardSafetyCap ? 'HARD_SAFETY_CAP' : null;
    if (!reason && !mandatory && kind !== 'MANDATORY') {
        if (!cpuReplacement && (cpu.bucket < 4000 || cpu.mode === 'critical' || Math.min(view.cpu.share,
            cpu.headroom / Math.max(1, Object.keys(get().rooms).length)) < queuedCpu + roleCpu(role))) reason = 'CPU_CAPACITY_EXHAUSTED';
        else if (spawns.headroom < metrics.estimatedReplacementLoad + metrics.spawnTime / settings.queueHorizon) reason = 'SPAWN_LOAD_HIGH';
        else if (!intelFloor && view.energy.known !== false && (!view.energy.healthy || view.energy.aboveReserve < metrics.cost +
            queue.reduce((sum, q) => sum + Bodies.cost(q.body || []), 0) || view.energy.trend < -1)) reason = 'ENERGY_BELOW_RESERVE';
        else if (utilization && utilization.samples >= 8 && utilization.utilization < 0.5 &&
            Game.time - utilization.tick < 200 && ['GROWTH', 'INFRASTRUCTURE'].includes(kind)) reason = 'ROLE_UNDERUTILIZED';
        else if (!intelFloor && !cpuReplacement && total >= view.population.softCap) reason = 'SOFT_CAPACITY_EXHAUSTED';
    }
    const decision = { allowed: !reason, reason: reason || (mandatory ? 'MANDATORY_CAPACITY' : cpuReplacement ? 'CPU_NEUTRAL_REPLACEMENT' : 'CAPACITY_AVAILABLE'),
        replacementCount: cpuReplacement ? replacing.length : 0,
        populationClass: mandatory ? 'MANDATORY' : kind, softPopulation: view.population.softCap,
        hardPopulation: view.population.hardSafetyCap, spawnLoad: spawns.utilization };
    Object.assign(HiveMemory.getRoomSpawnMemory(room.name).governor ||
        (HiveMemory.getRoomSpawnMemory(room.name).governor = {}), decision, { tick: Game.time });
    return decision;
}
module.exports = { get, evaluate, classify, roleCpu, cpuView, spawnView, commitments, calculateRoom, DEFAULTS };
