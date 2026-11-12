# Full automation audit — November 12, 2026

## Result and deployment scope

The colony is operating and improving, but it is not certified as fully autonomous in every combat or economic situation. Confirmed failures in remote-hauler admission, Scout scheduling, stale remote ownership and movement logging received targeted corrections. Local mining continued, remote deliveries resumed, Scouts expanded their knowledge, and unsafe Keeper portfolios stayed closed.

The requested `192_168_0_217___21025/Sushi` directory was an older 109-module copy. The running client/server matched the 115-module `127_0_0_1___21025/Sushi` copy. After presenting that discrepancy, the user selected the running local copy as authoritative. All changes and deployments in this audit use that copy, branch `Sushi`. The old IP and official-server directories were left alone. Root JavaScript uploads automatically through the verified local client workflow; changes were first tested in an isolated staging directory.

Current build is `75288eb7ceb96f921dd3fe66efe285262e9ce63ea2c9da51b247f19e9ccc4c07` (115 modules). Release receipts, exact module comparisons, test logs and recoverable runtime backups are recorded in `validation/audit-20261112/full-auto-release.json` and `full-auto-verification.json`. The latter also records the desktop console's executed build and expired/OFF diagnostic probe. Historical reports and fingerprints are not descriptions of the current release.

## Scope and method

Reviewed the tick/bootstrap/finalize sequence; economy state machine and recovery gates; capability planning and spawn arbitration; miner station lifecycle; local/remote hauling and claims; remote route/ownership planning; Scout intelligence; threat ledger, NPC/Keeper managers, combat roles and tactical math; diagnostics/telemetry; incremental Memory cleanup and caches. The module graph covers all 115 runtime modules with no dependency cycles. The movement ownership audit covers 15 movement/pathfinding sites.

Used the running desktop application to inspect home, remote and Keeper behavior and console output. Read-only, periodically persisted server snapshots supplied assignments, counters, bodies, CPU and Memory evidence without continuous UI polling. Tick comparisons, rather than accelerated wall time, define the observation window. Installed-engine fixtures exercised dangerous combat/lair mechanics without changing the world. No reset, hostile injection, manual Memory purge, structure destruction or manual assault order was performed.

## Confirmed bugs and corrections

1. **Remote hauling could never start despite idle spawn capacity.** The admission governor evaluated an ideal 18-CARRY body against replacement load plus burst occupancy. That body exceeded remaining spawn headroom, so every request was rejected; no useful smaller body was considered. `HiveMind.Capacity` now exposes remaining spawn headroom on this denial. `Spawn.Arbiter` fits a useful remote hauler inside that envelope, then reruns the full policy. CPU, reserves, threats, population and actual missing hauling coverage remain enforced. Fixed military bodies and validated renewals are excluded. Execution cannot regrow the admitted body beyond its cap.
2. **New remote haulers could fragment into tiny bodies.** First live deployment restored hauling but exposed ordinary requests spawning one/two CARRY while more energy was arriving. All ordinary new remote requests now retain a useful four-CARRY minimum, bounded by the original request and the actual remaining deficit. A genuine two-CARRY deficit can still be filled; local emergency bodies and approved renewals retain existing rules. This improves admission without imposing indefinite waits for an ideal body. Fleet consolidation remains incomplete.
3. **Routine intelligence refreshes starved exploration.** Repeated core/Keeper requests could monopolize the Scout indefinitely. After three routine priority selections, a bounded `scoutPlan.priorityStreak` gives unknown or genuinely stale background intelligence a turn. Critical priorities and funded combat observation remain first. Pending safety requests are preserved. Passive Keepers also no longer generate generic defense refresh requests simply because vision was lost; dedicated Keeper intelligence continues to own their safety rules.
4. **Former colonies perpetuated obsolete remote relationships.** Lost-home planner references could keep room identity and remote intel protected forever. Remote parenting/protection now requires a current home or visible owned controller. Valid owned rooms without spawns still retain protection. Old layout/planner knowledge remains; unreferenced transient remote fields use existing retention rules. Live cleanup changed abandoned W8N2/W7N2 records to ordinary intel and retired expired fields without manual deletion.
5. **Traveler flooded the console with misleading CPU warnings.** Its warning compared lifetime accumulated pathfinding CPU with a threshold, then logged every subsequent search. Reporting now measures each search separately, labels cumulative cost explicitly, defaults OFF, honors diagnostics OFF, and throttles per creep. Navigation and stuck recovery remain unchanged.
6. **Scout partial-path oscillation could consume its lifetime.** Live warnings showed repeated W5N2 positions (1,3)/(1,4), targeting W6N2, with accumulated search CPU eventually exceeding 17,000. Successful movement intents bypassed the existing explicit-error cooldown. A bounded travel anchor now requires meaningful displacement or a room transition within 50 ticks; otherwise the destination receives the existing 300-tick retry delay and its cached path clears. Fatigue, detours, fleeing, funded observation, target changes and rollback have explicit handling. This does not declare the room permanently inaccessible or alter global movement safety.

The suspected second-miner station blockage was investigated across later ticks: miners reached distinct seats and became operational. Existing lane-to-seat ownership already handles this; no speculative rewrite was made. Dead-creep cleanup was also checked against the installed engine: a successful spawn inserts its spawning creep into `Game.creeps` immediately, so finalization does not erase that new creep's Memory.

## Live economy evidence

| Tick | Remote healthy CARRY | Remote backlog | Total Freighters | Scout rooms visited | Completed-tick CPU EMA | Memory characters |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 772996, baseline | 0 | 8,963 | 5 | 12 | 32.70 | 340,591 |
| 775110, early first release | 0 | 13,861 | 6 | 12 | 39.51 | 334,419 |
| 776393, hauling established | 65 | 3,708 | 21 | 12 | 43.69 | 350,225 |
| 777642, second release | 35 | 940 | 19 | 12 | 52.03 | 377,752 |
| 778794 | 38 | 2,684 | 17 | 13 | 42.74 | 357,883 |
| 779234 | 32 | 928 | 15 | 15 | 52.44 | 399,068 |
| 781170, movement logging release | 49 | 1,290 | 20 | 15 | 45.23 | 384,941 |
| 781826, final Scout recovery release | 56 | 7,600 | 19 | 15 | 44.62 | 380,090 |

Pickup/delivery flow counters and remote-to-home movement confirm actual hauling, rather than merely planned capacity. Backlog fell by about 90% at tick 779234, then rose to 7,600 as the reserved portfolio's production increased; the reduction was not sustained at that level. This is not a controlled throughput benchmark. Newly visited W5N5, W6N6 and W5N6 demonstrate live exploration. The latter two automatically produced new Keeper assessments without room-specific instructions. In the final release, W6N2 received `NO_TRAVEL_PROGRESS` with retry tick 782059, meaning the watchdog fired at tick 781759. The desktop then executed build `75288eb7...` at tick 781774 with the Scout pursuing W8N5. Both the trigger and subsequent reassignment were verified live, in addition to the deterministic tests.

Home W7N4 remained RCL6 and recovered through normal economy transitions. At the desktop observation near tick 779492, it showed STABLE, both sources covered at five WORK each, local modeled income 20/20 and roughly 69,000 stored energy. Controller progress advanced from 166,232 at baseline to 195,703 at tick 779234. Six studied sources across home/W8N4/W7N3 each had exactly one adjacent container and zero duplicate adjacent container sites in the database inspection. Container policy regression tests also cover controller/source duplication; this observation does not certify every abandoned room.

| System | Findings | Improvements | Verification |
| --- | --- | --- | --- |
| Remote room selection | Four ordinary sources selected; ownership, reservations, routes and economic gates matter | Existing gates preserved | Live portfolio and deterministic planning tests |
| Remote mining | Local five-WORK stations; remote supplements reach separate seats; replacements continue | No miner rewrite needed | Live assignments, station/throughput tests |
| Source containers | One container at each of six inspected sources | Existing canonical policy preserved | Read-only object inspection; container tests |
| Remote hauling | Admission deadlock prevented hauling; actual deliveries now occur | Spawn-envelope fitting and useful minimum | Live counters, falling backlog, regression tests |
| Hauler population | Initial fleet peaked at 21, then 15; remaining deficit varies | Tiny ordinary remote substitutions restricted | Live bodies/spawns; fitting and renewal tests |
| Threat response | Keeper operations remain closed without guards | Separate passive Keeper refresh ownership | Live deferred operations; safety/retreat tests |
| Remote recovery | Replacements and reservation renewal continue; expired abandoned intel retires | Ownership-aware parent/protection cleanup | Live state changes and cleanup tests |
| Economic efficiency | Operationally improved; full profit not proven | Existing travel/body/maintenance estimates retained | Modeled net positive in samples; no full-lifetime cost ledger |

At tick 779234 remote demand rose to 96 CARRY while healthy capacity was 32 after reservation/source changes; at 781170 capacity was 49 against 84 required. The home was then in RECOVERY, reporting restored harvest but logistics below demand. Later desktop observation showed a local miner replacement in progress. At 781826 the home was STABLE again, while the remote portfolio had 56/105 CARRY and modeled net income 31.53; this estimate is not a full-lifetime measured profit. Thus restored hauling is **not** proof the whole portfolio is optimally staffed or sustainably profitable. Fleet counts rose again after the earlier decline. Remaining work includes larger useful replacements when funding permits, reducing small worker churn, and calibrating travel/demand estimates against full-lifetime deliveries. Existing governors appropriately constrain further spending.

## Combat and Keeper readiness

Official [NPC documentation](https://docs.screeps.com/invaders.html) and [API](https://docs.screeps.com/api/) distinguish strongholds from lesser cores. Installed engine 4.3.0-beta/build 40.8.1 supplies the applicable lair and combat behavior for this local server; fixtures use that implementation rather than forum drafts. Stronghold cores coordinate defenders, tower replenishment and repair, so core-only damage tests cannot validate stronghold assaults.

Keeper intelligence remembers lair/resource IDs and positions, current timers, active Keepers and observation age. A living Keeper overrides a countdown; stale/unknown vision cannot certify safety. Approach, work/loading and loaded evacuation time plus margin reserve a safe window. The operation sequence remains assess → assemble the complete force → clear → verify guard coverage → mine → haul. Actual healthy guards, not queued requests, authorize civilians. Death, mixed threats, closed windows, lost vision or economic failure close admission and use existing retreat/partial-cargo handling.

The current standard guard is 20 MOVE/10 RANGED_ATTACK/10 HEAL, 5,000 energy. One is required per energy lair pending shared-patrol certification; three energy lairs imply at least 15,000 initial guard energy, before miners/haulers. Home capacity is only 1,800, so the running colony correctly defers these portfolios. Three standard Keeper sources nominally offer 40 energy/tick before interruptions; seven WORK per source reaches their standard regeneration ceiling. Travel, unavailable harvesting windows, guard replacement, hauling, maintenance, ordinary NPC raids and displaced ordinary remotes must all be charged. Positive modeled returns are not measured profit.

| Combat scenario | Current capability | Verified? | Limitations |
| --- | --- | --- | --- |
| Ordinary NPC Invaders | Automatic threat/defense selection implemented | Automated decision tests; no new live battle | Force adequacy and mixed raids need battlefield validation |
| Invader Core | Conservative unopposed level-zero operation | Automated decisions + isolated damage test; partial live attack | W5N3 was damaged to 65,440 hits at tick 777642, but no kill observed; later third force loss entered cooldown |
| Low-level strongholds, level 1 | Detection/exclusion; no certified autonomous assault | Negative admission tests; no assault | No validated tower/defender/rampart siege plan |
| Mid-level strongholds, levels 2–3 | Not ready | No victory evidence | Sustained healing, boosts, coordinated breach/target adaptation unvalidated |
| High-level strongholds, levels 4–5 | Not ready | No victory evidence | Current economy/body/spawn capacity and siege coordination insufficient |
| Source Keepers | Generic staged protection and safe-window planning implemented | Automated tests + installed-engine fixtures; live safe deferral | No live guard battle or profitable Keeper mining commissioned |
| Remote room defense | Retreat/suspension/defense requests implemented | Automated tests; live safe deferral | No dangerous enemy injected for testing |
| Coordinated squad combat | Existing squad management plus fixed Keeper lair coverage | Automated admission/coordination tests | Formation survival, shared multi-lair patrols and field victories unverified |
| Retreat and recovery | Civilian/guard gating, partial delivery and bounded retries implemented | Automated tests; natural core pause/return/backoff observed | Core mission lifetime can be consumed by economic pauses |

The isolated guard kills a Keeper at range three in 50 ticks with full health; the same guard dies in 14 ticks at range one. A six-ATTACK/six-MOVE Ronin destroys an unopposed 100,000-hit core in 556 fixed-position ticks. These are engine results, not live movement or siege certification. The live core attempt demonstrates a remaining limitation: intermittent authorization can consume its lifetime before completion. The existing three-failure budget/cooldown was preserved; no counters were cleared to force another expedition. Earlier `CORE_GONE_CONFIRMED` records establish absence, not an attributable combat victory.

## CPU, Memory and diagnostics

The server has a 100 CPU limit and maintained a full 10,000 bucket in sampled observations. CPU rose with more active creeps, hauling and discovered intelligence: these changes are not a CPU speedup. Completed-tick EMA samples around 33–52 are meaningful; an accelerated tick rate and Traveler's cumulative number are not per-tick CPU measurements. Traffic, creep execution, economy and spawn evaluation were substantial consumers. No equivalent-workload benchmark proves a CPU optimization.

Memory grew and fell between snapshots, reaching 399,068 and then 380,090 characters, with new routes, creep activity and newly discovered rooms. The observed range does not prove a leak or its absence. Per-creep data clears on death; transient intel, queues, demands and terminal operations have distinct retention rules. Incremental GC runs every 101 ticks with a 25-record budget, protecting active operations/routes, currently owned strategic references and durable core knowledge. Lost-colony planner/layout history is intentionally preserved rather than erased by age. Route caches retain bounded entries and independent expiry.

The opt-in probe defaults OFF, expires automatically and bounds retained samples/stacks. At desktop tick 779031 it was OFF after expiry, with zero recorded probe errors. Recent retained blackbox snapshots had no ERROR/CRITICAL events. The historical Annex record at tick 642475/count 100370 did not advance; old errors are not misreported as current failures. Movement block warnings still occur near crowded stations and need longer traffic analysis; console silence alone is not a health test.

Use `Sushi.debug.probe(true, {room: 'yourHome', duration: 500, interval: 25})`, `Sushi.debug.probeReport()`, and `Sushi.debug.probe(false)`. For optional path-search warnings set `Memory.config.diagnostics.travelerCpu.enabled = true`; disable it afterward. Default threshold is five CPU for a single search, at most one warning per creep per 100 ticks. Master diagnostics OFF also suppresses it. No extra gameplay intent is created by either diagnostic.

## Validation and remaining work

The final `npm test` validation log records **260 PASS checks**, including new regressions for spawn-envelope fitting, CPU/reserve exclusions, remote minimum bodies, Scout fairness/critical observation, passive Keeper refresh ownership, lost-home cleanup, Traveler diagnostic cadence and successful-intent Scout stalls. Eleven additional installed-engine checks cover eight lair/action mechanics and three isolated combat outcomes. A staging run correctly failed its build-fingerprint check after a last Scout edit; rebuilding and rerunning the complete suite resolved it before deployment. Syntax, module graph, movement ownership and source/server byte identity are checked separately. Staging avoids using live upload as a test runner.

Startup, replacement, recovery, reservation, hauling claims, threat gating and cleanup are covered by deterministic tests. This audit did not reset or kill the active colony to certify a fresh-world bootstrap, recovery from total spawn loss, or destructive combat scenarios. Stronghold assaults, affordable Keeper commissioning, full-lifetime remote profitability, large-body fleet consolidation, congestion under mature load and sustained 20-CPU public-world performance remain unverified. No official deployment occurred.
