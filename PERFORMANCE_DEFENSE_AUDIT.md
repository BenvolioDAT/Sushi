# Sushi performance and defensive-combat audit

Audit date: 2026-07-16  
Working branch: `codex/performance-defense-audit`  
Starting revision: `5c88a00d29fed3b350b0fdea876d929dd2f53bce`  
Upstream checked: `origin/codex/screeps-deep-audit` at the same revision; `origin/main` was older at `5733985`.

## Outcome

The audited branch keeps the recent CPU governor, Score-season, Tech-demand, movement, and spawn-queue work and adds a targeted reset/per-tick/defense layer around it.

The highest-risk findings were corrected:

- `main.js` had 30 eager `require` bindings. It now has nine direct reset-critical imports; planners, visuals, and individual role modules load on demand.
- The first tick after a global reset keeps CPU/Score state, enabled WarRoom defense, towers, emergency recovery spawning, living-creep behavior, spawning, and traffic. Routine planners, expansion, map flags, visible Score scans, dashboard work, repair-list maintenance, dead-creep cleanup, and pixel generation wait one tick.
- Repeated top-level creep, room, spawn, structure, construction-site, hostile, source, and role scans now share one heap-only per-tick index in `Tick.Cache.js`.
- Score target route budgeting is by unique destination room, so several targets in one unreachable room cannot consume the entire route budget or hide a later valid room.
- Towers and defenders use a shared boost-aware threat model. Towers focus fire, include range falloff, hostile healing, boosted `TOUGH`, tower energy/effects, target locks, and critical-defender healing.
- Defensive spawn demand is live and room-local. Harmless scouts do not trigger combat creeps, tower-solvable pressure does not automatically spawn fighters, healers are not spawned without a fighter, and stale defense requests are removed after safe live vision.
- Ronin, Volley, and Cleric share threat/target information, claim useful ramparts, retreat when compromised, kite through the movement wrapper, and release invalid healer partnerships.
- The Node test suite now executes 29 focused cases. All 56 root JavaScript modules pass syntax validation.

No production or private-server CPU sample was available from this repository checkout. Static counts and Node mocks below are measurements; expected Screeps CPU effects are explicitly labeled as hypotheses until the live checklist is run.

## Priority findings

| Priority | Finding | Disposition |
| --- | --- | --- |
| P0 | Every planner, visual, role, expansion, WarRoom, and utility family loaded during global evaluation. | Fixed with lazy module/role loading and a one-tick reset phase. |
| P0 | Score route budget was effectively target-oriented, allowing one bad destination room with several targets to starve later rooms. | Fixed and regression-tested. |
| P0 | Towers selected targets without coordinated net-damage, healing, or boosted-durability analysis. | Fixed with shared evaluation and short target locks. |
| P0 | Combat roles had weak retreat, healer, target-lock, and rampart coordination. | Fixed with shared WarRoom state and role-level retreat/kiting behavior. |
| P1 | Repeated `Game.*` enumeration and `room.find` work occurred across main, dashboard, spawn planning, travel, tower, and WarRoom paths. | Materially reduced through `Tick.Cache`; remaining hotspots are listed below. |
| P1 | Defense roles were configured as fixed peacetime desired counts rather than live room demand. | Fixed; defense requests are threat-driven and local. |
| P1 | Traffic allocated a CostMatrix for every visible room, even rooms with no owned creeps, and performed another creep find. | Fixed for empty rooms and duplicate creep scans. A matrix is still built per populated visible room per tick. |
| P1 | Hostile power creeps, nukes, and long-range multi-room reinforcement strategy are not modeled. | Remaining scope; do not infer safety from this audit for those threats. |
| P2 | `Logic.Expansion.js`, `Planner.Remote.js`, and several economy roles retain many direct world lookups. | Remaining optimization targets; they are now deferred or interval-governed, which lowers urgency. |
| P2 | `Traveler.js` and `traffic_manager.js` use modern syntax. | Existing compatibility assumption retained. First-party additions use ES5-style `var`/functions. |

## Repository and dependency map

### Major subsystems

| Area | Entry points and ownership |
| --- | --- |
| Tick orchestration | `main.js` owns phase order, settings, reset warmup, profiling boundaries, role dispatch, and traffic finalization. |
| CPU | `CPU.Status.js` freezes strategic mode from the last finalized tick. `CPU.Profiler.js` is opt-in and keeps samples in heap until a bounded flush. |
| Shared reads | `Tick.Cache.js` owns per-tick world indexes and cached room finds. It never writes `Memory`. |
| Spawning | `spawn.request.manager.js` computes demand and queues requests. `spawn.manager.js` is the sole queue consumer/spawn executor. |
| Movement | `utility.Travel.Creep.js` wraps Traveler and shared stable routes. `traffic_manager.js` resolves same-room movement conflicts at the end of the tick. |
| Planning | `Planner.Brain.js` fans out to structure planners; `Planner.Remote.js` and `Planner.Roads.js` handle remote/road state. These are deferred on reset. |
| Score season | `Season.Score.js` owns discovery, target summaries, claims, route safety, and target ranking. `role.scorerunner.js` consumes it. |
| Defense | `Combat.Threat.js` analyzes bodies; `Defense.Demand.js` converts live pressure into spawn demand; `Logic.Tower.js` controls towers; `Logic.WarRoom.js` coordinates mobile defenders. |
| Presentation | `Visual.Dashboard.js`, structure visuals, source-map flags, and pixels are nonessential and reset-deferred. |

The lexical first-party dependency graph has zero circular import cycles. `Planner.Brain.js` has the widest fan-out at 16 structure planners. `main.js` has nine direct dependencies. `spawn.request.manager.js` has eight lexical dependencies, but `Planner.Remote` is loaded through a getter only when remote demand is actually refreshed.

The reset-critical dependency chain is intentionally one-way:

```text
main
|- Tick.Cache
|- CPU.Status / CPU.Profiler
|- Season.Score
|- Logic.Tower -> Combat.Threat -> Tick.Cache
|- spawn.request.manager
|  |- spawn.manager / body config / CPU / Score / Tick.Cache
|  `- Defense.Demand -> Combat.Threat / Logic.Tower
|- utility.Travel.Creep -> Traveler / Tick.Cache
`- traffic_manager
```

Planner, expansion, visual, and role imports do not point back to `main.js`.

### Global-evaluation side effects

- `main.js` samples startup CPU only when `Game.cpu.getUsed` exists.
- `trafficManager.init()` runs once per global and installs the movement-intent prototype hooks.
- Requiring `Traveler.js` installs `Creep.prototype.travelTo` as before.
- CPU, threat, demand, WarRoom, Score, and tick-cache runtime caches are heap state. They invalidate by `Game.time` or explicit TTL rather than serializing each tick.
- Settings/migrations use missing-key checks, so repeated calls are idempotent. Existing user values are preserved.

## Startup and tick phase audit

Current phase order:

1. Ensure small settings and build the shared tick index.
2. Clean shared route-cache metadata; freeze CPU mode; maintain Score claims/TTL state.
3. Run WarRoom only if explicitly enabled.
4. After reset tick only: remote, structure, and road planners.
5. Run towers in every visible owned room.
6. After reset tick only: stable-staggered repair lists and optional source-map flags.
7. After reset tick only: dead-creep Memory cleanup and expansion.
8. Run spawn demand. Reset tick uses emergency-only planning; each affected room can immediately feed all idle spawns.
9. Dispatch living creeps. Only roles that exist this global are loaded.
10. After reset tick only: visible Score discovery.
11. Resolve traffic for visible rooms containing owned creeps.
12. After reset tick only: planner visuals and dashboard.
13. Finalize CPU state and flush profiler data only when profiling is enabled.

First-tick behavior is covered by an executable empty-world reset test. It verifies that the loop completes and that no optional planner/visual module was loaded. The test does not replace a real Screeps global-reset measurement with populated rooms and creeps.

## Performance evidence

### Static scan

These are source-token counts across root `*.js` files at the starting revision and current worktree. They are not runtime invocation counts, but they are useful evidence that common duplicate-read patterns moved behind shared helpers.

| Pattern | Start | Current | Change |
| --- | ---: | ---: | ---: |
| `Game.creeps` | 83 | 69 | -14 |
| `Game.rooms` | 79 | 68 | -11 |
| `Game.spawns` | 39 | 33 | -6 |
| `.find(` | 89 | 70 | -19 |
| `PathFinder.search` | 5 | 5 | 0 |
| `JSON.stringify` | 0 | 0 | 0 |
| direct eager `main.js` require bindings | 30 | 9 | -21 |

`Game.cpu.getUsed` source references increased from 18 to 22 because named profiler boundaries were added. When profiling is disabled, `CPU.Profiler.start/end/flush` make zero `getUsed` calls; this is regression-tested.

### Work removed or bounded

- One `Game.creeps` enumeration now builds role/home/body-part indexes for spawn demand, main role dispatch, and dashboard counts.
- Room structure, construction-site, source, hostile, owned-creep, and owned-structure results are cached per room/find type for the tick.
- Travel stable-anchor and shared-route matrix construction reuse those room arrays.
- Traffic reuses the cached owned-creep array and does no CostMatrix work in visible rooms with no owned creeps.
- Repair-room scans use a stable room-name offset instead of all colonies synchronizing on the same modulo tick.
- Unchanged repair ID arrays are not reassigned to `Memory`.
- Source-map flags default off and can be interval-limited.
- Spawn planning uses cached role/body/queue summaries. Light-pass debug stays in heap and only persists on a full pass, CPU skip, or 25-tick heartbeat.
- Defense summaries persist on state change or a 10-tick heartbeat, not as a newly assigned object every tick.
- Score and WarRoom caches use bounded TTLs and same-tick reuse. Target locks reduce oscillation without permanently pinning bad targets.

### Remaining CPU risks

1. A populated visible room still receives a new traffic CostMatrix each tick. Caching it across ticks would need reliable invalidation for new/destroyed structures, construction sites, public ramparts, and owner changes.
2. `Logic.Expansion.js` and `Planner.Remote.js` remain the largest combined direct-world-lookup files. Their current interval/deferred execution is the safety boundary; profile before rewriting them.
3. Traveler may invoke `PathFinder.search` when serialized paths or shared routes miss. This is correct fallback behavior, but path misses should be monitored in a large colony.
4. The dashboard is cached but still aggregates a broad visible-room view when enabled. It is reset-deferred, not free.
5. `Memory` has many feature paths. The changes avoid JSON serialization and reduce same-value assignment, but a real serialized-memory size/timing sample is still needed.

## Score-season audit

The existing Score architecture was preserved. The fixes are narrow:

- Route checks are budgeted and cached by destination room. All targets in the same failed room share one route result.
- A later valid room remains eligible after an earlier destination fails.
- Spawn demand is zero when the reachable-target summary contains no targets, even in high CPU mode.
- Normal movement, exploration, and fleeing all use the same Season room-safety callback.
- Claims, decay safety, hostile-room TTLs, and target summaries remain bounded in `Season.Score.js`.

Relevant tests cover same-room route reuse, later-valid selection, no-runner demand with no targets, and flee-route safety.

## Defensive-combat audit

### Threat classification

`Combat.Threat.js` scores only active body parts and reads runtime `BOOSTS` multipliers when available. It distinguishes:

- harmless scout/carry/move bodies;
- melee attackers;
- ranged attackers;
- healers and their nearby support;
- dismantlers using `WORK` dismantle power;
- claimers near critical controller/structure positions;
- boosted `TOUGH` effective durability.

Strategic distance to spawns, towers, storage, terminal, controller, and ramparts contributes to urgency. A harmless scout remains visible in counts but does not become a harmful hostile.

### Tower policy

- Tower damage uses official 600-at-range-5 through 150-at-range-20 falloff.
- Only towers with enough energy to attack contribute to expected damage.
- `PWR_OPERATE_TOWER` effects are included when exposed by the runtime.
- Expected damage passes through current body-order `TOUGH` reduction and subtracts hostile healing support.
- All towers focus the best target. Killable supported threats and healers are preferred over high-durability stalemates.
- A three-tick lock reduces target thrash but breaks for materially higher strategic or total threat.
- If tower fire cannot make progress and a defender is in critical projected danger, towers heal that defender.
- Any hostile presence suppresses repairs. During peace, towers heal first, reserve defensive energy, and split repair targets to reduce over-repair.

### Room-local spawn response

- No unseen or stale threat can cause another colony to spawn defenders.
- Weak pressure that local towers can plausibly solve creates no fighter request.
- Dismantlers, no-tower rooms, threats adjacent to critical structures, or high net pressure mark an emergency.
- Melee and ranged demand follows hostile capability. A healer is requested only when a fighter is living, queued, or being planned.
- Ronin/Volley/Cleric queue priorities are above optional growth but below Foreman and local Extractor recovery.
- Requests carry `defenseRequest`, `defendedRoom`, `targetRoom`, and request-tick metadata.
- Duplicate living/queued/planned roles count toward the same room demand. Safe live vision removes excess marked requests.
- Safe mode is never automatically activated. A deduplicated warning is emitted only for a critical structure-range scenario in which tower damage cannot beat hostile healing.

### Mobile defender behavior

- WarRoom uses the same threat analyses as towers and gives the current tower target a coordination bonus.
- Combat targets have a three-tick lock with a critical-threat break condition.
- Inactive Invader Cores are ignored; an active `ATTACK` capability is required.
- Melee and ranged defenders claim different useful ramparts when possible. Melee prefers range 1; ranged prefers range 2-3.
- Rampart selection uses cheap range scoring rather than a PathFinder search per defender/rampart pair.
- Volley uses ranged mass attack only when the summed local value is stronger than a single shot and kites melee threats through `utility.Travel.Creep`.
- Ronin and Volley retreat toward a friendly rampart, tower, or spawn when health is low.
- Cleric ranks projected incoming damage, self-preserves, releases dead/invalid partners, and avoids remaining isolated.

### Known defensive limits

- Hostile power creeps and nukes are outside the current threat summary.
- Defense spawning requires live vision by design. It does not dispatch reinforcements based only on stale remote intelligence.
- Rampart range scoring does not prove path reachability or account for every traffic conflict.
- Incoming-damage and hostile-heal estimates are tactical approximations, not a full combat simulator.
- Safe mode remains a human decision. The console warning is not a guarantee that the trigger conditions are exhaustive.
- Tower sufficiency uses current towers/energy and the primary threat. Coordinated boosted squads should be tested on the private server before relying on zero-spawn decisions.

## Memory and migration safety

New/updated paths are initialized only when missing:

- `Memory.settings.enableCpuProfiling` (default `false`)
- `Memory.settings.showSourceMapFlags` (default `false`)
- `Memory.settings.sourceMapFlagInterval` (default `5`)
- `Memory.cpuProfile` (only when profiling is enabled and flushed)
- `Memory.rooms[room].defenseSummary`
- short-lived tower target fields under the room's tower memory
- defense-request metadata inside existing room spawn queues

`Tick.Cache`, live spawn-governor debug, current threat summaries, rampart claims, and combat analyses remain in heap. Existing Score, CPU, spawn-policy, role-cap, and Tech-demand schemas are retained. The prior one-time removal of obsolete `Memory.cpuPolicy.maxCpuOverride` remains idempotent.

## Public-bot and official-mechanics research

No external source code was copied. The implementation is an original fit to Sushi's current architecture.

| Source | Pattern studied | Fit and CPU implication | Risk / license / reuse decision |
| --- | --- | --- | --- |
| [TooAngel/screeps](https://github.com/TooAngel/screeps) | Autonomous recovery and keeping an empire operable without routine manual intervention. | Reinforced the decision that reset tick and low-creep states must preserve local income/spawning before optional work. | AGPL-3.0. Concepts only; no code copied. |
| [The International open-source bot](https://github.com/The-International-Screeps-Bot/The-International-Open-Source) and its [design notes](https://github.com/The-International-Screeps-Bot/The-International-Open-Source/blob/Main/DESIGN.md) | Data-oriented cached utilities, organized tick initialization, services/processors, and coordinated defense. | Supports one per-tick shared index and shared threat facts rather than each role rescanning. This reduces repeated work but centralizes cache correctness. | MIT. Concepts only; no code copied. |
| [Official Screeps defense guide](https://docs.screeps.com/defense.html) | Ramparts, towers, and safe mode as complementary layers. | Used to prioritize rampart positioning, tower-first defense, and conservative safe-mode warnings. | Documentation; behavior reimplemented for Sushi. |
| [Official Screeps API](https://docs.screeps.com/api/) | Tower powers/range behavior, active body parts, boosts, and game object semantics. | Supplies the numeric mechanics used by threat and net-damage estimates. | Authoritative mechanics reference; no source copied. |
| [Official caching overview](https://docs.screeps.com/contributed/caching-overview.html) | Heap/global cache versus serialized `Memory`. | Supports tick-local indexes and bounded TTL caches without per-tick serialization. | Guidance only. Cache invalidation remains Sushi's responsibility. |

## Automated verification

Run from the repository root with the bundled or local Node runtime:

```powershell
node tests\run.js
```

Current result: `29 passed, 0 failed`.

Coverage includes CPU hysteresis/finalization, spawn body preservation/adaptation/parallel spawns, same-tick cache reuse, disabled-profiler cost, Score route failure cases, scout/attacker/dismantler/boosted-TOUGH analysis, tower target/heal/repair/lock behavior, room-local defense request lifecycle, separate rampart claims, healer cleanup, active Invader Core checks, projected healer danger, stale WarRoom expiry, no-spawn safety, and a first-global-reset empty-world loop.

All 56 root JavaScript files also pass `node --check`. This validates syntax, not Screeps runtime semantics.

## Live local-server checklist

Use a private-server snapshot or a disposable branch upload. Record actual observations in `STARTUP_BASELINE.md`; do not infer pass/fail from a quiet public-shard tick.

### 1. Normal-colony baseline

- Select at least one mature owned spawn room and one remote operation.
- Record CPU limit, bucket, owned rooms, living creeps, active remotes, queue lengths, and whether WarRoom/dashboard/source flags are enabled.
- Run 50 warm ticks with profiling disabled. Confirm no new recurring console spam and no growth in spawn queues or Score claims.
- Enable profiling with `require('CPU.Profiler').enable()` and collect at least 50 more ticks.
- Inspect `require('CPU.Profiler').report()` and compare `spawnPlanning`, `towerDefense`, `creepRoles`, `trafficManager`, planner, Score, and visual sections.
- Disable it with `require('CPU.Profiler').disable()` after capture.

### 2. Global reset

- Leave `Memory.settings.enableCpuProfiling = true` before uploading/reloading so global-load and first-tick samples can be captured.
- Trigger one code upload/global reset at a representative colony size.
- On the first tick, inspect `require('main').getStartupState()`. `resetTick` should equal the current reset tick; optional modules should be absent except an explicitly enabled WarRoom.
- Verify towers act, existing creeps act/move, emergency requests can be queued, and idle spawns consume eligible requests.
- On the next tick, verify planners/expansion/visuals resume and role modules appear only for living roles.
- Confirm bucket trend recovers rather than continuing to fall for several ticks.
- Repeat at least three times and record median and worst first-tick CPU. One reset is not a baseline.

### 3. No-creep / bootstrap recovery

- On a disposable room snapshot, remove living creeps while retaining an owned spawn and enough energy for emergency bodies.
- Run `require('spawn.request.manager').run({emergencyOnly:true})` or allow the normal reset tick.
- Confirm Foreman, local Extractor, then Freighter recovery requests are considered before optional roles; the per-tick request cap may spread them across ticks.
- Confirm all idle spawns in the room can consume the shared queue without duplicate names.
- Confirm affordable emergency bodies can adapt while ordinary planned bodies remain preserved.
- Repeat with an owned room that has no owned spawn. It must return `Room has no owned spawn` without throwing or pretending the room is mature.

### 4. Score season

- Seed or observe multiple Score targets in one unreachable destination room and another valid room.
- Inspect `require('Season.Score').getStats()` and `Memory.scoreSeason.targets`.
- Confirm only one route check is spent for the failed destination and the valid room can still be selected.
- Mark a route room unsafe and force a ScoreRunner flee. Confirm its travel callback rejects the unsafe room.
- Clear all reachable targets and confirm no additional ScoreRunner request is queued, including in high CPU mode.
- Confirm target claims expire when the claimant dies and target records expire by decay/cleanup policy.

### 5. Tower scenarios

- Harmless scout only: confirm no fighter request. Towers may still attack the hostile; no repairs may occur during hostile presence.
- Single unboosted attacker: record `require('Combat.Threat').getRoomSummary(room)` and `require('Logic.Tower').getLastDefenseState(room.name)`. Confirm tower focus and expected room-local demand.
- Healer-supported attacker: confirm net damage includes hostile healing and towers prefer a killable/healer target rather than an impossible tank.
- Boosted `TOUGH` front: confirm effective durability rises and the target does not look falsely killable.
- Critical friendly defender: when tower net damage cannot progress, confirm tower healing is chosen.
- Peace: damage two useful structures and confirm separate towers avoid redundant over-repair while retaining energy reserve.

### 6. Mobile defense scenarios

- Enable WarRoom deliberately: `Memory.settings.useWarRoom = true`.
- Place melee, ranged, healer, and dismantler hostiles at different distances from a spawn/storage/rampart.
- Inspect current demand with `require('Defense.Demand').getCurrent(room.name)`.
- Inspect target/assignment state in defender `Memory`, tower state, and `require('Logic.WarRoom').getRampartClaims()`.
- Confirm Ronin and Volley claim different useful ramparts, focus the same high-value target when sensible, and break a short lock for a critical dismantler.
- Move a melee threat onto Volley. Confirm Volley kites unless protected on a claimed rampart and uses mass attack only when locally stronger.
- Injure a defender and kill its Cleric partner target. Confirm projected-danger healing, self-preservation, and dead-partner cleanup.
- Spawn an inactive Invader Core and confirm it is ignored; test an active core separately.
- Remove all hostiles under live vision. Confirm marked excess defense queue entries are removed and no other colony spawns a response.
- Disable WarRoom after the exercise if it is not part of normal policy.

### 7. Memory and long-run stability

- Snapshot `Memory` before upload.
- Verify existing `scoreSeason`, `cpuPolicy`, `spawnPolicy`, Tech-demand, room source, remote, and spawn queue records survive.
- Run 500+ ticks and check that `Memory.cpuProfile.history` remains bounded, defense summaries update only on transition/heartbeat, and route/Score/WarRoom TTL cleanup occurs.
- Watch for target oscillation, two defenders claiming the same rampart, repeated identical warnings, queue duplication, stale defense requests, and bucket deterioration.

## Console inspection commands

```javascript
require('main').getStartupState()
require('Tick.Cache').getDebugStats()
require('CPU.Profiler').enable()
require('CPU.Profiler').report()
require('CPU.Profiler').disable()
require('CPU.Profiler').reset()
require('spawn.request.manager').getSpawnGovernorDebug('W1N1')
require('Season.Score').getStats()
require('Combat.Threat').getRoomSummary(Game.rooms.W1N1)
require('Defense.Demand').getCurrent('W1N1')
require('Logic.Tower').getLastDefenseState('W1N1')
require('Logic.WarRoom').getRampartClaims()
Memory.rooms.W1N1.spawnQueue
Memory.rooms.W1N1.defenseSummary
```

Replace `W1N1` with the room under test.

## Rollback and review boundaries

The work is split into small local commits for startup/cache, Score, towers/threats, defense spawning, combat roles, and final verification/docs. Nothing was pushed. If a live scenario regresses, revert the narrow commit rather than deleting Memory wholesale. Keep profiling disabled by default and use the feature toggles for WarRoom, dashboard/planner visuals, source-map flags, and traffic while isolating a fault.
