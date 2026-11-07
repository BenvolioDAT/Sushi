# Sushi — AI Architecture Handoff

Implementation reference, reviewed **2026-11-06** against this checkout, including the harvesting, spawning-intelligence, and room-intelligence corrections. This document changes no runtime behavior.

## 1. Architecture and authority

Sushi is a synchronous, tick-driven Screeps bot using CommonJS modules with bare Screeps module names. Runtime decisions are deterministic JavaScript policies; no AI service participates in the tick loop.

The main dependency flow is:

```text
Game + Memory → tick index → Economy → ColonyState → Capacity
                               ↓           ↓           ↓
                      planners / strategy / role demand
                                     ↓
                     Spawn.Arbiter + Spawn.Policy
                                     ↓
                       body sizing → spawn intents
                                     ↓
                  structures → squads/roles → traffic
                                     ↓
                         diagnostics / telemetry
```

These are cooperating systems, not interchangeable state machines:

- **Economy** owns income estimates, local recovery, reserves, and spending permissions.
- **ColonyState** owns lifecycle, mandatory workforce floors, controller progress, and alerts.
- **Capacity** constrains additional population using CPU, replacement/spawn load, energy, and utilization.
- **Planners and strategy** choose infrastructure, remote portfolios, expansion, and operations. They produce plans or demands; they do not replace spawn admission or role execution.
- **Roles** execute creep actions. Movement and shared assignment helpers own coordination beneath them.

Combat separates threat/danger assessment from permission to engage through `Combat.Policy`; danger alone is not attack authorization. Defense demand, combat operations, and squads share the spawn pipeline; towers act during structure execution. Defaults observe players, enable NPC auto-defense, and require manual confirmation for safe mode. Resource and power managers coordinate their own structures, operations, and workers through economic gates; market automation defaults off.

**Authority:** executable code and its current call sites outrank comments and historical design reports. Live `Game` objects establish visible facts; Memory stores observations and continuity, not guaranteed current facts. `HiveMind.Memory.getConfig()` supplies effective configuration, including persisted overrides; defaults alone do not describe a running colony. Tests establish modeled behavior, not live engine performance.

## 2. Tick execution

[`main.js`](../main.js) fixes the phase order:

1. Install diagnostics, start telemetry, begin diagnostic collection.
2. **Bootstrap:** migrate/ensure Memory, install console helpers, hydrate persisted demands, clean shared routes, read CPU pressure, build the tick index, and synchronize HOME identities. Optional pixel generation is disabled by default.
3. **Threats:** update `Combat.ThreatLedger`; optionally run the legacy WarRoom, disabled by default.
4. **Strategy:** sample Economy, update ColonyState, obtain Capacity, then schedule remote, structure, and road planning. Run empire strategy and operations afterward.
5. **Spawn planning/execution:** plan squads, power, and resources; run local spawn-demand planning; flush the demand board; execute requests for reported rooms.
6. **Structures:** towers, safe mode, resource structures, power processing; refresh damaged-structure IDs every ten ticks; run empire terminals and power-creep management.
7. **Creeps:** execute squads first, then dispatch remaining non-spawning creeps by `memory.role`. Squad-controlled creeps skip individual role dispatch.
8. **Finalize:** resolve traffic; remove dead creep Memory; schedule incremental GC and visuals.
9. In `finally`, finish diagnostics and telemetry independently.

Top-level phase exceptions are recorded and later phases remain reachable; a bootstrap failure skips dependent work. Individual roles and per-room spawn execution also have exception boundaries. This is failure isolation, not transactional rollback or protection against engine CPU termination.

The index is a once-per-tick observation, not a simulation of accepted actions. Successful spawn intents need separate accounting before the engine exposes the next tick's state. Foreman/Scout scans during creep execution can update durable intel after planning has already run.

## 3. Spawning intelligence

### Demand → admission

[`spawn.request.manager.js`](../spawn.request.manager.js) handles owned rooms with owned spawns. `runForRoom()` prunes stale requests and builds a planning context. Emergency planning runs even on light/CPU-suppressed passes: missing core workers, controller safety, consolidation checks, and defense remain considered. Full passes refresh cached mining, hauling, Tech, and Artificer demand; light passes do not replay all normal requests.

Local demand and `Spawn.DemandBoard` producers converge on **`Spawn.Arbiter.admit()`**, then one persistent `Memory.rooms[room].spawn.queue`. The board supports expiring, stable-ID demands from operations, squads, resource/power systems, and strategy hooks; it subtracts living, spawning, and queued assignments. It is not a second spawn executor.

The Arbiter normalizes bodies/metadata, deduplicates stable request IDs, refreshes expiry, and invokes `Spawn.Policy.evaluate()`. Admission combines Economy spending, current recovery need, colony floors, role/queue/request limits, and Capacity. Targeted local requests are rechecked for useful capability and valid sources; obsolete upgrades are rejected. Mandatory recovery and specified emergencies can bypass soft constraints, but the hard population safety cap remains. Disabling generic spawn policy does not disable spawning or all economic checks.

### Capability and bodies

Local Extractor demand is source-specific. `Harvest.Planning.describe()` compares theoretical WORK, validated seats, healthy/active workers, incoming workers, maximum feasible bodies, and named replacements. A vacant seat can receive useful missing WORK. Occupied seats require a lifetime replacement or a stronger upgrade whose estimated gain repays early replacement. Pending source work suppresses duplicate requests; the local request path admits at most one source per pass.

`BodyProfiles.build()` searches bounded capability candidates within energy, mobility, deadline, and 50-part limits; `role.creepBodyConfig` supplies role selectors and existing profiles. Maximum-capacity planning and current-energy execution are separate. Emergency sizing favors an affordable useful minimum. Road-heavy and controller-fed profiles require infrastructure evidence. Local miners retain **CARRY** for harvesting/offloading and bootstrap delivery.

### Ordering and execution

`spawn.manager.runRoom()` tries idle spawns; `runRoomInternal()` revalidates admission and selects a productive affordable body. Priorities generally sort descending, then oldest first. Urgent local recovery, controller safety, and imminent owned defense can move ahead of discretionary miner upgrades; this is not a global emergency-first reorder.

`Spawn.Sizing.evaluate()` bounds efficient-miner waiting to **20 ticks**. Refills do not restart the deadline; capability/capacity changes invalidate sizing. Urgency, deteriorating economy, timeout, or impossibility release reservations. Eligible later work can proceed when reservation policy permits. Healthy-incumbent upgrades retain their stronger-WORK minimum; aging/dead predecessors reclassify the request as a lifetime replacement with a productive fallback.

Final bodies are bounded by current energy and active spawn/extension capacity. On `spawnCreep(…) === OK`, `Spawn.Intents` reserves energy and the used spawn, accounts for production, and the queue entry is removed. Retryable energy/busy/name errors preserve requests; other failures remove them. `spawn.lastDecision`, admission blocks, and source planning records explain waiting, rejection, or an empty queue.

## 4. Room and source intelligence

[`utility.js`](../utility.js) is the shared local intelligence boundary:

- `scanRoom()` merges source/controller/mineral observations into existing records. Foreman scans its room; Scout scans visited rooms and informs remote/expansion systems. Assignments, container plans, and haul metadata survive rescans.
- `getSourceHarvestProfile()` derives average income as capacity/regeneration and required WORK as its ceiling divided by harvest power. It uses current source capacity, including explicit zero; source count and a universal five-WORK target are not authoritative.
- `getValidSourceMiningSeats()` validates adjacent coordinates, room/bounds, terrain, natural objects, blocking structures, and private hostile ramparts. Roads, containers, and friendly/public ramparts remain usable. Temporary creep occupancy and unfinished sites do not redefine durable seat geometry.

`Memory.rooms[room].sources[id]` holds identity/position, versioned terrain seats, assignment fields, container/link/road metadata, and `haul`. `seatVersion` enables legacy geometry repair; a valid zero-seat scan stays zero. Explicit coordinates take precedence over stale count fields. The validator caches results only for the tick/index and coordinate signature; callers receive array copies. Sources/minerals are lazily enumerated through `HiveMind.Index` once per consumed room per tick.

`utility.Creep.getAssignedSource()` and `getAssignedMiningSeat()` reconcile dead/mismatched assignments, preserve valid targets, respect useful WORK and physical seats, and check reservations/occupancy. Container miners are not restricted to a universal two-creep cap. `runExtractorLifecycle()` stages a named successor, waits for a clear exit/seat, and retires/recycles the predecessor. Failure/timeout preserves or restores the incumbent when possible and applies upgrade cooldowns; staging WORK remains incoming.

`Planner.Remote` owns home-specific remote source portfolios, routes, terrain/body travel estimates, reservations, danger/economy suspension, and selection. Durable plans live under the **home** room's `remotePlanner`; observed source/haul data live under the source room. `Remote.Intel` ages reservations and requests fresh vision for stale ownership/access. Visible remotes use shared seat validation; unseen access remains bounded by last-observed evidence. Keeper-group income does not receive the normal unreserved-room reduction.

## 5. Economic decisions

`Economy.buildSnapshot()` caps useful active WORK **per source**; surplus miners at one source cannot cover another. Active, stationed, spawning, staging, queued, and replacement-aware planned WORK differ. Stationed WORK estimates income; it does not measure delivered energy.

Local hauling estimates CARRY from source income, round-trip distance/load allowance, and a safety margin. Links can reduce creep-served income, while backlog/link backpressure expose transport deficits. Local and remote hauling capability are counted separately. Local distance estimates use bounded pathfinding with range fallback; persistent cache entries expire after 500 ticks and refresh sooner for dropoff/structure-count changes.

Economic states are **SURVIVAL → RECOVERY → STABLE → SURPLUS**. `rawState()` evaluates harvest/income ratios, hauling, backlog, spawn fill, reserves, trend, and replacement risk. Deterioration is immediate; improvements advance one state after confirmation: 12/40/100 healthy samples when leaving SURVIVAL/RECOVERY/STABLE.

`checkSpend()` always permits core harvest/logistics/spawn fill, with specific controller/defense/maintenance exceptions. Recovery restricts discretionary growth and remote spending. Existing Tech/Artificer roles also consult policy, so admission alone does not permanently authorize spending.

Recovery protects first income: an empty colony without miners/refill reserves prioritizes a miner; funded startup can prioritize Foreman. Miners self-deliver during SURVIVAL or RECOVERY until local hauling is active. Bootstrap harvesting shortages also request missing hauling rather than starving the infrastructure escape path.

When maximum bodies and occupied seats constrain harvest, **infrastructure recovery** permits bounded progress only with attainable stationed capacity, hauling, Foreman, affordable energy, and acceptable trend. It preserves the theoretical shortage and RECOVERY diagnosis.

`buildGrowthPolicy()` budgets controller work after economic replacement and infrastructure allowances, using reserves and evidence-backed remote income. ColonyState separately protects baseline controller progress at RCL1–7 and downgrade safety. Tech/Artificer demand is WORK-based; builders distinguish critical maintenance/infrastructure, construction, and remote work. `HiveMind.Surplus.plan()` allocates income/stockpile drawdown among investments subject to reserves, CPU, and spawn load. Capacity's soft caps are dynamic; RCL counts are baselines, not fixed population targets.

`Planner.Brain` stages versioned structure plans and construction sites under RCL/CPU limits. Creating a site, admitting a builder, and actually building are separate decisions. Planning a structure type does not establish an automated production chain for that structure.

## 6. Memory, caches, and cleanup

Schema **8** is owned by [`HiveMind.Memory.js`](../HiveMind.Memory.js); use its accessors instead of reviving legacy roots such as `Memory.spawnPolicy` or `room.spawnQueue`.

| Persistent domain | Responsibility |
| --- | --- |
| `Memory.meta`, `Memory.config`, `Memory.cpu` | Schema/migration metadata, domain configuration, CPU status. |
| `Memory.hive` | HOME registry/identity, operations, squads, demands, players/threats, expansion, resources/power, capacity, telemetry, diagnostics/GC metadata. |
| `Memory.rooms[name]` | Identity (`HOME`, `OWNED_BOOTSTRAP`, `REMOTE`, `INTEL`), sources/controller/`Mineral`, economy continuity, colony state, `spawn` queue/cache/decisions, planners, routes and distance caches. |
| `Memory.creeps[name]` | Role/home, assignments, jobs, reservations, movement continuity, replacement links, spawned capability. |

Full tick-index and Economy snapshots are heap-only. Economy persists compact state/trend/growth continuity; `Economy.get()` can fall back to that reduced record, which is not a complete current snapshot. Capacity persists a view normally refreshed every five ticks, with live request checks for additional commitments. Global resets discard heap caches; rebuild from plain persisted IDs/coordinates, never serialized live objects.

Dead-creep cleanup runs each normal finalize pass. Scheduled `HiveMind.MemoryGC.run()` incrementally expires demands, queues, terminal operations/squads, and stale intel with a persistent cursor and record budget. HOME/bootstrap/remote rooms and active operation/expansion targets are protected. Runtime assignment helpers also reconcile claims; GC is not their sole correctness mechanism. Shared routes have TTL/count cleanup and obstruction invalidation.

Diagnostics use bounded events, segment ownership checks (default segment 98), and a smaller Memory fallback. Segment activation is asynchronous; future segment users must coordinate `setActiveSegments`. Telemetry maintains heap rolling CPU estimates, periodically persists them, and samples role cost/utilization for Capacity.

## 7. Movement and jobs

Roles use `utility.Travel.Creep.move/moveToRoom/moveDirection`. The wrapper owns movement guards, shared routes, and submission; Traveler owns fallback pathfinding/routing/stuck handling. Registered one-step intents resolve through `traffic_manager` after role execution. Native movement is a degraded fallback when registration/Traveler is unavailable. Finalize caches structure/site-signature cost matrices and includes hostile/power-creep blockers. Avoid adding direct role-level movement paths.

There is **no universal job scheduler**. Freighter local/remote pickup claims use creep Memory plus the mutable per-tick `Logistics.Index`; source haul advertisements are observations, not guaranteed available energy. `Logistics.Jobs` supports explicit transport assignments and reconciles delivered amounts from resolved store changes; automatic HOME balancing is not implemented there. `Resource.Manager` builds a separate per-tick courier board for labs/minerals/terminals with persistent assignment IDs. Artificer targets/repair claims and squad/operation assignments retain their own owners.

## 8. Constraints and unresolved limits

- CPU policy follows `Game.cpu.limit`, bucket, live usage, and rolling full-tick cost; 20 CPU is not hardcoded capacity. Scheduler staggering/dirty flags defer optional work under pressure; emergency planning survives normal-plan suppression. Default spawn-planning budget is 1.5 CPU; structure and remote planners add internal bounds. No hard real-time guarantee exists.
- A valid seat proves adjacent usability, not base-to-seat connectivity, shared-seat exclusivity between neighboring sources, or throughput. Local hauling/path fallbacks do not fully model swamp/traffic behavior. Same-count topology changes can wait for distance-cache expiry.
- Production estimates assume ordinary unboosted WORK/natural regeneration. Full stores, offloading, damage, competition, congestion, power effects, and handoff timing can reduce realized income. No local delivered-income feedback controller is implemented. Repeated minimum-size emergency haulers can remain inefficient.
- Owned rooms without spawns are lifecycle/expansion bootstrap targets, not ordinary local spawn-demand rooms. Expansion ranking remains heuristic, not a full harvest/haul profitability solver.
- `Strategy.Provider.providers()` currently returns `[]`; extension hooks exist, but no seasonal provider is active. `Season.Retirement` performs idempotent legacy Season 11 cleanup. Historical season documents do not describe active strategy. Generic operation type names likewise do not prove autonomous end-to-end support.
- Mock suites cover decision/lifecycle regressions, including simulated recovery. They do not establish live CPU/Memory cost, actual room conditions, delivered income, or resolved traffic/handoffs. A local watched-directory update does not prove server synchronization.

## 9. Investigation map

Paths below are repository-relative; named functions identify the primary entry points, including internal helpers.

| Change or question | Start here |
| --- | --- |
| Tick ordering/error boundaries | [`main.js`](../main.js) `loop`; `Tick.Bootstrap.run`, `Tick.Planning.runStrategy/generateSpawnRequests`, `Tick.Creeps.run`, `Tick.Finalize`. |
| Economic block/controller growth | [`HiveMind.Economy.js`](../HiveMind.Economy.js) `buildSnapshot/rawState/checkSpend/localRecoveryRequest`; [`HiveMind.ColonyState.js`](../HiveMind.ColonyState.js) `update/decide`; `HiveMind.Surplus.plan`. |
| Idle spawn/demand | [`spawn.request.manager.js`](../spawn.request.manager.js) `runForRoom/runEmergencyPlanning/requestRoleForRoom/getSourceMiningDemand/getFreighterCarryDemand`; `Spawn.DemandBoard.emit/flush`. |
| Admission/body/execution | [`Spawn.Arbiter.js`](../Spawn.Arbiter.js) `admit/revalidate`; `Spawn.Policy.evaluate`; `HiveMind.Capacity.evaluate`; [`spawn.manager.js`](../spawn.manager.js) `runRoomInternal`; `Spawn.Sizing.evaluate`; `BodyProfiles.build`. |
| Source geometry/assignment/handoff | [`utility.js`](../utility.js) `scanRoom/getSourceHarvestProfile/getValidSourceMiningSeats`; `Harvest.Planning.describe`; [`utility.Creep.js`](../utility.Creep.js) `getAssignedSource/getAssignedMiningSeat/runExtractorLifecycle`; `role.Extractor.run`. |
| Remote income/routes | [`Planner.Remote.js`](../Planner.Remote.js) `run/selectActiveSources/getRemoteExtractorDemand/validateRemoteRoute`; `Remote.Intel.controller`; `role.Freighter`. |
| Structures/empire decisions | [`Planner.Brain.js`](../Planner.Brain.js) `runRoom/buildSites`; `HiveMind.Strategy.run`; `HiveMind.Operations.run`; `Logic.Expansion`; `Combat.Policy`; `Squad.Controller`; `Resource.Manager`; `Power.Manager`. |
| Memory/movement/jobs | [`HiveMind.Memory.js`](../HiveMind.Memory.js) accessors/migration; `HiveMind.MemoryGC.run`; `HiveMind.Index.get`; `utility.Travel.Creep.move`; `Logistics.Index.update`; `Resource.Manager.getJobForCreep`. |

For evidence, inspect `Sushi.debug.room(name)`, `Sushi.debug.cpu()`, `Sushi.debug.events()`, and `MemorySchema.map()`; diagnostics can contain both current views and older timestamped events. Trace source need → planner action → admission → body/wait → accepted intent → runtime assignment before diagnosing an idle spawn.

Validation entry point: `npm run validate` includes behavioral mocks, module-graph and movement-ownership audits. Focused suites are `test/harvesting-capacity.js`, `test/spawning-intelligence.js`, `test/room-intelligence.js`, plus economy, memory, remote, and role suites selected for the change. Historical review reports provide rationale; current code and focused regressions remain authoritative.
