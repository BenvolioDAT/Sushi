# Population capacity and body scaling

## Preflight and scope

The starting branch was clean `main`, commit `0183985` (`Create SEASON11-HARDENING.md`).
`git show --stat HEAD` confirmed that commit changed only the report. The reported
JavaScript hardening was absent locally, not merely uncommitted. This pass restores
structure-aware Reactor defense, the 150 default startup minimum, numeric guards,
claimant gating, diagnostics, and focused tests. It retains the multi-Reactor
portfolio, reservations, backoff, continuity, and `maxActiveReactors = 1`.

All spawn requests still pass through Spawn.Policy / Spawn.Arbiter, the existing
queue, and spawn.manager. The capacity policy does not kill or recycle excess
creeps, create combat missions, or bypass local recovery admission.

## Audit of the previous model

- Spawn policy used RCL caps 10/16/20/26/30/36/40/46 for RCL1–8. Dynamic Extractor
  and Freighter exceptions raised their role limits according to source WORK and
  CARRY shortages. Local recovery could bypass ordinary caps; keep those guarantees.
- Configured role caps included Foreman 1, Scout 1, Annex 4, Tech 3, Artificer 3,
  Extractor/Freighter 6, Ronin/Volley 4 and Cleric 3. Annex could grow to six for
  active reservation rooms; economic hard guards bounded miner/hauler exceptions.
- Tech demand was in WORK, with an absolute five-creep guard, a 36-WORK target
  ceiling and 15 normal RCL8 WORK. Artificer demand already separated actual local,
  critical, and remote work. Its strongest enabled body had only six WORK.
- Tech's strongest static body had 12W/6C/9M. Freighter/Foreman bodies reached
  25C/25M. Extractor tables included 6–7 WORK and omitted exact three-WORK sizing.
- Economy already estimated income, protected reserves, replacement energy costs,
  construction budgets and controller growth. ColonyState protected local floors
  and downgrade safety. Manual upgradeRush and early CPU mode could bias growth,
  but surplus was still bounded by the older demand/count/body ceilings.
- Spawn.Context tracked living/spawning/queued counts, and replacement leads used
  body spawn time plus role buffers. Queue length 8 and two new requests per room
  per tick remain default guardrails. Spawn planning already had a CPU budget and
  staggered full/light passes; Scheduler retained emergency paths.
- Telemetry measured all phases including creepExecution, traffic and visuals,
  but persisted an EMA sampled only on the persistence cadence. Population policy
  did not consume a rolling expectation of every full tick.

This could leave energy and available CPU unused at an RCL/count boundary, or
admit optional work based on early-tick CPU before creep execution and traffic.

## Capacity calculations

`HiveMind.Capacity` refreshes empire/room snapshots every five ticks. Admission
rechecks current CPU pressure, queue costs and spawn capacity on every request.
Existing creep spawn maintenance is cached per room per tick; the queue stays live.

CPU targets are configurable under `Memory.hive.config.capacity`:

| Bucket | Planned fraction of CPU limit |
| --- | --- |
| below 1800 | 55% |
| below 5000 | 65% |
| healthy | 78% |
| at least 9500 | 83% |

Fractions are bounded to 50–90%. Headroom is `target - max(rolling full-tick CPU,
current used CPU)`, floored at zero. Each owned room receives an equal bounded
share of empire headroom, so no room believes it owns all global CPU. Survival
and permitted emergencies are protected independently. Unknown CPU history uses
a conservative 65%-of-limit estimate and is marked unsampled.

Telemetry now updates the full-tick EMA every tick in heap (alpha 0.1), persisting
at the existing default 100-tick interval. All phase costs remain visible. Rolling
usage above 83% also defers optional scheduler work without suppressing emergencies.

Every 25 ticks, Tick.Creeps samples role execution. Independent roles are timed
only on sample ticks; aggregate squad cost is divided among controlled members.
Role CPU and useful-activity EMAs are small current values. Admission estimates
role CPU plus a share of measured traffic cost. Missing role samples use 0.2 CPU
with a 0.05 minimum. Samples are approximate, especially shared squad execution.

Spawn maintenance uses `bodyParts * 3 / expectedUsefulLifetime`, summed across
living and spawning creeps. Ordinary lifetime is 1500; CLAIM uses 600. Known
Season aging shortens lifetime, and travel reduces useful lifetime where recorded.
Unrepresented active spawns use their recorded needTime. Queued bodies add future
maintenance plus a near-term burst reservation over 300 ticks. Valid outstanding
DemandBoard commitments reserve maintenance too, including expansion, combat and
Season work, without counting already assigned/queued demand again.

Optional headroom is `spawnCount * 0.75 - maintenance - queuedLoad - burstLoad -
unfulfilledCommitmentLoad`. The remaining 25% protects emergency response.
For example, a normal 50-part creep requires 150 spawn ticks and 0.10 maintenance
load; eight such creeps require 0.80. One spawn refuses more optional load, while
two spawns have 1.50 safe throughput. A 50-part hauler with aging multiplier five
requires 0.50 maintenance load, not 0.10.

Room energy comes from cached Economy stored energy, reserve, gross/net income,
and trend. Optional admission includes already queued energy costs. Unknown
Economy samples retain baseline compatibility without inventing rich surplus;
actual zero or negative measurements are binding. The existing protected one-MOVE
economic Scout floor remains subject to CPU/spawn limits and Scout.Economy checks.

The advisory extra-slot count is the minimum of room CPU share / 0.2, spawn
headroom / 0.05, net income / 0.5, and energy above reserve / 1000. Actual admission
uses the requested role/body costs, so the slot heuristic cannot authorize a
50-part creep merely because a nominal slot exists. Healthy soft capacity can
exceed the RCL baseline. Pressure reduces it toward the mandatory population.
No creep is killed when it falls.

The hard ceiling is `min(absoluteMaximum, 20 + 4*RCL + 20*spawnCount + floor(CPU/5))`,
with a minimum ten and default absolute maximum 150. For RCL5/one spawn/100 CPU
that is 80, versus the old primary cap 30. It is a runaway guard, not a target.
Tech retains its five-creep absolute guard; capability requests can use up to five
Techs or eight Artificers when capacity permits. Other role/source guardrails remain.

Classes are MANDATORY, ECONOMIC, INFRASTRUCTURE, GROWTH, STRATEGIC and MILITARY.
Mandatory includes local recovery shortages, Foreman, controller safety/floor,
permitted critical maintenance/infrastructure and owned emergency defense. Remote
income/logistics are economic; ordinary builders are infrastructure; Tech surplus
is growth; Season/expansion are strategic. Critical owned Reactor CLAIM defense
keeps its existing policy eligibility even when optional CPU is exhausted.

CPU-neutral Tech replacement is a narrow additional path. Every five ticks under
CPU pressure it considers known useful Tech demand and units expiring within 150
ticks. A request can claim each retiring unit only once; replacement WORK cannot
exceed their WORK, spawn time must meet their remaining lifetime, and energy,
spawn-load and hard-cap checks still apply. Critical CPU and buckets below 1800
disable this exception. This replaces capability without increasing ongoing creep
CPU; it does not authorize extra growth or remove living creeps.

## Surplus investment

Healthy rich rooms with CPU and spawn headroom allocate up to 85% of sustainable
net income plus bounded stock draw (`min(30, energyAboveReserve/10000)`) to useful
work. The deterministic score combines benefit, urgency and income minus energy,
CPU, spawn and risk costs. Zero-demand work is not a candidate.

Actual hauling deficits and critical infrastructure lead; Reactor continuity and
Season preparation receive commitments; controller upgrading is the default sink
below RCL8; discovered ordinary infrastructure and existing expansion support remain
eligible. Allocations give existing requests a small priority bias of at most five,
preserving mandatory priorities. Remote portfolio discovery/activation and combat
mission creation remain with their existing planners. The allocator does not
invent a remote, Scout mission or builder job to spend energy.

The funded controller allocation raises desired Tech WORK automatically, up to 60
below RCL8. RCL8 stays at 15 normal upgrade WORK. Actual production, incoming WORK,
CPU pressure, energy trend and spawn admission continue to constrain spending.
The budget is a heuristic; this is not an exact global economic optimizer.

## Body generation and examples

`BodyProfiles` builds at most 50 bounded candidates, respecting energy and the
50-part rule. Profiles cover worker, controller-fed, conservative mobility, proven
roads, cargo, CLAIM and combat composition. Emergency workers use an immediately
useful affordable minimum. Replacement bodies respect a spawn deadline. Threat-
scaled independent defense can request larger combat bodies; ordinary squad
capability flags and explicit squad bodies retain their existing meaning.

| Role | Previous maximum/example | New useful example |
| --- | --- | --- |
| Tech | 12W/6C/9M, 27p, 1950e | controller-fed 18W/5C/12M, 35p, 2650e; self-supplied 18W/6C/24M, 48p, 3300e |
| Artificer | 6W/6C/12M, 24p, 1500e | proven roads: 20W/10C/15M, 45p, 3250e; general mobility can provide 16W/8C/24M at 48p |
| Freighter | 25C/25M, 1250 cargo | proven roads: 33C/17M, 1650 cargo; unknown routes retain 25C/25M |
| Extractor | table could choose 6–7 WORK; no exact 3W plan | exact missing 1/2/3/4/5 WORK, one CARRY, adequate movement; default useful bound 5W |

Road efficiency requires observed terrain coverage (at least 90%, no swamps,
recently validated), not planned road sites. Generic mixed-route haulers and
Foremen remain conservative without proof; route-specific requests can use road
profiles. Scalable Artificer mobility is similarly conservative by default.

Thorium hauling already had bodies up to 50 parts. The profile builder and load
model account for known aging and reject a hauling profile unable to cover its
spawn delay and delivery cycle. Existing Season route feasibility/aging guards
remain authoritative. ThoriumMiner and normal MineralMiner defaults remain bounded
by their established extraction plans; no blanket WORK inflation was introduced.
Scouts remain one MOVE. Annex defaults to one CLAIM; additional CLAIM requires
mission capability. Ronin retains TOUGH in front and protected HEAL, Volley ranged
damage plus healing, and Cleric healing/mobility.

The actual spawn consumer reselects affordable generated bodies while preserving
capability limits, profiles and assignment identity. A controller emergency that
develops after queueing can shrink a large Tech immediately. Body diagnostics show
parts, cost, spawn time, WORK/CARRY/MOVE, expected lifetime, replacement load,
estimated capability per CPU/spawn tick and selection reason.

Tech diagnostics now separate active, spawning and queued WORK. Missing demand
subtracts incoming work once. Existing per-source Extractor/Freighter and categorized
Artificer accounting remain protected by their regression suites.

## Performance, Memory and HUD

A local Node benchmark with 200 creeps/four rooms and 500 forced rebuilds averaged
0.2381 ms per full capacity recomputation. Five thousand cached lookups averaged
0.0019 ms. This is local Node wall time, not measured Screeps CPU. Normal rebuilding
is every five ticks, using TickIndex and cached Economy; live admission reuses
maintenance and checks the small queue/commitment sets. Profiling 100 independent
creeps adds about 202 clock reads on one tick in 25 (about 8.08/t amortized), not
per-creep timing on every tick. Inspect telemetry's `capacity` phase in the game.

The four-room capacity snapshot serialized to 3093 bytes in that benchmark.
Current role/room EMAs and one body-choice diagnostic add bounded small records;
there are no history arrays. Room capacity is rebuilt from owned rooms, utilization
records for lost rooms are removed, and stale role records expire. Queue-only
replacement name lists disappear with their requests. Spawn capability metadata
contains three small counts per creep.

```js
Memory.hive.capacity = {
  tick: 12345, mode: 'SURPLUS',
  cpu: { limit: 100, rollingUsed: 29, targetCeiling: 83, headroom: 54, bucket: 10000, /* phases */ },
  spawn: { count: 2, replacementLoad: 0.68 },
  rooms: { W5N8: { mode: 'EXPAND', reason: 'CAPACITY_AVAILABLE', cpu: { share: 27 },
    spawn: { replacementLoad: 0.34, plannedLoad: 0, commitmentLoad: 0, headroom: 0.41 },
    population: { current: 31, softCap: 39, hardSafetyCap: 80 }, /* energy */ } }
};
// Memory.rooms.W5N8.spawn.governor.reason:
// CPU_CAPACITY_EXHAUSTED / SPAWN_LOAD_HIGH / ENERGY_BELOW_RESERVE /
// ROLE_UNDERUTILIZED / HARD_SAFETY_CAP / CPU_NEUTRAL_REPLACEMENT
// .nextBody = { role: 'Tech', WORK: 18, bodyParts: 35, cost: 2650, reason: ... }
```

Existing HUD space now shows rolling CPU capacity, replacement load, population
soft/hard bounds, role utilization, next body shape and Reactor structural defense.
Illustrative lines: `CAP SURPLUS | rolling CPU 29/83 of 100 | Spawn repl 34%`;
`Pop EXPAND 31/39 soft | 80 hard`; `Use F 82 T 98 A 44`; `Next Tech 18W 35p 2650e`;
`DEF 20 TOWER CLAIM 0 COMBAT 0`. Existing reserve/net-income rows remain available.

## Files and validation

| File | Change |
| --- | --- |
| HiveMind.Capacity.js | Empire/room policy, shared CPU, spawn/energy costs, commitments and admission diagnostics |
| HiveMind.Surplus.js | Deterministic investment allocation, automatic Tech budget, bounded request bias |
| BodyProfiles.js | Scalable capability-bounded bodies, lifetimes, metrics and proven-route selection |
| HiveMind.Memory.js | Capacity configuration defaults |
| HiveMind.Telemetry.js | Every-tick full CPU EMA and sampled role/room EMAs |
| HiveMind.Scheduler.js | Rolling CPU optional-planning suppression |
| Tick.Creeps.js | Sampled role/squad timing and activity |
| Tick.Planning.js | Timed capacity refresh after Economy/ColonyState |
| Spawn.Context.js | Separate active/spawning/queued capability |
| Spawn.Policy.js | Central capacity admission, dynamic WORK-role limits and emergency preservation |
| Spawn.Arbiter.js | Body normalization, safe replacement claims, body diagnostics and surplus bias |
| Spawn.DemandBoard.js | Explicit scalable body requirements; existing squad semantics preserved |
| spawn.request.manager.js | Funded surplus WORK, dynamic cap diagnostics, bounded Tech consolidation and threat-scaled independent defense |
| spawn.manager.js | Affordable generated body selection and spawn capability metadata |
| role.creepBodyConfig.js | Generated exact Extractors, larger demand-bounded workers and mission-sized Annex defaults |
| role.Tech.js | Heap-only useful-activity signal |
| Visual.Dashboard.js | Compact capacity/body/utilization and restored Reactor defense display |
| Logic.Season11.js | Restored defense observations, scoring/gating and reserve default |
| Season11.Portfolio.js | Restored compact structure assessment and safe dynamic reserve math |
| test.Season11.js | Restored hardening coverage and critical CLAIM-defense capacity regression |
| test/population-capacity.js | Capacity, commitments, fairness, idle pressure, queue accounting, surplus and real request-path regressions |
| test/body-scaling.js | Capability/affordability/50-part/property ranges, road proof, aging and urgency regressions |
| test/mock-screeps.js | Reset new rolling CPU heap state between worlds |
| package.json | New capacity/body commands included in test and validate |
| SEASON11-HARDENING.md | Clarify restoration status |
| POPULATION-CAPACITY.md | Audit, implementation report, examples and operating checks |

Run results: full `npm run validate` passed, including all previous suites, module
graph and movement audits. Season 11: 55 tests. Population capacity: 14 tests.
Body scaling: 8 grouped tests including energy/role/property ranges. Separate
`npm run test:season11` and `npm run test:capacity` were also run successfully.
All 23 changed/new JavaScript files passed `node --check`; `git diff --check`
passed with no whitespace errors.

## Risks and live inspection

- CPU/traffic estimates are sampled heuristics, not exact marginal cost. Full-tick
  EMA and immediate pressure gates remain the safety fallback; validate the live
  `capacity` phase before tuning targets upward.
- Giant bodies have long spawn delays and expensive replacement bursts. Deadlines,
  live queue budgeting and the 25% spawn reserve limit that risk. Unknown route
  mobility stays conservative; no Traveler/traffic behavior changed.
- Negative energy trend or reserve pressure stops optional admission. Existing
  creeps can still consume energy until they expire; bounded stock spending and
  Economy spending gates protect recovery, but the transition is not instantaneous.
- Soft capacity is advisory and can move with pressure. Hard bounds, stable requests,
  role guards and useful capability demand prevent count-target population filling.
- Utilization is approximate: collection/movement toward useful work counts as
  productive; idle builder controller fallback does not justify another builder.
  Eight samples and an EMA avoid reacting to one idle tick.
- Season 11 retains the cheap range-2 barrier approximation: it can overestimate an
  isolated near barrier or miss a distant enclosure. Empty towers may be refueled
  after observation. No live recapture or spawn execution was observed in this pass.
- Local economy and remote mining tests passed, including per-source recovery,
  bootstrap container behavior, multiple remote miners and local/remote hauling.
  Live unknowns include route aging, real CPU distributions and simultaneous losses.

After deployment, inspect these five values:

1. `Memory.hive.capacity.cpu` — rolling usage, ceiling, headroom and phases.
2. `Memory.hive.capacity.rooms.W5N8` — mode, spawn load, energy and soft/hard population.
3. `Memory.rooms.W5N8.spawn.governor` — exact refusal and next body metrics/reason.
4. `Memory.hive.telemetry.populationRooms.W5N8` — utilization and sample counts; compare with actual activity.
5. `Memory.rooms.W5N8.surplus` and the existing Tech active/spawning/queued WORK HUD values — verify useful investment without counting incoming WORK as production.
