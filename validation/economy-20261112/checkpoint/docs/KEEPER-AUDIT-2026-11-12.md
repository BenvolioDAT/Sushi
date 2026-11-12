# Source Keeper investigation — W6N4, November 12, 2026

**Historical release:** This report describes the initial 111-module intelligence/patrol prototype. Automatic staged commissioning, fixed-body spawning and level-zero core operations were subsequently deployed; see [NPC-AUTOMATION-2026-11-12.md](NPC-AUTOMATION-2026-11-12.md). Its room observations and installed-engine mechanics remain useful; the build identity and manual-only capability statements below describe that earlier release.

## Result

Reusable lair intelligence, conservative civilian safety checks, explicit ranged patrol behavior, and a cost/spawn-budget model are implemented and tested. The local game is executing build `106f60395238f963af345e7c17b61f9795ff8a93bd1e4cc6118b2f877f583538` (111 modules). All server modules matched local source; the desktop console independently returned this identity at tick **642978**.

**W6N4 mining remains disabled.** This is a safety and readiness improvement, not a commissioned Keeper economy. The existing planner still excludes Keeper rooms; this change does not override its risk gates, enable `allowKeeperRooms`, create patrol spawn requests, or launch operations. Full autonomous commissioning, replacement scheduling, and shared-patrol certification remain missing. Current RCL5 spawning capacity is 1,800, below the proposed unboosted guard's 5,000 energy cost. No Keeper was deliberately attacked, no enemy was injected, and no colony structures or Memory were manually removed.

## What the room actually contains

Desktop inspection and read-only server snapshots established these resources. The lair associations below were subsequently learned by the running AI from its own room vision, rather than injected from administrator-visible data.

| Resource | Position | Lair ID / position | Scanned mining seats |
| --- | --- | --- | ---: |
| Energy `cf560772f3a3b50` | 15,4 | `42af0772f3a2c10` / 15,7 | 1 |
| Energy `828b0772f3abaa1` | 32,11 | `64af0772f3ac285` / 27,12 | 1 |
| Energy `df3d0772f3ad46f` | 15,43 | `b54c0772f3ab469` / 14,47 | 5 |
| Mineral `f3d461653e33218` | 41,35 | `4e520772f3af775` / 46,34 | Not an energy-miner assignment |

Each energy source has 4,000 capacity and the installed regeneration period is 300 ticks: **40 energy/tick gross** across the three sources. Seven unboosted WORK per source can cover its approximately 13.33 energy/tick rate. The two single-seat sources need sufficiently strong individual miners, rather than a queue of tiny miners. An illustrative mobile stationary-miner body is seven WORK, one CARRY, four MOVE, costing 950; travel and evacuation must account for its fatigue. Three such miners need 21 WORK in total. This is a planning requirement, not an observed mining result.

No source container or mining fleet was established in W6N4. Existing canonical source-container ownership remains responsible for selecting one serviceable container/station per source. The top two sources' sole seats are also Keeper standing positions; clearing and access must precede construction/harvesting. Multiple haulers should serve one station through existing reservations, not create competing container plans. Roads, accessible station geometry and actual round trips must be measured before enabling the room.

## Mechanics checked against this server

The installed server is build 40.8.1 with engine 4.3.0-beta. The enabled tick-duration mod changes scheduling, not Keeper combat. Official [API documentation](https://docs.screeps.com/api/#StructureKeeperLair) and historical community strategies were reviewed, then implementation assumptions were checked against installed engine code.

`validation/audit-20261112/keeper-engine-check.cjs` executes the installed lair tick, Keeper pretick and creep-intent dispatcher inside an isolated VM. Its fake bulk operations modify only in-memory fixtures. Eight checks passed:

- A full-health living Keeper need not have a spawn countdown. Damage below 5,000 hits starts the 300-tick countdown; death is not the only trigger.
- An existing countdown does not restart on subsequent damage. Its expiry replaces a surviving old Keeper.
- The generated body is 17 TOUGH, 13 MOVE, 10 ATTACK and 10 RANGED_ATTACK: 5,000 hits, up to 300 melee plus 100 ranged damage per tick before part loss.
- The NPC selects the first source/mineral within five tiles when acquiring a resource, which need not be the nearest. Sushi conservatively associates every eligible resource where ranges overlap.
- The Keeper can issue melee and ranged attacks together. A player creep can self-heal and use ranged attack together; self-healing suppresses its melee attack in this engine's action-priority rules.

The relevant installed files are `engine/src/processor/intents/keeper-lairs/tick.js`, `creeps/keepers/pretick.js`, `creeps/intents.js`, and ordinary creep lifetime processing. The VM results are mechanics checks, not a complete simulated battle victory.

## Implementation and ownership

`Keeper.Intel` uses the existing per-tick room/structure/hostile/resource indexes. It observes each consumed room once per tick and stores plain bounded data at `Memory.rooms[room].keeperIntel`: schema version, observation tick, lair IDs/positions, candidate resource IDs, absolute spawn times or null, current Keeper IDs/positions/hits, and separate other-hostile/core flags. It stores no observation history. W6N4's full observed record was 1,663 serialized characters; its empty-Keeper countdown record was 1,173. Missing vision retains geography but cannot certify a safe window.

`windowFor` requires current player vision, a mapped resource, no active associated/nearby Keeper, no unknown countdown, and no other hostile/core. It reserves approach, work/loading, evacuation and a ten-tick margin. Evacuation estimates use canonical lane geometry, remaining fatigue, active MOVE power and conservative loaded swamp travel. Missing movement or route geometry fails closed. Expired timers cannot become a positive window.

`Planner.Remote.guardKeeperCivilian` runs before source-endpoint early returns and before stationary Extractor lifecycle work. It requires both a safe window and actual healthy protection. Closed windows or defender loss return civilians using existing retreat pathfinding; they preserve source/route knowledge. Partial Freighter loads become deliveries with their home/source evidence intact. Empty haulers release a closed assignment once home. Existing assignments can resume after fresh clear observations and restored protection; this does not independently admit a new Keeper operation.

Civilian routing receives remembered hazard costs. Escape paths use traversable high costs so a worker already inside a hazard is not trapped by its own blocked matrix. Scouts can step away from nearby hazards, and their existing Traveler routing applies lair/Keeper costs and refreshes paths inside known Keeper rooms. Traveler, traffic arbitration, exit safeguards and same-tick movement ownership remain in place. There are still 14 audited direct movement/pathfinding call sites and no module dependency cycles.

`Combat.Policy` and `Combat.ThreatLedger` distinguish Source Keepers from ordinary automatic NPC defense. They cannot create an ordinary defense demand for a Keeper, including from stale threat records. Dangerousness remains available to safety consumers. Invaders retain ordinary defense policy; cores/strongholds retain their dedicated avoidance restrictions.

`Keeper.Combat.run` is reached only by an existing Volley explicitly assigned `keeperPatrolRoom`. It never requests spawning. The capability screen requires actual surviving ranged damage >=100, self-healing >=120, plain movement capacity, >=95% health, >250 remaining ticks and no squad membership. Patrols self-heal, fire at range three, maintain stable targets, distribute claims among peers, camp upcoming energy lairs, and retreat on damage/overwhelming incoming fire, short lifetime, Invaders or a core. Old/missing destination intelligence causes a request for vision and a hold/return. Mineral lairs are excluded from ordinary energy patrol work unless `keeperIncludeMineral` is explicitly assigned. These decisions are tested; terrain-dependent battle wins remain unverified.

Until shared coverage is measured and certified, protection requires one actual healthy in-room guard per energy lair: **three for W6N4**, not four merely because a mineral lair exists. Desired bodies, spawning workers, absent defenders and dead guards do not supply coverage. One 100-DPS guard needs approximately 50 attack ticks per undamaged Keeper, before travel and recovery. Three enemies require approximately 150 attack ticks plus a real patrol circuit and timing margin. A shared guard might reduce cost, but current evidence cannot certify its circuit or safe simultaneous-spawn coverage. This implementation deliberately does not assume one guard can protect the entire room.

## Economic assessment

`Keeper.Combat.economics` is a diagnostic model, not an admission or spending authority. Inputs must include travel time, uptime and infrastructure cost. It charges guard and miner replacement, travel-shortened worker lifetime, loaded hauling CARRY and spawn occupancy. Missing capacity/spawn-budget inputs cannot approve feasibility. It distinguishes positive modeled net energy from actual spawn feasibility. No unmeasured boost supply or loot income is credited.

The following is a sensitivity example, **not a W6N4 route measurement**: three energy guards, 80% uptime, one energy/tick maintenance, 5,600 capacity, and half of one spawn available for this operation. The same supplied one-way travel estimate is applied conservatively across worker classes. Combat losses, CPU admission and additional hostile interruption costs would worsen the result.

| Assumed one-way travel | Required CARRY | Modeled net energy/tick | Spawn occupancy | Fits 50% spawn budget? |
| ---: | ---: | ---: | ---: | --- |
| 30 ticks | 41 | 16.07 | 48.6% | Model only |
| 50 ticks | 67 | 14.07 | 60.0% | No |
| 100 ticks | 131 | 8.89 | 89.6% | No |
| 150 ticks | 195 | 3.33 | 121.3% | No |

At the actual 1,800 capacity, all proposed unboosted-guard scenarios fail the body affordability gate. Even later, a positive net figure can still monopolize spawning and undermine the home economy. Measured routes, delivered-energy accounting, replacement overlap, available spawn capacity and a reliable shared patrol are the highest-value prerequisites. Automatic commissioning and loss/replacement budgeting remain future work.

## Live verification and tests

All **192 PASS checks** in `npm test` completed, including 24 Keeper/sign regressions, dependency/movement audits, and existing economy/spawn/remote/combat regressions. All 111 runtime modules also compiled with `vm.Script`. The eight installed-engine checks ran separately. The regression suite covers actual decisions: resource association, missing/expired timers, stale vision, early evacuation, partial delivery, resumption, defender death, target stability, kiting, retreat, body/cost/spawn constraints and NPC-defense separation.

| Observation | Tick | Direct evidence |
| --- | ---: | --- |
| Current baseline | 638902 | 109 matching modules; RCL5; existing economy in RECOVERY. |
| First captured new intelligence | 642894 | All 111 modules match; W6N4 observed at 642893; four full-health Keepers mapped to their lairs. |
| Desktop executed-build query | 642978 | Console returned build `106f6039…`, 111 modules. |
| Countdown phase | 643600 | Four lairs predict spawn at 643882; zero active Keepers; Scout full health. |
| Later active phase | 644164 | Four active Keepers again, null countdowns; fresh observation at 644163; full-health Scout now in W6N5. |

These observations cover 1,270 ticks after the first post-release snapshot and demonstrate live discovery and a natural Keeper respawn cycle. No Keeper combat victory or live civilian mining/hauling window is claimed. Old console room sprites persisted across some client updates; authoritative own-creep positions/health and room vision were checked against runtime data rather than inferring survival from sprites alone.

Live monitoring also exposed repeated Annex exceptions while reading a controller sign: the engine getter dereferenced a missing sign-author entry. A narrow fallback now retains bounded `annexSignReadErrorAt`/message evidence and continues the already-authorized ordinary reservation/signing sequence. No database repair or manual sign command was used. Its last aggregated role exception remained at tick **642475**, count **100370**, throughout post-release snapshots; a live Annex recorded the fallback at 642590 and later resumed `reserving`. Historical diagnostics were preserved.

CPU EMA totals were 29.53 before this release and approximately 28.76–32.25 in post-release snapshots, with a 100-CPU allowance and changing populations/workloads. This is not a matched CPU improvement benchmark. Total Memory varied from roughly 285k to 311k characters while the lair record remained bounded. No indefinite leak-free claim is justified.

## Combat readiness assessment

| Combat scenario | Current capability | Verification | Limitations |
| --- | --- | --- | --- |
| Ordinary NPC Invaders | Automatic defense implemented | Policy and tactical tests; no live battle win in this investigation | Assembled-force survival not comprehensively certified. |
| Invader Core | Detection/avoidance; automatic clearing unavailable | Avoidance/legacy-operation regressions; reservation seen live in earlier audit | No verified attack-based level-0 clearing operation. |
| Low-level Strongholds | Assault unavailable | Automated refusal/avoidance; installed mechanics inspected | Core attack, tower survival, force readiness and sustain missing. |
| Mid-level Strongholds | Assault unavailable | Same safety checks; no victory | Coordinated boosted damage/healing and rampart siege missing. |
| High-level Strongholds | Currently infeasible for the observed colony | No assault tested | Spawn/boost capacity, robust formations, focus healing and replacements missing. |
| Remote Room Defense | Ordinary NPC defense implemented; Keepers separated | Automated classification/retreat decisions | No live defensive combat victory claimed. |
| Coordinated Squad Combat | Duo/quad code implemented; partially evaluated | Isolated tactical tests | No complete coordinated battle/formation certification. |
| Retreat and Recovery | Combat and civilian retreat decisions implemented | Automated; live civilian observation stayed peaceful | Battle extraction and live Keeper-mining restart unverified. |
| Source Keepers | Explicit ranged patrol prototype; lair intelligence active | Intelligence/respawn cycle live; patrol decisions automated; engine mechanics isolated | No Keeper kill tested; no automatic guard assembly/replacement; mining remains excluded. |

## Remote operations assessment

| System | Findings | Improvements | Verification |
| --- | --- | --- | --- |
| Remote Room Selection | Existing ordinary risk/ownership/route gates; Keeper selection blocked | Specialized Keeper danger is represented without opening a room | Existing selection tests and live closed W6N4. |
| Remote Mining | W6N4 seats 1/1/5; seven WORK per energy source needed | Stationary safety guard precedes lifecycle/endpoint work | Seat/source intel live; mining retreat automated only. |
| Source Containers | No W6N4 source containers; existing canonical station policy | No extra structure plan or duplicate owner introduced | Existing container-policy tests; no construction commissioned. |
| Remote Hauling | Earlier drop-ID/load churn improved; later ordinary remotes remain understaffed | Keeper windows reserve loading plus conservative evacuation; partial cargo returns safely | Automated; earlier ordinary hauling counters live. No Keeper hauling run. |
| Hauler Population | Forecasts use production/travel/CARRY; real fleet still varies | Keeper diagnostic includes CARRY and spawn occupancy instead of assuming free transport | Regression/model tests; no Keeper haulers spawned. |
| Threat Response | Keepers previously shared generic NPC automatic-defense policy | Dedicated classification, hazard costs and protection checks | Policy/tactics automated; lair/active-threat records live. |
| Remote Recovery | Fresh vision/protection can reopen existing assignments | Unknown timers, vision loss and defender death fail closed; routes retained | Automated reopening/closure decisions; no live combat recovery. |
| Economic Efficiency | Positive projected income is insufficient evidence of profit | Fixed guards, lifetime, hauling, maintenance and spawn budget exposed | Sensitivity model only; delivered net profit unverified. |

The broader colony is **not certified healthy**: at tick 644164 it remained in RECOVERY, with ordinary remote backlog around 22,149 energy and zero healthy remote CARRY reported by Economy. This predates Keeper commissioning and is a reason to keep it closed. The earlier audit demonstrated targeted improvements, but those historical RCL2 outcomes do not certify the later RCL5 economy. See `LOCAL-AUDIT-2026-11-11.md` for the original audit and `validation/audit-20261112/keeper-verification.json` for this release's receipt.
