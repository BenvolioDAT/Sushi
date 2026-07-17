# Sushi technical audit

Audit branch: `codex/screeps-deep-audit`  
Starting branch: `main`  
Starting commit: `5733985a05b494a47892de6f967f6b2b4fe352c6`

This document maps the current architecture and records static-analysis findings. CPU impact is an estimate unless a live measurement is explicitly identified.

## 1. Main tick execution order

`main.js` loads all first-party systems and initializes `traffic_manager` once per global. Each tick currently runs in this order:

1. `utility.Travel.Creep.cleanupRouteCaches()`.
2. `CPU.Status.getCpuStatus()` to freeze the strategic CPU mode.
3. `Season.Score.maintain()` for target/claim cleanup.
4. Settings initialization and optional pixel generation.
5. Optional `Logic.WarRoom.run()`.
6. `Planner.Remote.run()`, `Planner.Brain.run()`, and `Planner.Roads.run()`.
7. `Logic.Tower.run(room)` for each visible owned room.
8. Every ten ticks, rebuild `Memory.rooms[room].RepairStructure` from damaged structures.
9. Draw source map markers for every visible room.
10. Delete dead entries from `Memory.creeps`.
11. `Logic.Expansion.run()`.
12. `spawn.request.manager.run()` to plan requests, followed by one `spawn.manager.runRoom()` call per reported room.
13. Dispatch every living creep by `creep.memory.role`.
14. Feed all visible rooms to `Season.Score.reportVisibleRoom()`; its per-tick scan cache prevents duplicate Score scans.
15. Build traffic matrices and run traffic resolution for visible rooms.
16. Draw optional structure-plan visuals and the dashboard.

The role dispatcher recognizes `ScoreRunner`, `Tech`, `Foreman`, `Extractor`, `Freighter`, `Annex`, `Artificer`, `Pioneer`, `SupplyRunner`, `Scout`, `Ronin`, `Volley`, and `Cleric` (`main.js`).

## 2. Major modules and responsibilities

| Area | Modules | Responsibility |
|---|---|---|
| Entry/orchestration | `main.js` | Tick order, role dispatch, repair-list refresh, traffic pass, debug visuals |
| CPU policy | `CPU.Status.js` | Sustainable-limit status, bucket/mode hysteresis, dashboard snapshot |
| Spawn demand | `spawn.request.manager.js` | Per-room demand, role/work/carry counts, governor, priorities, emergency requests |
| Spawn execution | `spawn.manager.js`, `utility.spawn.js`, `role.creepBodyConfig.js` | Queue mechanics, body choice, naming, `spawnCreep` handling |
| Room layout | `Planner.Brain.js`, `Planner.*.js` | Incremental structure plan, placement validation, site creation |
| Roads | `Planner.Roads.js`, `Planner.Road.js` | Network-level road plan/site work and structure-plan road primitives |
| Remote economy | `Planner.Remote.js` | Adjacent-room scoring, path/road memory, source ownership, miner and haul reservations |
| Expansion | `Logic.Expansion.js` | Candidate scoring, claim/bootstrap states, expansion-specific spawn requests |
| Movement | `utility.Travel.Creep.js`, `Traveler.js`, `traffic_manager.js` | Shared route/path wrapper, Traveler pathfinding, end-of-tick traffic matching |
| Economy roles | `role.Foreman.js`, `role.Extractor.js`, `role.Freighter.js`, `role.Tech.js`, `role.Artificer.js` | Filling, mining, hauling, upgrading, building/repair |
| Remote/expansion roles | `role.Annex.js`, `role.Pioneer.js`, `role.SupplyRunner.js`, `role.Scout.js` | Reservation/claim, bootstrap building, expansion supply, room intel |
| Combat | `Logic.WarRoom.js`, `role.Ronin.js`, `role.Volley.js`, `role.Cleric.js`, `Logic.Tower.js` | Threat selection, combat movement/actions, tower defense/repair |
| Season 10 | `Season.Score.js`, `role.scorerunner.js` | Score discovery, safety/ranking/claims, range-0 collection and exploration |
| Observability | `Visual.Dashboard.js`, `Visual.Planner.Structures.js`, `utility.Visual.js` | Room dashboards and optional plan/source markers |
| Shared helpers | `utility.js`, `utility.Creep.js` | Room/source intel, haul metadata, creep energy/seat/repair helpers |

## 3. Spawn-request flow

`spawn.request.manager.run()` discovers owned rooms from `Game.spawns`, creates one planning context per room, and performs one `Game.creeps` pass per room to summarize living roles and active body parts. It always runs emergency planning, and runs full dynamic planning on a staggered interval controlled by `Memory.cpuPolicy.roomPlanningInterval` and a CPU budget. Requests pass through `canAddSpawnRequest()`, which enforces room, queue, per-tick, and role caps. Requests are sorted by priority then age in `Memory.rooms[roomName].spawnQueue`.

`spawn.manager.runRoom()` selects an idle spawn, examines the queue head, generates a unique name, and calls `spawn.spawnCreep`. A successful request is removed; transient energy/busy/name errors remain queued; invalid requests are removed. The audit found two execution defects here: normal bodies are shrunk to momentary energy and only one spawn is serviced per room per tick.

## 4. Role dispatch and role contracts

All active roles are dispatched explicitly in `main.js`; role modules are not dynamically required. The main contract is `module.exports.run(creep)`.

| Role | Spawn condition/body | Home/target and acquisition | Action, idle/failure, replacement | Main CPU/memory risks |
|---|---|---|---|---|
| Foreman | Minimum one; CARRY/MOVE body | `homeRoom`; shared room energy helpers | Scans room, collects energy, fills critical room energy; repeats scan/setup when alive | `foremanWorking`; `utility.scanRoom()` per tick can duplicate Scout/planner intel work |
| Extractor | WORK demand per local/remote source; WORK/CARRY/MOVE | `homeRoom`, `sourceRoom`, `sourceId`, mining seat | Harvests one assigned source, transfers/drops, advertises haul; idles near home if no source; replacement lead is body spawn time + buffer | Seat/source reservations and source/container scans; remote assignment cleanup is important |
| Freighter | CARRY demand from local/remote backlog; CARRY/MOVE | `homeRoom`; local candidate or remote haul reservation | Collects reserved energy, then delivers to base; clears invalid/finished reservations; idles/returns home when no job | Candidate scans and reservation rebuilds can loop all creeps/targets |
| Tech | Desired WORK based on economy/CPU; WORK/CARRY/MOVE | `homeRoom`; local controller and prioritized fuel | Withdraws controller-container/storage/etc., upgrades at range 3, mines only as fallback | `upgrading`; work-based queued counts must match final spawned body |
| Artificer | WORK demand from construction and repair backlog | `homeRoom`; claimed local target or visible active remote | Repairs (limited workers), builds, performs remote road/container work, then upgrades/idles | Large state machine; repair/build scans and claims must be cleaned after death |
| Annex | Remote reservation demand or explicit expansion claim; CLAIM/MOVE | `homeRoom`, `targetRoom`, `annexMode` | Reserves/signs controller or claims expansion; terminal blocked states idle/return | Route safety and stale target state |
| Pioneer | Expansion bootstrap demand; WORK/CARRY/MOVE | Origin/expansion `targetRoom` | Carries/builds spawn and bootstrap structures; requests supply help when starved | Expansion state coupling and target/site invalidation |
| SupplyRunner | Expansion logistics demand; CARRY/MOVE | `homeRoom`, expansion `targetRoom` | Moves energy from origin to expansion bootstrap | Cross-room route safety and supply-state cleanup |
| Scout | One per colony; MOVE | Shared `Memory.rooms[home].scoutPlan`, radius 3 | Scans intel/Score/remotes, cycles stale rooms, pauses unreachable rooms, idles near home | `scanRoom` plus Score/remote scans; plan is persistent and bounded |
| Ronin | Configured one; melee/TOUGH/HEAL | WarRoom target or explicit room/flag | Attacks at range 1, self/support heals, moves off exits, idles near combat context | Combat target scans are shared through WarRoom but formation is loose |
| Volley | Configured one; ranged/HEAL | WarRoom target or explicit room/flag | Ranged attacks at preferred range, heals, moves off exits | Same as Ronin; retreat/kiting remains live-verification dependent |
| Cleric | Configured one; HEAL/MOVE | Wounded combat creep, buddy, or target flag/room | Self-heals first, heals/ranged-heals allies, follows buddy | Repeated combat-friendly scans in WarRoom |
| ScoreRunner | Colony-local reachable Score demand; MOVE | `homeRoom`, claimed Score target or adjacent exploration room | Occupies exact Score tile (range 0), renews claim, avoids failed targets, explores/flees | Route checks are bounded; debug state currently writes every active tick per runner |

`role.Dismantler.js` and `role.Repair.js` contain complete role implementations but have no spawn demand, body plan, import, or dispatcher branch. They are classified as dormant prototypes, not deleted.

## 5. Movement architecture

Roles normally call `utility.Travel.Creep.move()`/`moveToRoom()`. The wrapper maintains `_trav`, `_move`, `_sushiRoute`, and `_sushiMoveTick`, supports shared same-room route caching, and registers intended steps with `traffic_manager`. Traveler supplies PathFinder matrices and cross-room routing. `main.js` resolves traffic once after all role intents. Direct `creep.moveTo` references are limited to legacy/emergency fallback paths in `role.Artificer.js`, `role.Extractor.js`, `role.Scout.js`, and the wrapper; they require case-by-case review rather than global replacement.

Route-cache keys include stable start/end objects and exact start coordinates for same-room lanes. ScoreRunner deliberately disables the shared route cache for cross-room targets and forces `findRoute` so safety callbacks are not skipped for short routes.

## 6. Room and construction planning

`Planner.Brain.js` owns `Memory.rooms[room].structurePlanner`. Replanning is incremental: initialize, select anchor, place fixed/source/controller items, scan candidates, fill structure modules, add ramparts, then commit. `buildSites()` respects the global site cap and uses the saved RCL plan. `Planner.Roads.js` separately builds a hub/source/controller/remote road network and consumes compact remote path coordinates. `Visual.Planner.Structures.js` is read-only and disabled by default.

The planner family contains small structure-specific modules (`Planner.Container`, `Extension`, `Extractor`, `Factory`, `Lab`, `Link`, `Nuker`, `Observer`, `PowerSpawn`, `Rampart`, `Spawn`, `Storage`, `Terminal`, `Tower`) that are reached through `Planner.Brain.js`; they are not dead simply because `main.js` does not import them.

## 7. Persistent Memory structures

| Path | Purpose | Classification |
|---|---|---|
| `Memory.settings` | User feature/debug/economy settings | Must survive reset; preserve unknown keys |
| `Memory.cpuPolicy`, `Memory.spawnPolicy` | User-tunable policy defaults/caps | Must survive reset |
| `Memory.cpuStatus` | Last CPU snapshot and mode hysteresis | Helpful across reset; bounded single object |
| `Memory.rooms[room].sources` | Source positions, seats, containers, miner/haul metadata | Must survive reset; live reservations need cleanup |
| `Memory.rooms[home].remotePlanner` | Remote candidates, source scores, compact road paths, ownership | Helpful across reset; bounded by scouted adjacent rooms |
| `Memory.rooms[room].structurePlanner`, `.roadPlanner` | Saved plans/jobs/completion state | Helpful across reset; invalidate by version/state |
| `Memory.rooms[room].spawnQueue` | Pending spawn requests | Must survive reset; must remain bounded and valid |
| `Memory.rooms[room].spawnDemandCache` | Staggered demand/debug summaries | Helpful across reset, but debug fields should avoid churn |
| `Memory.rooms[home].scoutPlan` and per-room `scoutIntel` | Ring and durable room intel | Helpful across reset; stale intel is timestamped |
| `Memory.expansion`, `Memory.WarRoom` | Strategic state and threat assignment | Must survive reset while active |
| `Memory.scoreSeason.targets/hostileRooms` | Score intel, claims, temporary danger | Helpful across reset; decay/claim cleanup is bounded |
| `Memory.creeps[name]` | Per-creep state | Must survive reset while creep lives; deleted after death |
| Traveler/shared route objects in `global` | Rebuilt RoomPositions and tick/path caches | Tick/global heap cache; should not enter Memory |

No schema-wide migration system exists. Existing migrations are feature-local and idempotent (for example the ScoreRunner role-cap migration and remote path version). A future schema version should not erase unknown configuration.

## 8. Heap/cache architecture

- `CPU.Status.js`: one status object per tick.
- `Season.Score.js`: per-tick room scans, safety, route lengths, summaries, stats, and username; persistent targets/hostile TTLs live in Memory.
- `utility.Travel.Creep.js`: shared route objects in `global`, with TTL cleanup.
- `Planner.Remote.js`: decoded remote RoomPosition paths in `global.__sushiRemotePlannerPaths`.
- Spawn demand: persistent staggered per-room summaries under `spawnDemandCache`.
- Planner jobs: incremental persistent jobs because they must survive global resets and CPU pauses.

High-frequency traffic cost matrices are rebuilt every visible-room tick and currently have no heap cache.

## 9. Remote-room ownership and assignment

Only rooms directly adjacent to the home room are eligible. Scouts call `Planner.Remote.scanVisibleRoom`; candidates are rejected for enemy ownership, serious danger, keeper risk, invalid/long paths, or non-positive estimated income. `claimBestParentForSource()` prevents two colonies from owning the same source. At most four remote sources per home are active. One remote Extractor is allowed per active source; living and queued assignment checks use home, room, source, role, and `remoteMining`. Source `assignedMiner` arrays are cleaned against live creep IDs. Freighter pickup reservations are reconstructed from living Freighters, so dead and expired shares disappear.

## 10. CPU-policy flow

`CPU.Status.js` treats `Game.cpu.limit` as sustainable and reports `tickLimit`. `main.js` freezes the mode before planners. Spawn planning scales its CPU budget by the frozen mode, and Season scoring skips optional scans under critical mode. However, the first sample is near tick start and the persisted debug snapshot is also early, so usage-driven mode changes do not currently observe the completed prior tick. Separately, structure, road, remote, and shared-route planners compare current CPU to `tickLimit`; this defeats sustainable-budget gating when `tickLimit` is high. Both are ranked High.

## 11. Dashboard and debug flow

`Visual.Dashboard.js` defaults on, builds one creep summary for its own pass, reads spawn/work/haul summaries from Memory, and draws one dashboard per selected owned room. The remote dashboard also performs live hostile, structure, drop, source, and spawn scans. These scans do not rerun planners, but they duplicate simulation queries and need caching/throttling. Console logs are mostly event/throttle based: remote summary every 500 ticks, dead Memory cleanup on death, and spawn events/errors. ScoreRunner writes `scoreDebug` every active tick, which is bounded but creates serialization churn.

Useful existing settings include `showDashboard`, `dashboardRoom`, `dashboardShowRoleCounts`, `showRemoteRoomDashboard`, `showStructurePlanner`, `showRoadPlanner`, `useTrafficManager`, and `useWarRoom`.

## 12. Season 10 Score flow

`Scout`, `ScoreRunner`, and `main.js` all report visible rooms into one per-tick scan cache. Skipped critical-CPU scans are explicitly marked unscanned and cannot delete remembered targets. Visible missing Scores and expired targets are removed; dead/expired claims are cleared. Target demand is colony-local by linear range/decay/safety. Selection ranks all cheap candidates, performs at most eight safe route checks, and keeps up to three viable results. ScoreRunner claims, renews, occupies range 0 without pickup/withdraw/harvest, resets stale travel after stuck thresholds, explores adjacent safe rooms, and flees visible threats.

Live Season 10 verification is still required for exact object constants/properties and claim timing on the active server.

## 13. Known third-party dependencies

- `Traveler.js`: Traveler pathing library; intentionally uses newer JavaScript syntax and is not rewritten for style.
- `traffic_manager.js`: Harabi-style traffic resolver; intentionally uses newer syntax and is treated as a stable imported dependency.
- Screeps global `_` (lodash) is used by the traffic manager.

All substantially changed first-party runtime code must remain conservative ES5/CommonJS.

## 14. Ranked findings

| Finding | Severity | Affected files | Gameplay impact | CPU impact | Confidence | Recommended change | Risk |
|---|---|---|---|---|---|---|---|
| Strategic CPU sampling uses near-zero start-of-tick usage and never persists final usage | High | `CPU.Status.js`, `main.js` | Pressure modes react mainly to bucket, not actual sustained overuse | High under constrained limits | High | Base the frozen mode on the completed prior tick and finalize usage once at tick end | Low |
| Optional planner guards compare against `tickLimit` | High | `Planner.Brain.js`, `Planner.Remote.js`, `Planner.Roads.js`, `utility.Travel.Creep.js` | Optional PathFinder/site work can consume bucket above sustainable allowance | High | High | Gate against `Game.cpu.limit`/shared status remaining | Low |
| Normal queued bodies are permanently shrunk to current energy | High | `spawn.manager.js` | Mature rooms can repeatedly spawn minimum bodies instead of waiting for designed bodies | Indirectly high through excess creeps/work loss | High | Preserve planned body for normal requests; adapt only impossible/emergency requests | Medium |
| Only one idle spawn is serviced per room each tick | High | `main.js`, `spawn.manager.js` | RCL7/8 rooms cannot use parallel spawns from one queue | Low CPU; high spawn throughput | High | Drain up to the number of idle spawns while energy/queue permit | Medium |
| Traffic structure/site matrices rebuild for every visible room every tick | Medium | `main.js` | No correctness loss, but needless repeated immutable scans | Medium | High | Add short heap TTL/invalidation and reuse one matrix per room | Low |
| Dashboard performs live remote scans every tick while enabled | Medium | `Visual.Dashboard.js` | Debug-only; can compete with gameplay CPU | Medium | High | Consume haul/intel caches and throttle any unavoidable live refresh | Low-Medium |
| Repair list is replaced in Memory every ten ticks even when unchanged | Medium | `main.js` | No gameplay loss | Serialization estimate: low-medium | High | Compare compact ID list before assignment | Low |
| ScoreRunner rewrites `scoreDebug` every active tick | Medium | `role.scorerunner.js` | No gameplay loss | Memory churn scales with runners | High | Write on state/detail/target change or throttle identical states | Low |
| Foreman and Scout both call broad room scan logic | Medium | `role.Foreman.js`, `role.Scout.js`, `utility.js` | Intel remains correct | Potential repeated room queries/writes | Medium | Add per-room per-tick scan cache in `utility.js` | Medium |
| Source map markers are unconditional and mojibake text is present | Low | `main.js`, `utility.Visual.js` | Visual clutter/incorrect glyph only | Low-medium per visible room | High | Add a setting and correct the string/export syntax | Low |
| Dormant role files are not dispatchable or spawnable | Informational | `role.Dismantler.js`, `role.Repair.js`, `main.js`, body/spawn config | No current impact because no active producer exists | None | High | Keep documented until a complete demand/body/dispatch design exists | Medium if activated |
| Lowercase `role.scorerunner.js` is inconsistent | Low | `main.js`, `role.scorerunner.js` | Portability/confusion risk on case-sensitive tooling | None | High | Defer rename to avoid deployment/module-name risk | Medium |

## 15. High-risk modules

- `spawn.request.manager.js` (4,000+ physical lines): many interacting caps, counts, demand caches, and emergency bypasses.
- `Planner.Brain.js`: persistent incremental state plus construction-site side effects.
- `Planner.Remote.js`: durable ownership, pathfinding, source profitability, and reservations.
- `utility.Travel.Creep.js`: shared movement state used by nearly every role.
- `utility.Creep.js`: source/seat assignment and cross-role economy helpers.
- `role.Freighter.js` and `role.Artificer.js`: large state machines with persistent claims.
- `Logic.Expansion.js`: multi-room state machine and independent spawn requests.
- `Season.Score.js`: seasonal API compatibility, target truth, routing, claims, and decay.

## 16. Dead or apparently unused modules

- `role.Dismantler.js`: not imported, dispatched, requested, or included in body plans.
- `role.Repair.js`: not imported, dispatched, requested, or included in body plans; Artificer owns active repair behavior.
- `utility_spawn` and `utility` imports in `main.js`: no live references after import.

The singular `Planner.Road.js` and plural `Planner.Roads.js` are both active and have different responsibilities. Small `Planner.*` files are called through `Planner.Brain.js` and are active.

