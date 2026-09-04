# Sushi HiveMind operator runbook

This document describes the Season 11 HiveMind and combat architecture as it
exists in this repository. The code is intentionally additive: legacy economy,
remote mining, spawn, road, and role behavior still run through compatibility
adapters, while shared state lives under `Memory.hive`.

## Tick order

`main.loop` is a thin conductor. The fixed order is:

1. start heap-first CPU telemetry;
2. bootstrap settings, migrate Memory, begin the demand board, clean travel
   caches, classify CPU pressure, build the shared tick index, and optionally
   generate a pixel;
3. refresh combat incidents and the threat ledger;
4. run strategic planning: remotes, rooms, roads, HiveMind operations, Season
   11 operations, and approved combat operations;
5. plan squads and resources, adapt legacy spawn requests, merge the shared
   demand board, and run each affected spawn room;
6. run towers, safe-mode policy, links, labs, observers, terminals, and repair
   indexes for owned rooms;
7. execute squad controllers, then independent creep roles not claimed by a
   squad;
8. resolve all registered movement intents through the traffic manager;
9. clean dead creep Memory and draw scheduled visuals;
10. finish telemetry and occasionally persist rolling summaries.

Code that chooses a destination runs before traffic resolution. This is a
contract: action policy must not independently perform final movement.

## HiveMind architecture

The main layers are:

- `HiveMind.Index`: one heap-only snapshot per tick for creeps, owned and
  visible rooms, spawns, structures, hostiles, construction sites, spawn
  requests, operations, squads, and movement-related groupings.
- `HiveMind.Scheduler`: staggered cadence, dirty-task wakeup, and critical CPU
  shedding. Emergency work can explicitly bypass shedding.
- `HiveMind.Telemetry`: heap measurements for every tick and a compact rolling
  Memory sample at a configurable interval.
- `HiveMind.Memory`: additive schema defaults and migration.
- `HiveMind.ColonyState`: lifecycle and danger overlays independent of economy health.
- `HiveMind.MemoryGC`: staggered bounded retention for known Sushi-owned records.
- `HiveMind.Operations`: durable lifecycle records and adapters for existing
  systems.
- `HiveMind.Utility`: a shared, inspectable scoring model.
- `Spawn.DemandBoard`: deduplicated capability/role demand merged into the
  established room spawn queues.
- `Combat.Policy`, `Combat.ThreatLedger`, and `Combat.Math`: diplomacy,
  actionable threat classification, and boosted combat arithmetic.
- `Squad.Controller` and `Squad.Quad`: coordinated duo and quad state machines.
- `Resource.Manager`: mineral, link, terminal, lab, boost, observer, and courier
  coordination.
- `Season11.Adapter` and `Season11.Operations`: guarded seasonal API access and
  operation lifecycle integration.

Heap caches are disposable and rebuild after a global reset. Durable Memory
contains only JSON-safe ids, names, coordinates, counters, settings, and state.
Live `Room`, `Creep`, `Structure`, `RoomPosition`, `Map`, `Set`, and cost-matrix
objects must never be stored in Memory.

## Operation schema

Generic operations live at `Memory.hive.operations[id]` and contain:

```js
{
  id, type, state, priority,
  originRoom, respondingColony, targetRoom, targetPosition, targetId,
  createdTick, updatedTick, stateStartTick,
  utility: { total, components },
  desiredCapabilities, spawnDemands,
  assignedCreeps, assignedSquads,
  timeoutTick, abortConditions, completionConditions,
  debugReason
}
```

Generic states are `PENDING`, `DISCOVERING`, `SELECTING`, `ACTIVE`,
`RECOVERING`, `COMPLETE`, and `ABORTED`. State changes use
`HiveMind.Operations.transition`; terminal records are cleaned after 1,000
ticks. Season 11 records add guarded seasonal states and `seasonMetrics`.
Offensive records add an explicit directive, objective, retreat destination,
preferred quad, and an `offensiveAssessment` with viability evidence.

Supported generic types include owned/remote defense, recovery, expansion,
remote mining, scouting, fortification, boost production, explicit player
attack or raid, and Thorium/Reactor work. Offense is never inferred merely from
a harmless neighboring player.

## Utility scoring

`HiveMind.Utility.score` normalizes every component to 0–100 and calculates:

```text
urgency + expectedValue + strategicValue
- energyCost - spawnCost - travelTime - risk - opportunityCost
```

The result stores both `total` and all normalized components, so a decision is
auditable. Generic operations rescore on a staggered 17-tick cadence. Season 11
also rescales finite supply, route length, estimated loaded-cargo aging,
maintenance, current Reactor continuity, score rate, threat, and starvation.
Combat operations include target value, travel, boost mineral cost, opposing
tower damage, creep damage, healing, repair, barriers, and retreat viability.

The Thorium aging calculation is an explicit planning estimate for live
calibration, not a claim that the exact aging formula is exposed by the season
API.

The score now controls execution. Eligible operations are ordered by utility,
priority, and stable id. `PENDING` work must pass origin, economy,
offense-policy, utility, empire-budget, and per-colony budget checks before it
can become `ACTIVE`. Defaults allow three simultaneous non-emergency operations
empire-wide and two per colony. Each operation records `strategyDecision`,
`strategyReason`, and `strategyTick`. Owned-room emergency defense wakes
immediately; waiting, denied, completed, and aborted work emits no runtime
demands.

## Colony lifecycle

Lifecycle is separate from economy and danger:

| Phase | Meaning |
| --- | --- |
| `OWNED_NO_SPAWN` | Owned controller without an owned Spawn |
| `BOOTSTRAP` | Spawn exists, mandatory role floors are incomplete, or the room is still RCL1 |
| `GROWTH` | RCL2-RCL3 colony building essential structures and controller progress |
| `DEVELOPMENT` | RCL4-RCL7 colony adding storage, links, and sustainable infrastructure |
| `MATURE` | RCL8 core economy and infrastructure operating |

`PEACE`, `THREATENED`, and `SIEGE` are alert overlays. The lifecycle decision
also records an objective, enabled priority band, baseline-Tech requirement,
growth gate, first blocking reason, controller downgrade time, and protected
spawn-stockpile total. The startup ladder is Foreman, two functioning local
Extractors, one local Freighter, one minimum-growth Tech, then an Artificer only
for real construction or critical repair demand. A zero-miner room whose 200
energy Extractor floor is not recoverable uses the emergency Extractor first.

## Spawn demand flow

Producers call `Spawn.DemandBoard.emit` with a stable id, operation/squad id,
role or capabilities, count, priority, deadline, origin, target, replacement
buffer, TTL, and plain creep Memory. Re-emitting the same id merges count,
priority, deadline, and validity rather than duplicating requests.

At spawn-planning time the board:

1. expires stale or terminal-operation demands;
2. counts healthy living creeps, currently spawning creeps, and queued work;
3. ignores creeps that cannot survive their replacement lead;
4. selects a survival-ready owned spawn room with enough capacity;
5. submits only the missing count through `Spawn.Arbiter`;
6. removes stale queue items.

Existing expansion, defense, Season 11, squad, mineral, and courier producers
all converge here. Legacy producers use the same compatibility admission path.
The final order is normalize and assign a stable request id, deduplicate,
validate operation/expiration, apply economy and lifecycle policy, enforce role,
room, queue, per-tick and combat-share caps, queue, then revalidate immediately
before `spawnCreep`. Blocked or unaffordable heads are skipped so an affordable
survival request can run. Requests store producer, category, request/refresh
ticks, and expiration. Source-specific Extractor assignments remain part of
their stable identity and Memory.

Owned-room squad and quad defenders carry `defenseRequest`, `defendedRoom`, and
`emergencyDefense` classification. Remote defense and offense remain combat
spending. Normal combat defaults to at most half of queue capacity, and defense
admission preserves the local Extractor/Freighter survival anchor. A siege may
bypass ordinary queue admission limits but cannot create a zero-income colony.

The priority-band guide is deliberately compact: band 0 is survival and
owned-room defense; band 1 is mining, local logistics, spawn filling, and
essential replacement; band 2 is baseline controller growth and critical RCL
infrastructure; band 3 is construction, remotes, surplus upgrading, and
economic development; band 4 is expansion, offense, optimization, and optional
strategy. New systems should select a band before inventing another standalone
priority policy.

## Growth release order

Remote energy follows a separate maintenance-versus-expansion policy. Healthy
RECOVERY rooms may bootstrap their first projected-profitable source and keep an
established source operating; adding another source uses `remoteExpansion` and
waits for existing miner, container, delivery, and transport evidence. SURVIVAL
suspends remote work when core mining is endangered but preserves the portfolio
for restart. This avoids the former failure path where the ramp asked for generic
`remote`, RECOVERY denied it despite allowing remote income, and the first remote
could never produce the evidence required to unlock itself.

Remote routes are canonical per HOME/source. Extractors and outbound Freighters
follow the packed lane forward, returning Freighters follow it in reverse, and
the same coordinates feed road planning. Dispatch projects container energy at
arrival and subtracts inbound reservations; CARRY demand is based on production
times round-trip travel rather than only accumulated backlog.

Remote discovery defaults to a two-room radius through `config.remote`. Route
segments preserve exact multi-room order. Validation runs on a staggered interval
or dirty signal and checks schema, endpoint, known transit policy, and permanent
visible blockers; creeps are deliberately ignored. Invalid routes retain their
source portfolio but stop receiving new assignments until a visible, CPU-budgeted
planning pass rebuilds them.

Static ETA uses Screeps fatigue: empty CARRY contributes no outbound weight,
loaded CARRY contributes return weight, MOVE removes two fatigue per tick, and
road/plain/swamp tiles cost 1/2/10 fatigue per weighted part. Completed trips feed
an EWMA for outbound, return, round-trip, and deviation. Dispatch blends observed
and modeled ETA and derives its safety lead from length, swamp exposure, sample
confidence, deviation, and inbound Freighters.

Construction release is milestone-first. Essential containers, Spawns,
extensions, towers, storage, links, and other unlocked core infrastructure are
considered before bulk roads; roads remain planned and are released before
low-priority ramparts. Lifecycle reasons expose missing harvest WORK, CARRY,
spawn fill, extensions, tower/storage, and downgrade danger.

## Memory retention

`HiveMind.MemoryGC` runs through the scheduler with a bounded work budget.
Defaults retain terminal squads for 250 ticks, terminal operations for 1,000,
inactive non-manual players for 50,000, stale intel for 20,000, expansion
candidates/routes for 10,000, and inactive known resource/debug records for
5,000 ticks; demands and queues use their explicit TTL. HOME, owned bootstrap,
active remote, operation and expansion targets, current Season assignments,
manual diplomacy, and unknown user fields are protected. Old INTEL records are
compacted by deleting known Sushi subtrees rather than deleting the whole room.

## Diplomacy and threat policy

Players are classified as `ally`, `neutral`, `hostile`, or `npc` in
`Memory.hive.players`. `Invader` and `Source Keeper` are NPCs. Manual
classifications are authoritative. Non-manual hostility comes from incident
scores that decay using the configured half-life and cross the configured
threshold.

Allies are excluded from defense and offense. Neutral creeps are actionable
when they attack us or have harmful attack/claim capability; harmless neutral
scouts are not an offensive pretext. An offensive operation requires an
explicit manual directive, except a Reactor recapture that the operator has
explicitly enabled. Safe mode causes offensive operations to wait, while an
ally target, missing directive, impossible healing/repair matchup,
unsurvivable tower field, or missing retreat route aborts the operation.

The threat ledger stores bounded plain summaries, not live hostile objects. It
records active combat parts, effective hits, boosted damage/healing,
dismantling and claim pressure, attack incidents, distance to critical assets,
tower support, and a responding colony. Owned and remote threats can create or
refresh stable defense operations.

Towers select targets using predicted post-TOUGH damage, hostile healing,
killability, threat importance, and time-to-kill. They can prioritize a
friendly creep predicted to die, preserve an energy reserve, and use dynamic
RCL/economy/threat fortification targets. Safe mode activates automatically
only if enabled, manual confirmation is disabled, a critical breach is
immediate, and local towers/defenders/reinforcements cannot contain it.

## Duo and quad squads

Ranged duos contain one `Volley` and one `Cleric`. They use the shared states
`FORMING`, `RALLYING`, `BOOSTING`, `MARCHING`, `ENGAGING`, `RETREATING`,
`RECOVERING`, `COMPLETE`, and `ABORTED`. They focus targets, predict incoming
damage and healing, choose ranged versus mass attack, kite melee, prefer
friendly ramparts, maintain healer contact, and retreat before projected loss.

`RANGED_QUAD` contains two Volley and two Cleric slots. `SIEGE_QUAD` contains
two Ronin and two Cleric slots. Quad membership has stable slot identities and
leader replacement. Cross-room transport uses snake/follow movement and safe
pulling; combat uses compact 2x2 formations. The controller can rotate or
mirror formation transforms, regroup at borders, recover after a casualty,
replace members only when the deadline permits, share one target, and retreat
as a group.

Quad footprint matrices combine a signature-cached static terrain/structure
layer with tick-local threat and tower pressure. Squad movement uses high
traffic priority and fallback positions, but still goes through Sushi's travel
wrapper and final traffic resolver.

## Movement ownership

Roles, managers, duos, and quads request movement only through
`utility.Travel.Creep`. The wrapper enforces one request per creep per tick,
reuses routes, attaches priorities and squad context, and registers fallback
positions. `traffic_manager` owns the final `creep.move` calls after every
actor has planned.

Hostile creeps and power creeps are blockers. Cost matrices block walls,
private hostile ramparts, obstacle structures, and incompatible construction
sites while preferring roads. Matrices rebuild only when the structural
signature changes and only rooms with intents are resolved. The movement audit
allowlists only the traffic engine, travel facade, legacy Traveler facade, and
the retained one-tile Extractor seat displacement.

Do not disable the traffic manager as a routine CPU control. Since final
movement belongs to it, `Memory.config.general.useTrafficManager = false` can stop
registered movement intents from resolving.

## Minerals, labs, and boosts

Mineral planning observes extractor availability, finite deposits, storage,
and assigned miners. `MineralMiner` is separate from the energy Extractor.
`ResourceCourier` consumes heap-only logistics jobs for mineral staging, lab
inputs, contamination cleanup, product unloading, energy, and boosts.

Links classify and transfer locally. Terminals execute only validated internal
empire transfers; market integration defaults off and is not implemented.
Labs use explicit loading, reacting, unloading, cleaning, boost preparation,
boosting, idle, and error states. Squad boost requests contain per-slot
compound/part requirements, support partial boosts only when explicitly
accepted, and can trigger an internal terminal transfer or reaction goal.
Observers build bounded scouting queues and avoid repeating fresh intel.

Normal resource cadence is: mineral plan every 11 ticks, courier demand every
10 ticks per room, mineral observation every 10 ticks when stable, inactive lab
checks every 5 ticks, active labs every tick, terminal work every 10 ticks, and
links every owned-room tick. Room offsets stagger the periodic work.

## Season 11 adapter

`Season11.Adapter` is the sole narrow wrapper for seasonal constants and object
methods. It feature-detects `RESOURCE_THORIUM`, `FIND_REACTORS`, and
`claimReactor`; without them, normal shards load safely and the seasonal
pipeline remains inert. The implementation harvests Thorium as a regular
mineral through an active extractor, claims only while adjacent with a CLAIM
creep, delivers only to a live Reactor reporting `my === true`, and stores only
plain snapshots.

Season mode, schema, ranking, mining/hauling, Reactor continuity, recapture,
dashboard fields, and live calibration checks are detailed in `SEASON11.md`.
The implementation intentionally has no market, portal, or legacy ScoreRunner
path.

## CPU budget review

Local mock tests validate capacity/pressure behavior at 20 and 100 CPU, but
they cannot establish exact live-world CPU. Use rolling telemetry and live
bucket behavior for that decision.

CPU modes use both stable capacity and current pressure:

| Mode | Entry condition |
| --- | --- |
| `critical` | bucket below 1,000 or current use at least 95% of limit |
| `low` | bucket below 4,000 or current use at least 80% of limit |
| `high` | limit at least 30, bucket at least 7,000, and use at most 65% |
| `normal` | otherwise |

Hysteresis holds critical until bucket reaches 1,800 and use falls below 85%,
low until bucket reaches 5,000 and use falls below 70%, and high while limit is
at least 27, bucket at least 6,000, and use at most 75%. At 20 CPU the bot never
enters high mode. At 100 CPU, high mode is available only with healthy bucket
and headroom. Critical mode sheds non-emergency scheduled work; combat
intelligence and explicitly emergency defense remain current.

The main protections are shared one-tick indexing; staggered room, remote,
road, resource, lab, terminal, visual, and utility work; dirty-task wakeups;
structural-signature matrices; heap route/squad/resource caches; bounded
operation candidates and event histories; and sparse telemetry persistence.
Season 11 now consumes the shared index for its empire-wide scans.

Remaining legacy scan concentration is mainly in expansion planning, the
WarRoom compatibility layer, remote/road/room planners, spawn governance,
`utility.Creep`, several legacy logistics roles, and dashboard assembly. These
are deliberately scheduled, room-scoped where possible, or compatibility
paths, but should be the first live profiles inspected as the empire grows.

For a 100-CPU account, investigate when rolling total remains above roughly 70
CPU, any phase consumes more than 25 CPU for several persisted samples, bucket
stays below 5,000 for 500 ticks, or critical mode repeats without combat. These
are operational thresholds, not claimed benchmark results. Disable optional
work in this order: structure-planner visuals, remote/dashboard visuals,
Season 11 operation mode if unused, observers/inactive labs/minerals, automatic
quads, then broader strategy. Do not disable traffic or immediate defense as a
first response.

Heap-only caches include `global.__sushiTickIndex`, scheduler decisions,
telemetry, traffic intents, offensive route results, quad matrices, resource
jobs, and Season operation timing. Durable Memory includes operations, squads,
players, threats, demands, resource state, Season assignments/intel/routes,
settings, bounded events, and rolling CPU summaries.

## Debugging

Run the local release gate from this directory with the bundled Node runtime or
an installed compatible Node:

```powershell
npm run validate
```

The gate checks all production syntax, all module loads, a mocked `main.loop`,
20/100 CPU policy, index reuse, migrations, demand deduplication, utility and
operation transitions, diplomacy, boost math, tower and safe-mode choices,
traffic, duo and quad behavior, resources, the Season adapter, the absence of
ScoreRunner behavior, public APIs, dependency reachability/cycles, movement
ownership, and legacy Season tests.

Useful live views:

```js
require('HiveMind.Telemetry').getView()
Memory.hive.telemetry && Memory.hive.telemetry.cpu
require('HiveMind.Scheduler').getState()
require('Combat.ThreatLedger').getRoomThreat('W1N1')
Memory.rooms.W1N1 && Memory.rooms.W1N1.defenseSummary
Memory.hive.operations
Memory.hive.demands
Memory.hive.resources
```

Enable per-tick CPU logging only briefly:

```js
Memory.config.cpu.telemetry = { persistInterval: 100, debug: true }
Memory.config.cpu.telemetry.debug = false
```

## Memory migrations

`HiveMind.Memory.migrate()` runs before normal bootstrap work. Current schema is
version 8 under `Memory.meta`. The explicit 7-to-8 migration consolidates
configuration, CPU state, room spawn/cache/economy state, and Season 11 state;
it preserves unknown/operator fields and gives an existing schema-8 value
precedence over its stale legacy counterpart. After a deploy, inspect:

```js
Memory.meta
Memory.config
JSON.stringify(Memory.hive).length
JSON.stringify(Memory.rooms || {}).length
```

Do not place live game objects into either root. If an emergency reset is ever
needed, copy the affected branch in the console first and reset the narrowest
subtree; do not erase all Memory as a migration technique.

After bootstrap, schema access is cached in heap against the current Memory and
canonical branch identities, and safely rebuilds after a global reset.
DemandBoard persistent hydration runs once per game tick. Tick finalization
persists the representative final CPU status rather than only the bootstrap
sample. `MemorySchema.map()` includes approximate size plus room, operation,
squad, demand, threat, expansion-candidate, and stale-record counts.

## Deployment

1. Start from a saved copy or Git commit of the currently running code and
   Memory settings.
2. Run `npm run validate` and `git diff --check` locally.
3. Review the diff for credentials, shard-specific hardcoding, unintended
   market/portal behavior, and direct movement calls.
4. Deploy to a non-critical shard/branch first when available. This repository
   does not perform a remote push as part of validation.
5. For the first 100 ticks, keep Season 11 in `observe`, safe-mode manual
   confirmation on, automatic recapture off, and CPU debug logging off.
6. Check CPU mode/bucket, spawn queues, demand deduplication, movement, threat
   summaries, resource lab states, and the dashboard.
7. Enable Season `auto` or `active` only after the live seasonal API, Thorium
   deposits, routes, and Reactor ownership fields are observed.
8. Enable any offensive or recapture directive manually and inspect its
   assessment before squads leave the rally room.

## Emergency switches

These assignments are reversible and preserve state for diagnosis:

```js
// Stop broad strategy and new operation planning.
Memory.config.combat.strategy.enabled = false

// Stop all coordinated squad planning/execution.
Memory.config.combat.squads.enabled = false

// Keep duos but stop quads or only automatic defensive quads.
Memory.config.combat.squads.quadsEnabled = false
Memory.config.combat.squads.autoDefenseQuads = false

// Stop new independent Ronin/Volley/Cleric defense demands; squads remain.
Memory.config.combat.independentCombat = false

// Stop all resource automation, or one subsystem.
Memory.config.resources.enabled = false
Memory.config.resources.labs = false
Memory.config.resources.terminals = false
Memory.config.resources.observers = false
Memory.config.resources.minerals = false

// Stop seasonal work while retaining intel and operation history.
require('Logic.Season11').setMode('disabled')

// Stop optional visuals.
Memory.config.visuals.showDashboard = false
Memory.config.visuals.showRemoteRoomDashboard = false
Memory.config.visuals.showStructurePlanner = false

// Pixels are already off by default.
Memory.config.pixels.enabled = false

// Preserve manual approval for safe mode.
Memory.config.combat.safeMode.manualConfirmation = true
```

Restore the same fields to `true` as conditions recover. `useWarRoom` controls
the legacy emergency-defense compatibility pass. `useTrafficManager` is not a
normal emergency switch because turning it off can halt movement resolution.

## Room economy recovery

`HiveMind.Economy` samples each owned spawn room before strategy and spawn
planning. The authoritative snapshot is available at:

```js
require('HiveMind.Economy').get('W1N1')
Memory.rooms.W1N1.economy
```

The heap snapshot reports spawn fill, reserves and trend; per-source expected income,
active/required/queued WORK, distance and backlog; distance-derived hauling
demand, local/remote/queued CARRY; replacement risk; remote commitments; state;
and the human-readable reason for that state. Only hysteresis, trend inputs,
state, and reason persist in `Memory.rooms[room].economy`; live detail is rebuilt
from `Game` and `HiveMind.Index` after a global reset.

The states are:

- `SURVIVAL`: no functional local miner, or critically empty spawn energy plus
  less than 500 reserve energy and less than 45% of expected local income.
- `RECOVERY`: local WORK below 90%, estimated income below 65%, local hauling
  below 85%, a material source backlog, low spawn fill without healthy spawn
  pressure, or an uncovered critical replacement with low reserves.
- `STABLE`: local harvesting and hauling are sustainable.
- `SURPLUS`: stable core economy, at least 100,000 reserve energy, at least 90%
  spawn fill, and no meaningful negative energy trend.

Emergency states are entered immediately. Improvement must persist for 12 ticks
to leave `SURVIVAL`, 40 ticks to leave `RECOVERY`, and 100 ticks to promote from
`STABLE` to `SURPLUS`. Each promotion advances only one state at a time.

During `SURVIVAL`, the spawn queue normally starts with Foreman, two local
Extractors, and minimum hauling. The full-collapse exception prioritizes an
affordable local Extractor before the no-WORK Foreman. A local Extractor temporarily carries energy
to spawn/extensions when no local hauling exists. Optional requests remain in
the queue but the spawn consumer skips them until policy permits them. During
`RECOVERY`, remotes, expansion, surplus upgrading, noncritical construction,
resources, special operations, and combat preparation stay suppressed.
Owned-room defense, controller safety, critical maintenance, and exactly one
baseline `controllerGrowth` Tech remain available after the Foreman/two-miner/
one-Freighter core floor exists. Additional Tech uses `upgradeSurplus` and stays
blocked. RCL1 targets one Tech WORK rather than two, producing the affordable
`WORK/CARRY/MOVE` body. The floor request may exceed the non-combat RCL cap by
one slot only and is deduplicated through the normal request fingerprint.

The protected spawn-side overflow pile remains owned by worker consumers, not
Freighters. Its energy is summed from the shared room index scan. A full spawn
plus overflow supports the baseline-growth explanation and telemetry, but the
pile is not required for growth and does not bypass a missing core floor.

Remote plans are retained rather than destroyed. Active selection and new
remote assignments pause during recovery; empty outbound Freighters return
home, while loaded Freighters finish delivering their cargo.

The room dashboard shows economy state/reason, lifecycle objective, active or
blocked growth reason, non-combat governor use (including the one floor slot),
Tech WORK, protected stockpile energy, and controller downgrade ticks.

## Console cookbook

Initialize defaults before editing a nested branch:

```js
require('HiveMind.Memory').ensure()
```

Enable or disable strategy and independent combat-role spawning:

```js
Memory.config.combat.strategy.enabled = true
Memory.config.combat.strategy.enabled = false
Memory.config.combat.independentCombat = true
Memory.config.combat.independentCombat = false
```

Set Season mode and pixel policy:

```js
require('Logic.Season11').setMode('observe')
require('Logic.Season11').setMode('auto')
require('Logic.Season11').setMode('active')
require('Logic.Season11').setMode('disabled')
Memory.config.pixels.enabled = true
Memory.config.pixels.enabled = false
```

Classify players. Clearing a manual classification returns the player to
incident-based policy:

```js
require('Combat.Policy').setClassification('FriendlyName', 'ally')
require('Combat.Policy').setClassification('EnemyName', 'hostile')
require('Combat.Policy').setClassification('UnknownName', 'neutral')
require('Combat.Policy').clearManualClassification('UnknownName')
```

Create a manual defense operation:

```js
require('HiveMind.Operations').create('DEFEND_OWNED_ROOM', {
  id: 'manual:defend:W1N1',
  originRoom: 'W1N1',
  targetRoom: 'W1N1',
  priority: 95,
  desiredCapabilities: { damage: 300, ranged: 200, healing: 120 },
  debugReason: 'Operator defense directive'
})
```

Create an explicit ranged or siege offense. An ally classification still
blocks creation, and the viability assessment can abort an impossible mission:

```js
require('Combat.Operations').createManual('ATTACK_PLAYER', {
  id: 'manual:attack:W2N2',
  originRoom: 'W1N1',
  targetRoom: 'W2N2',
  retreatRoom: 'W1N1',
  targetOwner: 'EnemyName',
  objective: 'TOWER_SIEGE',
  squadType: 'RANGED_QUAD',
  targetValue: 80,
  priority: 90
})

require('Combat.Operations').createManual('RAID_REMOTE', {
  originRoom: 'W1N1', targetRoom: 'W3N3', retreatRoom: 'W1N1',
  targetOwner: 'EnemyName', objective: 'DISMANTLE_BREACH',
  squadType: 'SIEGE_QUAD'
})
```

Abort an operation or squad:

```js
require('HiveMind.Operations').abort('manual:attack:W2N2', 'Operator abort')
require('Squad.Controller').abort('quad:manual:attack:W2N2', 'Operator abort')
```

Inspect an operation, squad, Reactor pipeline, and seasonal dashboard:

```js
Memory.hive.operations['manual:attack:W2N2']
require('Squad.Controller').get('quad:manual:attack:W2N2')
require('Logic.Season11').getDiagnostics()
require('Season11.Operations').getDashboard()
Memory.hive.operations['season11:reactor:reactorObjectId']
```

Inspect CPU telemetry and change visual cadence:

```js
require('HiveMind.Telemetry').getView()
Memory.hive.telemetry && Memory.hive.telemetry.cpu
Memory.config.visuals.visualInterval = 10
Memory.config.visuals.showDashboard = true
Memory.config.visuals.showRemoteRoomDashboard = false
Memory.config.visuals.showStructurePlanner = false
```

## RCL growth economy

`HiveMind.Economy` computes the authoritative RCL1-7 growth policy from observed
local and active-remote income, current economic creep replacement depreciation,
an infrastructure allowance, spawn pressure, hauling health, threat state, and a
dynamic replacement reserve. `spawn.request.manager` converts the resulting
`growth.controllerBudget` into Tech WORK demand; storage tiers are not a second
controller-demand algorithm.

Remote mining ramps one profitable source at a time. A further source requires
the existing source to have miner coverage, a container or container plan,
recent hauling evidence, adequate CARRY, and available spawn capacity. Active
remote miners and source containers use the `remoteIncome` and
`remoteBootstrap` spending categories, so moderate RECOVERY can preserve income.
Optional remote roads remain `remote` spending and require a built container,
working hauling, reservation, stable economy, and a funded growth budget.

Inspect the live policy with:

```js
require('HiveMind.Economy').get('W1N1').growth
require('HiveMind.Telemetry').getView().growth.W1N1
Memory.rooms.W1N1.remotePlanner.rampReason
```

Configure Reactor selection/recapture and boost production:

```js
require('Logic.Season11').selectReactor('reactorObjectId')
require('Logic.Season11').configure({ recapture: true, startupReserve: 800 })
require('Resource.Labs').configureReaction('W1N1', 'XKHO2', 3000)
Memory.hive.resources.labs.W1N1
Memory.hive.resources.boosts
```
