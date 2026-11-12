# Sushi local engineering audit — November 11, 2026

The later RCL5 Keeper follow-up, final combat/remote assessment tables, and current limitations are in [KEEPER-AUDIT-2026-11-12.md](KEEPER-AUDIT-2026-11-12.md). Measurements below describe the earlier audit windows.

## Outcome and evidence standard

This audit combined code inspection, deterministic decision tests, the running desktop client, and read-only snapshots of the local server database. It found a persistent telemetry exception, a recovery-policy trap at a single-seat source, a hauling-renewal admission conflict, a miner repeatedly attempting to harvest under an Invader reservation, and inefficient remote loading as dropped-resource IDs changed.

The fixes retain the existing managers, state machines, movement ownership, and ordinary Memory migration. No reset, manual Memory purge, structure destruction, hostile injection, or offensive mission was performed. Existing miners' handoff/recycling behavior was inspected; this audit did not add forced retirement. Hauling consolidation leaves predecessors working until natural expiry.

“Automated” below means a deterministic local regression, not an engine combat victory. “Live” requires the correct running build plus an observed behavior or runtime counter. Economic income fields are estimates unless explicitly identified as cargo/progress deltas.

## Environment and deployment

- Development folder: `C:\Users\xbenv\AppData\Local\Screeps\scripts\127_0_0_1___21025\Sushi`.
- Desktop Script panel: active branch **Sushi**. Its **Open local folder** exposed exactly that folder in Explorer.
- Local server: port 21025, server build 40.8.1, installed `@screeps/engine` 4.3.0-beta; configured mod changes minimum loop duration and socket throttling to 100 ms. This is a target minimum, not a measured guarantee of ten ticks/second.
- Runtime CPU allowance: 100; bucket initially 10,000. These results do not establish fitness for the public world's 20-CPU allowance.
- Baseline runtime: 109 modules, identity `5d35cd2adb57c4cc27858879ba066814b043fa3e14a9a207523621bcf793d86e`. Every server module matched local source after line-ending normalization.
- The copied project initially lacked its tracked test/tool/doc directories. Existing tests and build/deployment helpers were recovered from HEAD for isolated validation; test/build helpers were subsequently restored to this project. Unrelated missing historical evidence and documents were not restored.
- Changes were validated in `validation/audit-20261112/workspace` before updating the verified watched folder. `Runtime.Build.js` was regenerated last for each release. The running receipt and all-module comparison were checked separately from successful local writes.
- Original root runtime bytes are backed up in `validation/deployments/audit-20261112/original`. Copying those files back would be a real code rollback, not a Memory rollback; no rollback was needed.

Evidence files are under `validation/audit-20261112/`. Database captures are periodically saved server state and may lag the current tick; client console snapshots independently establish executing builds and diagnostics. No credentials are retained by the capture helper.

## Architecture inspected

The root entry point runs bootstrap/indexing, combat intel, economy and colony strategy, spawn requests/execution, room structures, creep execution, traffic resolution, optional work, and final diagnostics/CPU telemetry. Phase exceptions are recorded; bootstrap failure stops dependent work, and final telemetry remains reachable through `finally`.

| Area | Main owners | Review result |
| --- | --- | --- |
| Tick order and indexes | `main`, `Tick.*`, `HiveMind.Index` | Fixed phase order; shared room/role/source indexes; independent exception boundaries. |
| Population and spawning | `spawn.request.manager`, `Spawn.Arbiter`, `Spawn.Policy`, `HiveMind.Capacity`, `spawn.manager`, `Spawn.Sizing`, `BodyProfiles` | Producer/admission/execution remain separate; affordable recovery, queue expiry, intent accounting and bounded miner waits retained. |
| Source planning | `Harvest.Planning`, `HiveMind.Economy`, `utility.Creep`, `role.Extractor` | Source-specific seats and WORK coverage; full-source demand distinct from present capacity; staged replacements excluded from active coverage. |
| Remote economy | `Planner.Remote`, `Remote.Intel`, `HiveMind.Economy` | Canonical multi-room routes, production/travel costs, reservation costs, switching cost and observation freshness already exist. |
| Hauling | `role.Freighter`, `Logistics.Index`, `Logistics.Jobs`, `Freighter.Renewal` | Stable job classes, pickup/delivery reservations and capacity-based renewal; corrected admission and drop-buffer loading. |
| Combat | `Combat.Policy`, `Combat.ThreatLedger`, `Defense.Demand`, `Combat.Operations`, `Squad.Controller`, `Squad.Quad`, `Squad.Tactics`, military roles | Diplomacy and threat signals separated; duo/quad state machines implemented; stronghold execution remains unsupported. |
| Movement | `utility.Travel.Creep`, `Traveler`, `traffic_manager`, `Tick.Finalize` | Existing exit, stationary-worker, movement-intent and traffic safeguards preserved. |
| Memory and performance | `HiveMind.Memory`, `HiveMind.MemoryGC`, `HiveMind.Telemetry`, `Diagnostics`, `CPU.Status`, Scheduler | Bounded history and cleanup; fixed legacy telemetry recovery and strategic route protection. |

The module graph has 109 reachable runtime modules and no detected dependency cycles. The movement ownership audit covers 14 direct movement/pathfinding call sites. These structural checks do not prove every live movement case correct. Large files remain (`Planner.Remote`, `spawn.request.manager`, `HiveMind.Economy`, `utility.Creep`); reorganizing them during a behavior audit would add migration risk without resolving the demonstrated failures.

## Confirmed findings and changes

### 1. Telemetry failed every tick after legacy-state migration

At client tick 468850, error history showed `Cannot read properties of undefined (reading 'diagnostics')` in `HiveMind.Telemetry.finish`, including thousands of aggregated repetitions. Saved CPU history had the old `{used,bucket,limit}` shape. The phase-name loop guarded `Object.keys(previous.phases || {})` but subsequently indexed `previous.phases[name]` without that guard. Progress measurement and completed-tick EMA updates never ran.

Telemetry now starts a finite sample when history is missing, malformed, or from a future tick, and retains smoothing for valid completed-tick history. Controller progress and periodic persistence recover through normal execution. The last observed occurrence of the old exception was tick **470968**; the fix began executing at **470969**. Historical records were preserved.

### 2. Recovery rejected the hauler renewal intended to reduce its cost

The baseline had 16 local Freighters at tick 468850, including ten idle workers; later snapshots showed 18–19 predominantly one-CARRY bodies. The renewal planner could identify a funded larger successor, but capacity admission rejected discretionary renewal when the room was in harvest recovery. Ordinary mandatory deficit requests remained allowed, perpetuating small replacements.

A validated local worker-saving renewal can now pass the general economic-health flag. It still needs the existing cohort, capability, funding above reserves, trend, spawn-load, deadline, hard-cap and continuity checks. The exception does not admit military, ordinary optional growth, or remote renewals. Live execution produced five-CARRY successors and reduced the fleet through natural predecessor expiry. At tick **474760**, the room had **six Freighters with 18 active CARRY**, compared with 18 Freighters at the pre-release snapshot. This snapshot is not a claim that no transient capacity shortfall occurred between observations.

### 3. An attainable source ceiling was mistaken for a missing worker

W7N4's sources have five accessible seats and one accessible seat. At 550 spawning energy, the established mobile miner body supports four WORK. The single-seat source therefore cannot reach the ideal five WORK, while the other source can reach five using multiple miners. The colony had nine WORK and estimated 18/20 local energy per tick, but its per-source health and replacement-risk checks still demanded the impossible tenth WORK. This repeatedly forced recovery despite filled infrastructure and surplus energy near the spawn.

Economy now uses the explicit body/seat ceiling for per-source health and replacement risk when Harvest.Planning reports a real capacity constraint. The full target remains ten WORK; room-wide 90% full-WORK and 65% income floors, individual income checks, actual replacement risks and the 40-tick recovery confirmation remain enforced. Unknown capacity, missing seats, absent workers and damaged output do not qualify. Live state first reached STABLE at **475107** and began remote staffing. It can still reenter recovery for real hauling or replacement shortages.

### 4. Foreign reservations permitted impossible harvesting attempts

Live follow-up found `Extractor_002` at a full 3,000-energy source in W6N3 with zero cargo and state `remoteStationHarvesting`. The controller was reserved by Invader. Installed engine code explicitly returns `ERR_NOT_OWNER` for harvesting under another user's reservation. Source scoring already rejected this condition, but assignment admission and stationary execution did not consistently honor it.

Foreign reservations now reject source admission/planning, suspend the source and return assigned miners through the existing safe retreat path. Production estimates cannot justify recurring CARRY under foreign ownership/reservation; fresh physical backlog can still justify bounded collection. Timed reservation expiry remains handled by existing intel, without deleting source/route knowledge. No attack was launched against the reserving NPC.

### 5. Dropped-energy identity changes caused partial-load churn

Live remote Freighters had tiny cargo totals over long observation windows. For example, before this refinement one five-CARRY worker had recorded 56 energy picked and delivered over 1,337 observed ticks. Source-buffer drops decayed or were collected, changing object IDs; refreshing a reservation required the old ID to survive. The role could clear its commitment and return partial cargo after a single crumb.

Reservations now follow the latest fresh pickup object for the same committed source, including a temporarily empty drop buffer. A partial courier already at a safe, producing station may wait up to 50 ticks for a useful load, targeting at least 80% capacity before voluntary departure. The deadline does not restart when the pile changes. Miner loss, closed access, insufficient return lifetime, or timeout ends the wait. Existing danger handling remains first. Closing a source preserves partial cargo plus its home/source delivery evidence.

This does not assume projected energy is already present. Real pickup still requires a live resource/store. The wait is a bounded bootstrap fallback, not a replacement for source containers or congestion-aware fleet planning.

### 6. Strategic intel protection and tactical calculations

GC now protects selected, active and established source rooms and their transit-room sequences even if ordinary identity/age fields would otherwise make them purgeable. Removing the strategic reference releases ordinary expired intel; remembered cores are not cleared without vision. Existing dead-creep cleanup and bounded diagnostic retention remain in place; no blanket 2,000-tick purge was added.

Combat math now excludes different-room coordinates, applies both active tower power effects with engine values, ignores expired effects, checks known tower energy against the ten-energy action cost and floors output. Deterministic tests also cover ranged kiting, mass-fire selection, destroyed body parts, boosted TOUGH and missing-healer retreat. They do not establish an end-to-end battle win.

## Stronghold mechanics on this server

Primary references were the installed server's `common/lib/constants.js`, `common/lib/strongholds.js`, engine `game/creeps.js`, and `processor/intents/{creeps/dismantle,towers/attack,invader-core/stronghold/*}`. Official documentation cross-checks: [NPC Invaders](https://docs.screeps.com/invaders.html) and [StructureInvaderCore](https://docs.screeps.com/api/#StructureInvaderCore). Extracted numeric evidence is in `engine-mechanics.json`.

Level 0 is a lesser core that reserves/attacks a controller; levels 1–5 are strongholds. A core has 100,000 hits in the installed constants. Deployment/invulnerability must be respected. The core is not in the construction-cost table, so WORK dismantling cannot damage it; it needs an attack capable of damaging the core. Ramparts must be handled separately. The local mod does not change these mechanics.

| Bunker level | Towers | Initial rampart hits each | Combined tower attack range bounds, without powers | Installed defenders |
| --- | ---: | ---: | ---: | --- |
| 1 | 1 | 100,000 | 150–600 | Tower defense; no maintained defender-creep population in bunker1 behavior. |
| 2 | 2 | 200,000 | 300–1,200 | One weak melee defender. |
| 3 | 3 | 500,000 | 450–1,800 | Two full melee defenders. |
| 4 | 4 | 1,000,000 | 600–2,400 | Four selected entries from a fortifier/boosted melee/ranged deck. |
| 5 | 6 | 2,000,000 | 900–3,600 | One guaranteed fortifier plus eight selected mixed entries. |

These are aggregate theoretical tower bounds, not an assertion that all towers can simultaneously hit at the same range. Towers consume energy but the core refills them; waiting for towers to empty is not a sufficient siege strategy. Higher levels maintain defenders, fortify/repair and use coordinated targeting. Damage and healing estimates must consider target position, boosts, rampart access and defender movement.

At the observed RCL2 capacity, Sushi cannot safely sustain even level 1: a single affordable one-HEAL Cleric provides 12 healing/tick versus at least 150 unpowered tower damage at long range. Labs/boost production are unavailable at this RCL. Existing small ranged bodies also take longer than one creep lifetime to destroy a bare core. A future specialized unopposed four-ATTACK/four-MOVE body costs 520 and deals 120 damage/tick, implying roughly 834 attack ticks for 100,000 hits before travel or interruptions. That illustrates lesser-core feasibility in principle, not an implemented or verified operation.

No stronghold assault level is verified or enabled. Required future work includes an ATTACK-capable lesser-core operation, actual-force readiness checks, terrain-aware siege/boost composition, coordinated healing allocation, focus-fire survivability, safe retreat and replacement economics. Manual offensive assessments still contain desired-capability estimates; a request is not proof the force has assembled. Quads have formation and retreat code, but their theoretical healing coverage is not a validated focus-fire survival guarantee.

## Remote operations and remaining constraints

Remote scoring already accounts for source output, miner travel-adjusted lifetime, modeled round trips, CARRY costs, roads, reservation costs and risk. Portfolio switching has a cooldown/cost, and route planning has a shared 75-tick cooldown. Fresh stock, committed miners and reservation intel affect hauling demand; selected-but-unstaffed sources do not create recurring demand in the deterministic tests.

Before the capacity-health correction there was no observed remote production despite two selected sources. Follow-up showed mining and delivery evidence in W8N3 and W7N3; `lastDeliveryAt` advanced and surviving courier cargo counters increased. Live source exclusion exposed the reservation defect described above. The remote economy is therefore demonstrably doing work, but its profitability is not yet established from a complete delivered-energy-minus-all-costs ledger.

Owned source containers were one per source, with one controller container in the audited snapshot. Existing duplicate-container prevention tests pass; no structure/site was removed. Remote sources used dropped-buffer bootstrap during observation. Sustained loading efficiency, container completion, road changes and hostile interruption recovery need continued observations; modeled route costs alone do not prove profit.

CPU total initially could not be trusted as a rolling measurement because finish crashed. After the repair, fresh per-tick phase costs, bucket and controller EMA were available. The later workload includes more builders, Techs and remote traffic, so a lower hauler count is not a matched-workload whole-colony CPU benchmark. Memory captures fluctuate with diagnostics and population; no monotonic leak was established. Bounded cleanup is verified by tests, not a claim of a leak-free indefinite run.

## Validation and final receipt

The initial recovered suite passed before fixes. New regressions were demonstrated against old implementations before being accepted. A former test expecting recurring hauling under a foreign reservation was corrected to zero to reflect the engine's harvesting rule. Final commands, pass counts, runtime receipt and observation summary are recorded in `validation/audit-20261112/final-verification.json` and accompanying logs.

The full source and running game were compared after synchronization. No intentional combat was run, so ordinary invader defense, end-to-end squad coordination and assault victories remain unverified live. The audit does not certify every possible role, map topology, siege level or long-run economy. Highest-value follow-ups are realistic isolated combat scenarios and a complete-cycle remote profitability/throughput benchmark after bootstrap containers are built.
