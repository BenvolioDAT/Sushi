# Sushi static performance baseline

Baseline commit: `5733985a05b494a47892de6f967f6b2b4fe352c6`  
Captured before audit edits on branch `codex/screeps-deep-audit`.

No live shard CPU profile or Memory payload was available. All CPU statements below are static-analysis estimates, not measured runtime improvements.

## Repository size and tooling

- Tracked files: 53.
- JavaScript files: 52.
- JavaScript lines reported by PowerShell `Get-Content | Measure-Object -Line`: 25,233.
- Markdown/tests/package metadata at baseline: none.
- Existing automated tests: none found.
- TODO/FIXME/HACK/XXX matches: none found.
- Case-insensitive duplicate filenames: none.
- Baseline syntax: bundled Node `--check` passed all 52 JavaScript files.

Largest modules by measured lines:

| File | Lines |
|---|---:|
| `spawn.request.manager.js` | 3,462 |
| `Planner.Brain.js` | 2,139 |
| `utility.Creep.js` | 1,749 |
| `Planner.Remote.js` | 1,517 |
| `Logic.Expansion.js` | 1,374 |
| `role.Freighter.js` | 1,228 |
| `utility.Travel.Creep.js` | 1,127 |
| `Visual.Dashboard.js` | 1,094 |
| `role.Artificer.js` | 997 |
| `utility.js` | 984 |

Line totals are a sizing signal only; comments are intentionally extensive and physical line counts do not equal executable complexity.

## Static API occurrence counts

These are textual occurrences across top-level `*.js` files, not runtime call counts:

| Pattern | Occurrences |
|---|---:|
| `Game.creeps` | 83 |
| `Game.rooms` | 79 |
| `Game.spawns` | 35 |
| `Game.flags` | 11 |
| `Game.constructionSites` | 5 |
| `Memory.rooms` | 275 |
| `Memory.creeps` | 7 |
| `room.find` | 112 |
| `.find(FIND_` | 88 |
| `lookForAt`/`lookForAtArea` textual matches | 35 |
| `PathFinder.search` | 5 |
| `Game.map.findRoute` | 7 |
| `Game.map.findExit` | 2 |
| `JSON.stringify` | 0 |
| `RawMemory` | 0 |

PathFinder sites occur in Traveler (2), the travel wrapper/shared-route planner (1), remote planner (1), and road planner (1). `findRoute` occurs in Traveler, expansion routing, and Season Score routing. These calls are not all per tick: several are TTL-, candidate-, scout-, or plan-gated.

## Dependency and dispatch baseline

- `main.js` directly requires 27 runtime modules.
- Structure-specific planner modules are indirectly required by `Planner.Brain.js`.
- Role dispatch is a single `Game.creeps` loop in `main.js`.
- Spawn planning performs a separate `Game.creeps` pass for each owned spawn room when building its context.
- Dashboard performs another global creep pass when enabled.
- Remote reservations and several fallback helpers perform additional creep loops on demand.
- `role.Dismantler.js` and `role.Repair.js` have no inbound runtime references.

## High-frequency work estimates

### Every tick

- Main cleanup/CPU/Score maintenance and three planner entry points.
- Tower scan per visible owned room.
- Source map visual scan per visible room.
- Dead creep Memory cleanup over `Memory.creeps`.
- Spawn context build: one full `Game.creeps` pass per owned spawn room.
- Role dispatcher: one `Game.creeps` pass.
- Score visible-room reporting; Score object scans are protected by a per-tick room cache and may be skipped under critical CPU.
- Traffic: one structures scan, one construction-sites scan, and one owned-creeps scan per visible room.
- Dashboard: one global creep pass plus room/remote data reads and live remote scans when enabled.

### Periodic or gated

- Repair-list full structure scan: every 10 ticks per owned room.
- Spawn full demand plan: default every 3 ticks, staggered by room and CPU budget; emergency planning still runs on light passes.
- Road and structure planning: persistent intervals, bucket/site limits, and job budgets.
- Remote heavy refresh: every 75 ticks; rescore every 1,000 ticks; Scout vision also refreshes relevant adjacent rooms.
- Expansion candidate routing: cached/paced by expansion state.
- Score route selection: at most eight route checks per selection and at most three viable candidates.

## Baseline cache review

Good bounded caches already present:

- CPU status frozen once per tick.
- Score scan/safety/route/summary/stats caches reset per tick; persistent targets decay.
- Shared travel routes have TTL cleanup.
- Remote decoded paths live in heap and are versioned.
- Structure/road planners are incremental and site capped.
- Spawn demand calculations are staggered and cached per room.

Issues found:

- CPU mode freezes too early without a completed-tick usage sample.
- Four optional-work guards use `tickLimit`, so their nominal ceiling can exceed sustainable CPU.
- Traffic structure/site matrices have no TTL cache.
- Dashboard duplicates live remote structure/drop/threat scans.
- Several debug snapshots assign new Memory objects/arrays even when values are unchanged.
- ScoreRunner debug Memory is rewritten every active tick.

No unbounded arrays were proven in static analysis. Spawn queues, Score targets, hostile rooms, route caches, scout plans, remote sources, planner positions, and repair lists all have natural caps, TTLs, visibility replacement, or explicit cleanup. Live shard inspection is still required to confirm actual serialized sizes and old-version residue.

## Baseline correctness checks

- All 52 JavaScript files passed syntax checks.
- No automated tests existed, so no behavior test baseline could be executed.
- No package/build system existed.
- No use of `JSON.stringify` or `RawMemory` was found.
- Newer syntax is concentrated in known dependencies `Traveler.js` and `traffic_manager.js`; a shorthand property export also exists in first-party `utility.Visual.js`.
- Direct `creep.moveTo` text appears in legacy/emergency fallback code; the normal movement architecture uses `utility.Travel.Creep`.

## Measurements needed in the live shard

1. CPU segments for spawn planning, structure planning, roads, remotes, roles, traffic, Score, and visuals.
2. Per-room creep count and CPU scaling as colony count grows.
3. Traffic matrix and dashboard share of CPU with debug visuals on/off.
4. Serialized Memory size by major top-level path.
5. Path/route cache hit rates and stuck resets.
6. Spawn utilization for rooms with two or three spawns.
7. Remote gross delivery versus miner/hauler spawn and repair cost.
8. Score target discovery-to-claim latency and successful collection ratio.

