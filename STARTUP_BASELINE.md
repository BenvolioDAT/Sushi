# Sushi startup baseline

Date: 2026-07-16  
Branch: `codex/performance-defense-audit`  
Baseline source revision: `5c88a00d29fed3b350b0fdea876d929dd2f53bce`

## Evidence status

This file separates three different kinds of evidence:

- **Measured locally:** repository/static counts, dependency analysis, Node tests, and syntax checks.
- **Implemented expectation:** behavior directly implied by the new phase gates and caches.
- **Not yet measured:** actual Screeps CPU/bucket/serialized-Memory behavior on a populated local server.

No live private-server process or representative colony snapshot was attached to this checkout. The live tables are intentionally blank rather than filled with synthetic timings.

## Starting baseline

At the starting revision:

- `main.js` declared 30 eager `require` bindings, including all 13 role modules, WarRoom, expansion, planner families, dashboard, and structure visuals.
- Remote, structure, and road planners ran on the reset tick.
- Expansion, source-map drawing, dead-creep Memory cleanup, Score visible-room reporting, and visuals could all run in the same first tick.
- Role dispatch independently enumerated `Game.creeps`; other systems repeated room/spawn/creep/find work.
- Spawn recovery existed, but full demand work and optional systems were not separated from reset-critical work.
- There was no named, opt-in subsystem profiler or shared tick-wide world index.

Starting static counts across root JavaScript modules:

| Pattern | Count |
| --- | ---: |
| root `*.js` modules | 52 |
| `Game.creeps` | 83 |
| `Game.rooms` | 79 |
| `Game.spawns` | 39 |
| `.find(` | 89 |
| `PathFinder.search` | 5 |
| `JSON.stringify` | 0 |
| eager `main.js` require bindings | 30 |

These are source occurrences, not calls per tick.

## Current reset design

Current static counts:

| Pattern | Count | Difference from start |
| --- | ---: | ---: |
| root `*.js` modules | 56 | +4 |
| `Game.creeps` | 69 | -14 |
| `Game.rooms` | 68 | -11 |
| `Game.spawns` | 33 | -6 |
| `.find(` | 70 | -19 |
| `PathFinder.search` | 5 | 0 |
| `JSON.stringify` | 0 | 0 |
| direct `main.js` require bindings | 9 | -21 |

The four added first-party modules are `Tick.Cache.js`, `CPU.Profiler.js`, `Combat.Threat.js`, and `Defense.Demand.js`. Use `git diff --stat 5c88a00..HEAD` as the authoritative file-level comparison.

### Global evaluation

`main.js` directly loads:

1. `Logic.Tower`
2. `spawn.manager`
3. `spawn.request.manager`
4. `traffic_manager`
5. `utility.Travel.Creep`
6. `Season.Score`
7. `CPU.Status`
8. `Tick.Cache`
9. `CPU.Profiler`

The static first-party graph contains no circular imports. The traffic and Traveler prototype setup remains a deliberate one-time global side effect. Planner, visual, expansion, WarRoom, remote planner, and role loading is controlled by getters; WarRoom loads on the first tick only when explicitly enabled, and a role loads only when a living creep has that role.

### Reset tick (tick +0)

Expected essential work:

- small idempotent settings checks;
- shared tick index;
- route-cache cleanup metadata;
- CPU strategy and Score TTL/claim maintenance;
- explicitly enabled WarRoom;
- tower defense;
- emergency-only spawn demand and all-idle-spawn consumption;
- living creep actions with on-demand role loading;
- traffic resolution only in visible rooms containing owned creeps;
- CPU finalization and optional profiler flush.

Deferred until tick +1:

- remote, structure, and road planners;
- expansion;
- repair-list scans;
- dead-creep Memory cleanup;
- source-map flags;
- pixel generation;
- visible-room Score discovery;
- structure planner visuals and dashboard.

### Tick +1 and steady state

All normal systems resume. Expensive periodic work remains governed by existing CPU mode, intervals, stable room offsets, cached demand, feature toggles, or TTLs. Deferral is one tick, so planner correctness and Score discovery are not permanently suppressed.

## Automated reset evidence

The test runner executes `main.loop()` at a fresh global with empty `Memory`, no rooms, no spawns, and no creeps. It verifies:

- no exception;
- the reset tick is recorded;
- optional planner/visual modules remain unloaded;
- CPU finalization completes.

It also verifies that an owned room without a spawn is skipped with an explicit reason and no exception. The complete suite result is `29 passed, 0 failed`; all 56 root modules pass `node --check`.

This does not validate a populated-world reset, real CPU cost, Screeps module-loader timing, or private-server engine compatibility.

## Profiling controls

Profiling defaults off:

```javascript
Memory.settings.enableCpuProfiling
```

Preferred console controls:

```javascript
require('CPU.Profiler').enable()
require('CPU.Profiler').report()
require('CPU.Profiler').disable()
require('CPU.Profiler').reset()
```

When disabled, profiler boundaries do not call `Game.cpu.getUsed`. When enabled, samples accumulate in heap and flush every 10 ticks into a maximum 60-record `Memory.cpuProfile.history`.

Named sections currently include:

- `globalModuleLoad`
- `routeCacheCleanup`
- `cpuStatus`
- `seasonScore`
- `warRoom`
- `remotePlanner`
- `plannerBrain`
- `plannerRoads`
- `towerDefense`
- `spawnPlanning`
- `creepRoles`
- `trafficManager`
- `structurePlannerVisuals`
- `dashboard`

## Live measurement protocol

Use the same server snapshot and colony state for before/after comparisons. Record three or more resets because a single tick is sensitive to shard timing, construction changes, hostiles, and path cache state.

1. Record server build, shard, code revision, owned rooms, visible rooms, creep count, active remotes, spawn queue size, CPU limit, and starting bucket.
2. Run 50 warm ticks with the profiler enabled and no code upload. This is the steady-state control.
3. Record profiler report and bucket delta.
4. Upload/reload the audited code without clearing `Memory`.
5. Record reset tick CPU, tick +1, ticks +2 through +10, and bucket delta through tick +50.
6. Inspect `require('main').getStartupState()` on tick +0 and +1.
7. Repeat with an empty/no-creep recovery snapshot and a hostile-room snapshot.
8. Report median and worst values. Preserve profiler output and console errors verbatim.

### Environment record

| Field | Value |
| --- | --- |
| Server/build | Not measured |
| Shard | Not measured |
| Audited code revision | Fill after final local commit |
| Owned / visible rooms | Not measured |
| Creeps / active remotes | Not measured |
| CPU limit / initial bucket | Not measured |
| WarRoom enabled | Not measured |
| Dashboard / planner visuals | Not measured |
| Source-map flags | Not measured |

### Reset samples

| Run | Reset CPU | Tick +1 CPU | Worst +2..+10 | Bucket at 0 | Bucket at +50 | Errors / missed intents |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | — | — | — | — | — | Not measured |
| 2 | — | — | — | — | — | Not measured |
| 3 | — | — | — | — | — | Not measured |
| Median | — | — | — | — | — | Not measured |

### Steady-state subsystem samples

| Section | Mean CPU | Max CPU | Calls / sampled ticks | Notes |
| --- | ---: | ---: | ---: | --- |
| spawn planning | — | — | — | Not measured |
| creep roles | — | — | — | Not measured |
| traffic | — | — | — | Not measured |
| towers / defense | — | — | — | Not measured |
| planners | — | — | — | Not measured |
| Score | — | — | — | Not measured |
| visuals | — | — | — | Not measured |

## Pass criteria

- No exception or missed tower/spawn/creep intent on reset tick.
- Optional planner/visual modules absent on tick +0 unless explicitly enabled/needed.
- Foreman/local Extractor/Freighter recovery remains available when no creeps exist.
- No mature-room planning attempt for an owned room without a spawn.
- Reset CPU is lower than the starting revision under the same snapshot, or the profiler identifies a defensible state-dependent reason.
- Bucket does not show a sustained post-reset decline attributable to the new tick cache/profiler.
- Steady-state CPU is not materially worse; target improvement should be visible in spawn planning, dashboard reads, travel scans, and empty-room traffic.
- Memory size does not grow without bound; profiler history and TTL caches remain bounded.

## Inspection commands

```javascript
require('main').getStartupState()
require('Tick.Cache').getDebugStats()
require('CPU.Profiler').report()
require('spawn.request.manager').getSpawnGovernorDebug('W1N1')
Memory.cpuStatus
Memory.cpuProfile
```

Replace `W1N1` with a representative spawn room. The full combat, Score, recovery, and long-run checklist is in `PERFORMANCE_DEFENSE_AUDIT.md`.
