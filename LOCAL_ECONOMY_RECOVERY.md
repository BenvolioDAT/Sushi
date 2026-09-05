# Local economy recovery audit

## Evidence and root-cause boundary

The original `Spawn.Policy.js` was loaded from `git show HEAD:Spawn.Policy.js`
and evaluated against a deterministic RCL5 mock. The inputs were 1300 available
energy, 25 living non-combat creeps (including six remote Extractors), two queued
local Extractors, no active local mining, and an Extractor role cap of six.

The original policy returned:

```json
{
  "admitted": {"allowed": true, "reason": "admitted"},
  "revalidated": {"allowed": false, "reason": "role cap reached"},
  "economy": {"allowed": true, "reason": "core economy"}
}
```

This is a proven code defect. `runStartupBootstrap` / emergency planning passes
`{emergency:true,bypassRoleCap:true}` into `addSpawnRequest` and `Spawn.Arbiter.admit`.
`normalize` does not preserve those options. Later `Spawn.Arbiter.revalidate`
passes only `{revalidate:true}`. The original `survivalBypass` therefore becomes
false. Existing remote Extractors consume the same Extractor role cap as local
ones. With six existing remote miners and two queued local miners, each queued
candidate sees seven other Extractors after subtracting itself, exceeding six.
The consumer skips the candidate, retains it, never reaches name generation or
`spawnCreep`, and returns a blocker that `Tick.Planning` discarded. The dashboard
only compared queue body cost with energy and displayed ready.

The patched evaluator, with the same inputs, returned `allowed:true`,
`reason:"mandatory local economy recovery"`, `localMissingWork:5`; the consumer
then called `spawnCreep` with a 700-energy, five-WORK body and received OK.
The synthetic requested body cost was 600; the existing affordable-body selector
chooses the standard 700-energy five-WORK plan before spawning.

**This reproduction is not proof of the historical W5N8 blocker.** The supplied
live Memory excerpt was from tick 278219, after recovery: STABLE, DEVELOPMENT,
six queued requests, and governorNonCombat 23. Its queue, governor, and source
objects were collapsed. The exact earlier role counts, caps, requests, names,
and API results were not supplied. The attempted console reply contained a
damaged expression rather than its evaluated output. Historical attribution
remains open; it must not be presented as a confirmed live diagnosis.

## Existing rules audited before the patch

`Tick.Planning.runStrategy` runs Economy, then ColonyState, then strategy and
planning. Request generation runs legacy local demand and the DemandBoard before
`runSpawning`. `HiveMind.Index` supplies home-room creeps and owned spawns.

| Quantity | Original rule |
| --- | --- |
| Local detection | role Extractor; matching/absent homeRoom, sourceRoom, targetRoom; remoteMining is not true |
| Source identity | sourceId, targetSourceId, or assignedSource in creep memory |
| Required WORK | ceil((energyCapacity or 3000) / ENERGY_REGEN_TIME / HARVEST_POWER), minimum one |
| Normal source | 3000 / 300 = 10 energy/tick; 10 / 2 = 5 WORK |
| Active WORK | Undamaged WORK of non-spawning assigned miners, plus unassigned local miners; previously uncapped by source |
| Stationed WORK | Active assigned miners in the source room within range one |
| Expected income | Sum of source capacity / regeneration |
| Estimated income | Sum of min(source income, stationed WORK * HARVEST_POWER); position-based estimate, not measured harvest events |
| Queued WORK | Local queued body WORK; previously included unassigned/expired requests |
| Spawning WORK | Body WORK of local Game.creeps entries with spawning true; previously no Memory-only spawn fallback |
| Replacement lead | Body length * 3 + max(15, source distance) + 10 |
| Replacement coverage | Healthy/dying WORK and incoming arrival estimates; queued spawn time and source distance included |
| Source demand | Source-specific assignment, WORK, seats, container and dying-miner handoff checks; one local source request per invocation |
| Body | Existing body plans, source missing-WORK bound, strongest available-energy affordable plan at consumption |

State rules, in order (thresholds and hysteresis retained):

1. SURVIVAL if there is no active or incoming mining capacity; distinguish an
   unreachable minimum bootstrap body. Also SURVIVAL for zero income with
   spawnFill < .15 and reserves < 500, or incomeRatio < .45 under those conditions.
2. RECOVERY if active / required WORK < .90 or estimated / expected income < .65.
3. RECOVERY if local / required CARRY < .85, backlog > max(500, activeCarry * 75),
   or link backpressure > 500.
4. RECOVERY if spawnFill < .45 and reserves < 2000, except a busy spawn with
   incomeRatio >= .90 and haulRatio >= .85; also if replacement risk and reserves < 5000.
5. SURPLUS with reserves >= 100000, spawnFill >= .90 and energyTrend >= -1;
   otherwise STABLE once the preceding checks pass.
6. Deterioration is immediate. Improvement proceeds one rank at a time after
   12 qualifying ticks leaving SURVIVAL, 40 leaving RECOVERY, 100 leaving STABLE.

Original ColonyState combined healthy living, spawning and queued role counts.
Its functionalMining check accepted positive active **or incoming** WORK, and
its core floor used two planned Extractors rather than sustainable WORK.
Growth allowed all RCL1-7 rooms with that planned floor and a state other than
SURVIVAL (subject to siege/CPU gates). Every BOOTSTRAP objective said REACH_RCL2.

## Spawn-path findings

| Candidate blocker | Audit result |
| --- | --- |
| Room cap | RCL5 remains 30. Noncombat excludes Ronin/Volley/Cleric and includes living, spawning and queued units. The original economy-role allowance above this cap remains intact. |
| Role cap | Shared across local/remote Extractors; dynamically sized from local sources and active operational remote source needs, minimum configured cap, one handoff, hard limit. Proven revalidation blocker in reproduction. |
| Own queue count | Original policy already subtracts this request during revalidation; not an uncorrected self-count bug. |
| Queue / per-tick cap | Admission-only; cannot directly stop an already-admitted request during revalidation. |
| Emergency options | Original admission-only options lost during revalidation; fixed for current bounded local recovery demand. |
| Economy / lifecycle | Harvest is core economy and protected during BOOTSTRAP. They do not reject a valid categorized local miner merely because the state is RECOVERY. |
| Fingerprint | Producer, home room, demand/role, source, target, squad/operation; stable duplicate detection. No historical queue supplied to verify actual keys. |
| Expiration | Normally 50 ticks; migrated legacy work 25 ticks. Consumer/planner prune expired requests. Local pending requests now refresh while their source demand is visited. |
| Stale source | Previously no source-demand check at consumption. Now invalid source and already-covered source requests are rejected as obsolete and removed. Earlier reservations count; the candidate itself and later duplicates do not. |
| Affordability | Existing preview iterates candidates and can skip an unaffordable higher-priority request. Five WORK is affordable at 1300. Current local source deficit also bounds final WORK. |
| Name generation | Searches role_001 through role_100, checking Game.creeps and Memory.creeps. Exhaustion is another independently reproduced blocker; unchanged, now exposed as ERROR at stage name. No historical name data establishes it occurred in W5N8. |
| API errors | Energy/busy/name errors retain request; other errors remove selected request. Numeric result, stage, candidate and reason now persist. No historical API result supplied. |
| Malformed request | Consumer removes malformed body/role memory before policy selection; exceptions record their current stage before propagating. |

## Corrected semantics and manual trace

Economy remains authoritative. `localHarvestCoverage` returns activeWork,
spawningWork, queuedWork, requiredWork, activeRatio, incomingWork, status.
HEALTHY requires the existing .90 WORK/.65 income thresholds, also checked per
source in both rawState and the coverage summary so Economy and Colony agree.
RECOVERING means sufficient capacity is assigned/incoming but current
production is not healthy. MISSING means some source still lacks coverage.
Active useful WORK is capped at each source's requirement; unassigned WORK is
reported separately. Incoming WORK never supplies estimated income.

ColonyState uses active Foreman/local Freighter counts and Economy harvest
health for coreFloor.complete. Planned Tech WORK remains useful for avoiding
duplicate Tech requests, not for declaring mining healthy. An RCL2+ collapse
uses BOOTSTRAP / RESTORE_CORE_ECONOMY within the existing lifecycle.

For the two-source failure: Economy.run measures 0/10 WORK and 0/20 income;
no incoming work gives SURVIVAL under the existing rules, funded queued recovery
gives raw RECOVERY. ColonyState.run marks the floor incomplete and growth paused.
Local demand visits each source, computes missing WORK, and queues targeted
Extractor work. Policy derives current missing capacity from indexed healthy
miners, spawning miners (including Memory-only spawn handoff), and earlier
queue reservations. Local recovery can cross cap/queue/new-request limits only
while that deficit exists. Revalidation recomputes the same condition and does
not need remembered privileges. The consumer bounds body WORK to the remaining
source deficit, selects the affordable plan, generates a name, calls the API,
and saves its result.

One queued miner for each source changes harvest MISSING -> RECOVERING, not
HEALTHY. After the first starts: 0 active, 5 spawning, 5 queued. After it reaches
its source: 5 active and 10 estimated income. After both work: 10 active and 20
income; existing Economy hysteresis controls recovery toward STABLE/SURPLUS.
Core health permits baseline growth again. Controller safety is always a
separate spend category; even a baseline-growth Tech may upgrade in downgrade danger.

## Diagnostics and HUD

One overwritten `Memory.rooms.W5N8.spawn.lastDecision`, for example:

```json
{
  "tick": 100,
  "spawnName": "Spawn1",
  "idle": true,
  "queueLength": 2,
  "energyAvailable": 1300,
  "stage": "spawnCreep",
  "selectedRole": "Extractor",
  "selectedRequestId": "legacy:W5N8:Extractor:sourceA:W5N8::",
  "priority": 120,
  "bodyCost": 700,
  "work": 5,
  "arbiterAllowed": true,
  "arbiterReason": "mandatory local economy recovery",
  "economyAllowed": true,
  "economyReason": "core economy",
  "result": 0,
  "reason": "spawn started",
  "queueRemaining": 1,
  "status": "BUSY"
}
```

`idle` describes the spawn at selection time. A blocked decision also stores
one compact `{role,reason}` object. No historical arrays are retained. The HUD
reads these fields; it does not re-evaluate policy. Missing current-tick
diagnostics display UNCHECKED rather than a misleading ready label.

```text
ECO RECOVERY - harvesting below sust...
Income 0/20 W 0/10
Incoming W 0s +10q | RECOVERING
Haul 24/10 backlog 0
COLONY BOOTSTRAP - RESTORE_CORE_ECONOMY
Growth PAUSED - local harvest recover...
Spawn BLOCK
Next Extractor 700e
Extractor: role cap reached
```

That BLOCK example illustrates a reported policy failure; the patched mandatory
local shortage bypasses this cap. Successful attempts display STARTED/BUSY;
API failures display ERROR plus the return code. Economy/Colony snapshots are
taken before request generation, so newly queued/spawned work is reflected in
the following tick's Economy snapshot; the spawn decision itself is current.

Read-only live evidence commands (copy from a code block):

```js
JSON.stringify(Memory.rooms.W5N8.spawn)
```

```js
JSON.stringify(Memory.rooms.W5N8.spawn.lastDecision)
```

## Files changed by this pass

- HiveMind.Economy.js: per-source useful/current/incoming capacity, memory-only
  spawning fallback, shared coverage and current recovery eligibility, growth spend gate.
- HiveMind.ColonyState.js: active core floor, Economy-derived harvest status, contextual objective.
- Spawn.Context.js: classify spawning Game.creeps entries as spawning, without changing total counts.
- Spawn.Policy.js: demand-bounded local recovery revalidation/cap exception and obsolete-source decisions.
- Spawn.Arbiter.js: optional compact prune reason for the consumer diagnostic.
- spawn.request.manager.js: local pending-request refresh, WORK-based startup
  recovery gate, skip fully covered Memory-only spawning source handoffs.
- spawn.manager.js: current-deficit body bound, scalar spawning parts, malformed/stale
  request removal, persistent decision on every return path and exceptions.
- Tick.Planning.js: retain room spawn results in the current planning report.
- Visual.Dashboard.js: incoming/health row, spawn decision/error/unchecked labels and reason.
- role.Tech.js: downgrade safety overrides the normal-growth pause.
- test/local-economy-recovery.js: focused scenarios and end-to-end mock checks.
- test/controller-growth.js, test/lifecycle-spawn-gc.js, test/artificer-controller.js:
  supply required WORK/expected income in previously incomplete healthy-economy fixtures.
- package.json: include the new regression suite in test and validate.
- LOCAL_ECONOMY_RECOVERY.md: audit, evidence limits, manual trace and operator examples.

Existing working-tree edits to Planner.Remote.js, role.Extractor.js, utility.js,
utility.Creep.js, remote tests, and the existing remote portions of
spawn.request.manager.js/package.json were preserved. This pass does not alter
remote routing, remote assignment strategy, combat, Season 11, roads or expansion.

## Validation and risks

`npm run validate` passed, including existing economy/controller/lifecycle,
remote, module-graph, movement and Season 11 checks. The focused local recovery
suite also covers A-E transitions, RCL5 demand generation at 25 noncombat,
cap overflow recovery, source duplication/invalid assignment, body resizing,
memory-only spawning, expiration/malformed/energy/name/API diagnostics, hauling
cap scope and baseline Tech downgrade safety. The original-policy reproduction
above separately demonstrated loss of admission privileges. After final review
edits, focused economy/recovery/controller/lifecycle tests, remote integration
and reliability, graph/movement audits and the baseline syntax/load/main smoke
checks were rerun successfully as applicable; the final recovery suite has 11 tests.

Normal numeric caps and spawn throughput (one accepted request per runRoom)
are unchanged. Mandatory local recovery can temporarily exceed ordinary limits,
with reservations consuming the deficit; ordinary behavior returns when covered.
Controller surplus spending pauses during real local mining failure; moderate
logistics RECOVERY with healthy harvest still permits existing baseline growth.
Remote policy is preserved, though truthful local health can invoke existing
remote-spending suppression sooner. No new Game.creeps scans or pathfinding;
recovery checks use the existing room index and queue, with cost bounded by
room workforce and queue size. Persistent additions are one small decision,
one harvest summary and scalar spawn part counts, not histories.

Mocks prove code behavior, not historical or live-world correctness. Position-
based income remains an estimate. HUD text is covered by code review/smoke
validation; no live screenshot was available. Live CPU and the historical W5N8
blocker remain unmeasured/unconfirmed pending the actual expanded spawn data.
