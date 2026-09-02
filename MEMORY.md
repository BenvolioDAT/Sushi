# Sushi Memory Architecture

> **Every Sushi-specific top-level Memory key must represent a major domain.
> New subsystems must use the existing schema rather than creating new root keys.**

This document records the schema audit performed before the version 8 migration
and the target architecture used by current code.

## Pre-v8 audit: original tree

```text
Memory
├── creeps                         Screeps conventional creep state
├── rooms                          persistent room records and mixed debug/live data
│   └── <roomName>
│       ├── roomName, lastScanned, controller, sources, Mineral
│       ├── spawnQueue, spawnDemandCache, spawnGovernor
│       ├── extractor*, freighter*, artificer*, tech* debug counters
│       ├── structurePlanner, roadPlanner, remotePlanner
│       ├── routeCache, economyDistanceCache, avoid
│       ├── defenseSummary, RepairStructure, ArtificerRepair*
│       ├── scoutIntel, lastScanTick
│       └── freighterSpawnStockpilePos, expansionSpawnGovernor
├── hive
│   ├── schemaVersion
│   ├── settings                   mixed empire configuration
│   ├── operations, squads, players, threats, demands, counters
│   ├── resources, season
│   └── economy.rooms              complete live economy snapshots
├── settings                       mixed UI, CPU, pixel, upgrade and behavior config
├── cpuPolicy                      CPU/spawn-planning policy
├── cpuStatus                      persisted current/debug CPU sample
├── spawnPolicy                    spawn governor policy
├── season11                       Season 11 config plus persistent operation/intel state
├── expansion                      persistent expansion operation state
├── WarRoom                        legacy active-threat state
├── stats                          periodically persisted CPU telemetry history
├── username                       cached player identity
├── firstSpawnRoom                 legacy home-room hint
└── empire                         legacy Traveler hostile-room migration input only
```

### Audit classification

- **Configuration:** `settings`, `cpuPolicy`, `spawnPolicy`, `hive.settings`,
  and `season11.config`/mode.
- **Empire/Hive state:** operations, squads, players, threats, demands, counters,
  resources, expansion state, WarRoom threat state, player identity, Season 11
  assignments/reactors/alerts/stats.
- **Room state:** source/controller/mineral knowledge, planner state, remote
  relationships, spawn queues, repair coordination and room intel.
- **Creep state:** `Memory.creeps` and `Creep.memory`; these remain conventional.
- **CPU status/history:** `cpuStatus` and `stats.cpu`.
- **Caches:** room route cache and economy path-distance cache; planner route
  data is owned by its planner.
- **Intel:** scout intel, source/controller/mineral records, remote planner intel,
  threats and Season 11 unseen-room intel.
- **Ephemeral data that should not be persistent:** complete economy snapshots,
  current WORK/CARRY, spawn fill, current structure energy, backlog, link state,
  spawn pressure, and several room demand/debug counters.
- **Legacy/unknown:** `firstSpawnRoom`; `empire.hostileRooms` is an already
  documented one-way compatibility input. Unknown custom fields must survive
  migration even when Sushi does not interpret them.

## Target/final tree

```text
Memory
├── meta
│   ├── schemaVersion
│   ├── migratedAt
│   └── lastMigration
├── config
│   ├── general
│   ├── cpu
│   ├── spawn
│   ├── economy
│   ├── lifecycle
│   ├── memoryGC
│   ├── upgrade
│   ├── combat
│   ├── resources
│   ├── season11
│   ├── visuals
│   └── pixels
├── hive
│   ├── homeRooms                  inspector mirror synchronized from TickIndex
│   ├── operations, squads, players, threats, demands, counters
│   ├── resources, season, expansion, warRoom
│   ├── telemetry
│   ├── gc                         last bounded collector report
│   └── identity
├── cpu
│   └── status                     small persisted mode/debug history
├── rooms
│   └── <roomName>
│       ├── identity
│       ├── economy                hysteresis/trend state and protected-stockpile total
│       ├── colony                 lifecycle, objective, growth decision and alert summary
│       ├── spawn
│       │   ├── queue
│       │   ├── demandCache
│       │   └── governor
│       ├── sources, controller, Mineral
│       ├── structurePlanner, roadPlanner, remotePlanner
│       ├── scoutIntel and existing room-scoped defense/logistics records
│       └── cache
│           └── economyDistances     versioned source/dropoff distances
└── creeps                         Screeps conventional root
```

Screeps conventional roots such as `spawns`, `flags`, and `powerCreeps` remain
valid when the engine or user code needs them.

## Runtime truth versus persistence

`Game` and the once-per-tick `HiveMind.Index` are authoritative for what is true
now: ownership, spawns, creeps, structures, energy, body parts and hostiles.
Memory stores configuration, relationships, history, hysteresis, unseen-room
intel, operations and caches whose recomputation is materially expensive.

The current economy snapshot lives in heap for the current tick. Room Memory
keeps state-machine hysteresis, reason, last liquid-energy sample, the
energy-trend EMA needed after a global reset, and the small protected spawn-side
stockpile total used by lifecycle telemetry.

The widely used `structurePlanner`, `roadPlanner`, `remotePlanner`, source,
defense, repair, and scout-intel shapes intentionally remain room-scoped in
their existing locations. Moving them would touch many stable readers without
removing transient data or preventing top-level drift. New room data should use
an existing room domain; this decision is not permission to add new root keys.

## Lifecycle and queue records

`Memory.rooms[roomName].colony` stores the lifecycle (`OWNED_NO_SPAWN`,
`BOOTSTRAP`, `GROWTH`, `DEVELOPMENT`, or `MATURE`), `lifecycleSince`, objective,
priority band, independent `PEACE`/`THREATENED`/`SIEGE` alert, growth gate and
blocked reason, baseline Tech floor/work, next mandatory role, compact core
floor counts, controller downgrade ticks, protected-stockpile total, and small
milestone summary. The compatibility aliases `state`/`phase` mirror `lifecycle`;
`stateSince`, `updatedTick`, and `debugReason` change only on lifecycle transitions,
while `milestoneSince` and `milestoneTimedOut` bound stalled-objective diagnostics.
Fields are assigned only when their values change; current
objects and scans still rebuild through `HiveMind.Index`.

Spawn queue entries carry a stable `requestId`, `producer`, `category`,
`requestedAt`, `refreshTick`, and `expiresAt`. Demand records retain their
stable id and TTL. Both legacy and DemandBoard producers therefore reconcile
through one final queue owner.

A baseline Tech queue entry uses `economyCategory: controllerGrowth` and
`memory.controllerGrowthFloor: true`; controller-loss protection remains
`memory.controllerEmergency: true` with category `controllerSafety`. Optional
Tech uses `upgradeSurplus`. `spawn.governor` reports `nonCombatTotal`, the normal
RCL cap, and whether the bounded `mandatoryFloorBypassUsed` allowance was used.

## Retention and garbage collection

`Memory.config.memoryGC` owns cadence, work budget, and retention periods. The
collector removes expired demands/queues, old terminal squads/operations,
decayed inactive non-manual players, irrelevant expansion routes/candidates,
stale known intel subtrees, and inactive known resource/debug records. It does
not automatically remove HOME or owned-bootstrap records, active remotes,
active operation or expansion targets, current Season assignments, manual
diplomacy, or unknown fields. Stale INTEL records are compacted rather than
deleted wholesale.

## Room identity

- **HOME:** visible owned controller and at least one owned Spawn.
- **OWNED_BOOTSTRAP:** visible owned controller without an owned Spawn.
- **REMOTE:** assigned by remote planning to a parent Home Room.
- **INTEL:** a persistent room record without a stronger current relationship.

`Memory.hive.homeRooms` is a human-readable mirror. `TickIndex.ownedSpawnRooms`
remains authoritative and the mirror is synchronized from it each tick.

## Schema migration

`HiveMind.Memory.migrate()` runs at the start of `Tick.Bootstrap`, before normal
systems. The explicit `migrate7To8()` step creates the new value before deleting
a legacy value, preserves already-valid new-schema values, and is safe to rerun
after a global reset. The version marker is written only after the step returns
successfully. A malformed room record is isolated rather than replacing
unrelated Memory.

## Configuration and CPU

All Sushi configuration is canonical under `Memory.config`; use
`HiveMind.Memory.getConfig(domain)`. Persistent CPU mode/debug history is under
`Memory.cpu.status`. Current detailed CPU pressure remains heap-first.

## Console Memory map

The read-only map is manually requested with:

```js
MemorySchema.map()
```

It does not pathfind or write Memory.

The map also reports approximate serialized size and counts for rooms,
operations, squads, demands, threats, expansion candidates, and stale records.

## Adding fields

Prefer an existing domain and use the schema accessors for top-level data.
Direct `Creep.memory` and straightforward room-domain access are acceptable.
Do not persist a copy of a `Game` object or create a new Sushi root for a single
subsystem.
