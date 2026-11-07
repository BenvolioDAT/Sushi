# Sushi logistics investigation — November 7, 2026

## Verdict from the running game

Inspected the open Screeps desktop application on **shard3, W39S47**, using read-only console expressions. No live Memory edits, creep deletions, settings changes, profiling-mode changes, or deployment actions were performed. Changes are in the requested local Sushi checkout. The checkout's directory identifies a private-server script location; it is not proof of synchronization with the inspected shard3 branch.

The live Freighters were doing economically useful work. **An uncontrolled Freighter spawn loop was not observed.** The fleet is fragmented into many small bodies, and aging workers trigger additional small replacements. Capacity, backlog, movement efficiency, and CPU pressure are different issues.

Runtime evidence is saved in [`validation/logistics-live-2026-11-07.json`](validation/logistics-live-2026-11-07.json), including three room/CPU observations, source positions, routes, configuration, admission decisions, and recent events.

| Live tick | Living Freighters | Physical CARRY | Replacement-adjusted living CARRY + spawning | Required local CARRY | Source backlog | Rolling CPU / 20 | Bucket |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 84129482 | 13 | 25 | 25 + 0 | 23 | 6,616 | 14.41 | 8,338 |
| 84129517 | 14 | 26 | 23 + 0 | 23 | 5,815 | 14.48 | 8,463 |
| 84129598 | 14 | 24 | 21 + 1 | 22 | 4,624 | 15.38 | 8,696 |

- The same 13 workers recorded **800 picked and 750 delivered energy over 35 ticks**, approximately 21.4 delivered energy/tick. All changed position. Cargo decreases include controlled overflow, so these counters are transport evidence rather than a complete downstream consumption ledger. No workers died or reused names within this particular comparison interval.
- Both local sources had their required five WORK stationed. The northern source at `(10,3)` held most of the backlog; the other source is at `(32,24)`. Cached spawn-side distances were 25 and 9. A controller-side container at `(5,33)` was a common delivery destination, with 1,082 energy and 918 free capacity at tick 84129537. Several workers sharing that destination was therefore legitimate reservation sharing, not proof of overbooking.
- At the first sample, nine of thirteen workers had only one CARRY. The whole fleet's ordinary body replacement energy cost was about **1.67 energy/tick** (2,500 energy / 1,500 ticks), before other colony expenses. Its observed transport was useful, but its headcount carries avoidable potential CPU overhead. This short sample does not establish lifetime profitability or the optimal fleet size.
- Recent events show 100-energy Freighter replacements at ticks 84129510, 84129570, 84129591, and 84129597. Existing workers crossed the replacement lead boundary or died; the final observation had 21 healthy CARRY plus one spawning against demand of 22. Small missing-capability increments explain these particular requests. The generic configured Freighter cap of six is not an absolute population target: economic role caps scale, and mandatory local recovery can bypass soft guards. The hard population safety cap remains. Lowering a role cap would hide the actual capability/lifecycle decision.
- Rolling CPU stayed below 20 and the bucket recovered over the 116 observed ticks. Traffic cost roughly **3.36–3.55 CPU/tick**. Timestamped Freighter role samples were about **2.65–3.43 CPU**; role EMA totals and traffic phases are different measurements and must not be added to overlapping nested samples. Planning, diagnostics, and other roles also consume material CPU. An old Scout role sample remained in telemetry after the Scout disappeared: sample timestamps matter.
- The local backlog kept Economy in RECOVERY even while capacity was covered and backlog was declining. Remote diagnostics reported 52 missing CARRY, but proven remote income and assigned remote CARRY were zero. Those are planned portfolio requirements, not evidence of active remote energy delivery. Spending/Capacity gates were also refusing optional work; a displayed remote deficit is not an instruction that bypasses those gates.

## Lifecycle and ownership

| Stage | Current decision path |
| --- | --- |
| Production | `utility.getSourceHarvestProfile()` derives regeneration income; `Harvest.Planning.describe()` models attainable WORK/seats. Economy separately exposes stationed production estimates. Natural source depletion does not erase the regeneration target. |
| Hauling demand | `HiveMind.Economy.buildSnapshot()` sums attainable residual production × source round-trip distance, finite backlog recovery, and margin. Links reduce creep-served income. `remoteHaulRequirement()` handles operational remote production/routes/fresh backlog independently. |
| Commitments | `Economy.freighterCoverage()` counts movable healthy CARRY, spawning workers, unexpired queues, and deduplicated accepted spawn intents. Idle/stalled workers retain physical capability; low utilization does not make them disappear from coverage. |
| Requests | `spawn.request.manager.getFreighterCarryDemand()` splits local and remote shortages. Dynamic requests choose the missing assignment and a capability-bounded body. |
| Admission | Arbiter normalizes/deduplicates; Policy rechecks spending, current deficit, lifecycle, Capacity, role/queue limits, and replacements. A cap permits or rejects a request; it does not generate hauling demand. |
| Body/execution | `spawn.manager` revalidates and previews an affordable body, then records successful intents. Ordinary Freighter bodies are now bounded by the remaining assignment deficit at execution. |
| Assignment/pickup | `role.Freighter` chooses source-side drops/containers or explicit remote work. Mutable reservations limit uncommitted energy; useful load/distance scoring and retarget hysteresis remain. Depleted targets release partial cargo for delivery. |
| Movement/delivery | Travel wrapper → shared lanes or Traveler → traffic resolution → engine movement. Shared delivery reservations spread destinations by receiving capacity. Container delivery is legitimate even when the spawn is full. |
| Reevaluation | Next-tick observations refresh targets and reservations; planning rereads commitments. Backlog can keep recovery active after CARRY is covered, without automatically requesting more local haulers. |

## Confirmed defects and corrections

The starting HEAD, `24a6e64`, already contained the November 6 logistics work described in [`LOGISTICS-CPU-INVESTIGATION.md`](LOGISTICS-CPU-INVESTIGATION.md). Its 28 logistics tests passed before changes. This investigation adds the following corrections rather than claiming that earlier work as new.

| Defect | Evidence and correction |
| --- | --- |
| Queued Freighter body could exceed the latest deficit. | A queued seven-CARRY request still spawned seven when demand fell to one. Local and remote admission now supply `missingCarry`; execution bounds both ordinary body selection and body profiles. Explicit fixed-body requests preserve their contract. |
| Local and remote requests collided, and deduplication invented commitments. | Fallback fingerprints omitted hauling assignment. A second request could return “already queued,” while the producer still reported a new creep and added phantom CARRY. Fingerprints now distinguish assignments; producers report the actual admission result and reread the commitment ledger. |
| Consumer policy disagreed with production-based hauling demand. | With `upgradeRush`, a reproduction reported 19 local CARRY against Economy/admission's 16. Removed that independent bonus. Live `upgradeRush` was false, so this was **not** the live room's cause. |
| Idle remote-only workers approached local sources they could not serve. | Reproduced 100 local-source movement attempts in 100 ticks. Dedicated remote workers now remain out of local source parking. None were present in the observed fleet, so this is a regression fix rather than the observed room's explanation. |
| Idle local movement competed for constrained CPU. | Local parking could request a path under 19/20 used CPU. Low/critical CPU now defers that optional movement while new pickups and delivery still execute. |
| Pickup/parking repeated room queries per worker. | A 100-idle-worker reproduction made 400 room scans. Local observations now derive once per room/tick from the existing tick index; urgency, spawn selection, and source enumeration reuse it. Corrected measurement: **7 scans**, with mutable claims still applied per worker. This is an API-call comparison, not engine CPU milliseconds. |
| Movement could count parking as productive hauling. | A worker moving without cargo/job inflated utilization. Parking is now separate from work, with bounded observation/work/parking counters. Cargo changes or observed movement with a transport job remain work proxies, not proof of useful consumption. |
| Traveler consumed a path after checking exhaustion. | A one-step partial path followed by another travel call submitted an invalid direction (`NaN`, returned as `-10`). Consumption now precedes the exhaustion/pathfinding check, permitting immediate replanning. Useful remaining paths still reuse the cache. |
| Shared movement retained obsolete origin-relative Traveler caches. | Live workers at `(5,25)`, `(5,29)`, and elsewhere on shared lanes retained `_trav` state from `(9,6)` with a single cached direction. Reusing an old target after a round trip could resume those stale directions. Successful shared-lane steps now clear `_trav`/`_move`, retaining the shared pointer. |
| Recovery wording treated backlog as a capacity shortage. | Live local CARRY was covered while backlog drained, but the displayed reason remained “logistics below demand.” The explanation now distinguishes covered capacity with backlog/backpressure. Recovery thresholds and the compatible reason code remain unchanged. |

The live logs contain repeated `MOVEMENT_INVALID_DESTINATION` events with result `-10`, especially at `(5,32)` beside the controller container. Both Traveler failures reproduce locally and the stale cache state was observed directly. This is strong supporting evidence for the correction; it does not prove that every live `-10` warning has the same origin. Persistent-block warnings also occurred near the other source; no permanent universal traffic deadlock was observed. Essential traffic and miner protection remain unchanged.

## Diagnostics and validation

`Sushi.debug.room("W39S47").current.logistics` now exposes revision `logistics-2026-11-07`, live local/remote ledgers, idle/no-progress/fatigue counts, surviving-worker flow totals, and timestamped CPU. `CAPACITY_COVERED_BACKLOG` means inspect flow and destination pressure; it does not mean automatically add another hauler. Missing current Economy observations are explicit. New counters initialize lazily; no migration or second scheduler was introduced. Architecture and Memory responsibilities are documented in [`docs/ARCHITECTURE_HANDOFF.md`](docs/ARCHITECTURE_HANDOFF.md).

The running shard reported `typeof Logistics.Index.localPickupOptions === "undefined"` and no parking counters. The new changes were therefore not running during these observations. Existing diagnostic fields were compatible with the prior optimization, but no complete deployment hash was available.

**Validation:** `npm run validate` passed **41 commands / 616 PASS checks**, including **45 logistics scenarios**. The graph has 107 reachable modules and zero cycles; movement audit and whitespace checks passed. The broader suite includes 900 recovery decision cycles, restoration at cycle 878, 26 spawns, maximum queue four. Focused coverage includes CPU pressure, 100 idle workers, congestion/miner protection, depleted pickups, partial cargo, queue/intents/deaths, remote closures, stale sightings, zero production, fixed/profile bodies, same-tick deduplication, shared-route cache ownership, and Traveler partial-path exhaustion. See [`validation/logistics-reinvestigation-full.log`](validation/logistics-reinvestigation-full.log) and the reproduction logs beside it.

## Verification after separately approved deployment

1. Verify the intended **shard3 branch and destination** before deployment; the local private-server-named folder does not establish that mapping. No deployment is authorized by this report. Afterwards check `Sushi.debug.room("W39S47").current.logistics.revision`.
2. Compare read-only room/CPU snapshots over complete trips and at least one creep lifetime. Match worker identity, body, and TTL: names can be reused. Compare flow deltas for the same surviving workers; aggregate lifetime totals decrease on deaths and legacy counters lack the new observation history.
3. Confirm controller-container departures stop producing the repeated `-10` pattern. Check stuck warnings, resolved position/cargo changes, delivery rate, backlog, and traffic CPU together. No new path cache or traffic algorithm replaced the existing owners.
4. Confirm local living + spawning + queued CARRY covers the modeled requirement without duplicate requests. A replacement-adjusted deficit alongside aging workers is legitimate. A new ordinary body must not exceed the execution-time deficit. Local and remote queues must remain independent.
5. Confirm optional idle parking yields under pressure while pickup, loaded movement, delivery, traffic, and recovery continue. Verify matched-condition rolling CPU and bucket trends; the mock scan improvement is not a promised live CPU reduction.
6. Watch source backlog and useful destination consumption. The controller-side destination makes real trips longer than the spawn-side approximation in some layouts. If capacity remains covered while backlog worsens, investigate paths, sinks, fatigue, delivery detours, and reservations before changing population targets.

## Remaining limits

- Fleet fragmentation remains possible: exact small deficits and staggered expiries can perpetuate one-CARRY replacements even when full room energy is available. The live fleet was useful and draining backlog, so this change does not forcibly retire workers or deliberately overbuild capability to obtain larger bodies. A future cohort replacement/consolidation policy needs lifetime/payback and overlap validation.
- Local distance modeling still uses storage/main-spawn geometry and approximate movement, rather than all actual controller/extension destinations. Backlog/flow assessments expose a disagreement without pretending to calibrate it away.
- Recovery still conservatively reacts to large backlog, including normally draining backlog. Planned remote demand is not proven remote production; route/spending safeguards remain essential.
- Actual post-deployment CPU, Memory serialization cost, long-run profitability, and resolution of every live movement warning remain unverified. The live sample is a baseline from the previous runtime, not a live test of these local changes.

Engine references: [tick-delayed resolution](https://docs.screeps.com/game-loop.html), [CPU limit versus bucket](https://docs.screeps.com/cpu-limit.html), [creep API](https://docs.screeps.com/api/#Creep.withdraw).
