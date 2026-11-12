# Sushi local-server monitoring report

Audit date: November 11, 2026 (America/New_York). Observe, measure, investigate, report only.

## Result

W7N4 is surviving and developing, but its CPU telemetry fails repeatedly on a legacy memory shape. The colony progressed from RCL1 to RCL2, built five extensions and three containers, and improved the one-seat source from two to four WORK. Hauling meets the planner's CARRY target but remains fragmented among many small workers. No critical colony failure was established.

No runtime files, configuration, Memory, structures, enemies, server processes, or official-world scripts were deliberately changed. Only diagnostic documents/data were created. No build, deployment, refactor, or package validation script was run. Architecture handoff is unchanged because implementation is unchanged.

## Evidence and scope

- Native Screeps app inspected through computer use, using the existing session. The first connection failed (`failed to launch codex app-server: program not found`); the alternate computer interface worked.
- Runtime query at tick 436213 identified private shard `Benvolio-DAT`, CPU limit 100, GCL2, progress 252218 / 4278031.643091577. Final owned-room query established W7N4 as the only owned room. `Game.rooms` also contained scout-visible rooms; these are not additional owned colonies.
- Runtime build at tick 436437: `5d35cd2adb57c4cc27858879ba066814b043fa3e14a9a207523621bcf793d86e`, 109 modules. This matches the checkout's Runtime.Build.js. A build marker match supports source tracing; independent hashing of all running modules was not performed.
- First observed dashboard tick: 435497. Final runtime snapshot: 453204. Endpoint span: **17707 game ticks**. These are intermittent observations, with a substantial gap between early and late observations, not a continuous recording of every tick. No measured tick/second rate is claimed.
- Early direct screenshots cover 435497–436958; later direct observations cover 452286–453204. Retained HEALTH_SNAPSHOT events supply 47 samples at 100-tick intervals from 448284–452884 (4600-tick span). This supplies extended historical evidence despite the observation gap; it is not continuous 5000-tick video or per-tick CPU capture.
- Input limitation: an initial `typeText` attempt inserted the user prompt rather than the intended query; that text appeared in console history. It is not a gameplay observation or a Sushi runtime error. Later commands were pasted and visually checked before submission. One accessibility setValue timed out but visibly populated `Game.time`; its eventual response was tick 436013. A large detailed query produced no usable retrieved response and is excluded from measurements.

## Baseline and final state

| Metric | Initial evidence | Later evidence |
|---|---|---|
| Owned room | Dashboard: 1, W7N4 | Runtime 453204: only W7N4 |
| RCL / progress | 435497: RCL1, 51% | 453204: RCL2, 5652 / 45000 (12.56%) |
| Spawn energy / capacity | 435497: 300 / 300 | 453204: 550 / 550 |
| Spawn activity | Initial dashboard IDLE | 453204: Spawn1 idle, one owned spawn |
| Creeps | 435497: 24 | 452696: 23 |
| Roles | 435497: Foreman 1, Extractor 5, Freighter 14, Tech 1, Artificer 2, Scout 1 | 452696: Foreman 1, Extractor 4, Freighter 16, Tech 1, Scout 1 |
| CPU | 435497 dashboard 15.8 / 100 | Retained sample mean 21.86 / 100; see CPU_ANALYSIS.md |
| Bucket | Initial dashboard 10000 | All 47 retained CPU samples 10000 |
| Construction sites | Initial count unavailable | 436958: detailed site list retained in observation; 452696: 82 roads, no other site types |
| Stored energy | Dashboard 0 | Dashboard 0; no storage structure independently inventoried |
| Containers | Initial built count unavailable | 452496: three built containers, detailed in GAMEPLAY_FINDINGS.md |
| Serialized Memory length | 436213: 250255 characters | 452956: 286693 characters; intermediate values fluctuate |
| Dead creep records | Initial unavailable | 436958, 452696, 452956: zero |

## Ranked recommendations

| Priority | Finding and evidence | Expected benefit | Implementation risk |
|---|---|---|---|
| High | H1: Legacy CPU record without `phases` makes Telemetry.finish fail, live stack at line 45; reproduced in isolated VM | Restore rolling CPU/growth telemetry and downstream CPU admission signals; stop recurring exception work | Low–medium: normalize all legacy fields, handle invalid sample counts, preserve valid data |
| Medium | M1: 452696 has 16 Freighters, 14 with one CARRY and two with two CARRY; 452818 has five idle of 15 and CARRY target exactly met | Fewer workers, less traffic and CPU if equivalent delivery throughput can be preserved | Medium: waiting/consolidation must not starve spawn refill or replacement deadlines |
| Medium | M2: At 550/550 energy and five built extensions, dashboard still recommends building/filling extensions; one-seat source can only support four WORK with current body policy | Actionable RCL3/capacity guidance instead of an impossible RCL2 construction instruction | Low for display; medium if changing growth policy rather than wording |
| Medium, investigation | M3: Dashboard calls W6N3 and W8N3 remote operations active while 452818 remote hauling required/living CARRY are zero; final worker flag query empty | Distinguish selected/planned remotes from productive mining and delivery | Low for display; medium–high for changing remote admission without economy evidence |
| Low, investigation | L1: Retained earlier console history shows Scout_001 alternating W8N2 (1,20)/(1,21), with repeated Traveler warnings | Validate exit recovery and reduce repeated path searches if reproduced on current colony | Medium: movement changes affect all room transitions; old history lacks game ticks/build identity |

No critical confirmed defect. Do not treat candidate investigations as established root causes.

## Unverified or limited coverage

Combat, tower targeting, civilian retreat, invader/core response, threat recovery, remote mining profitability, measured source regeneration efficiency, complete-trip matched-worker hauling deltas, stale job ownership after death, migration of every legacy record, and GC-specific CPU spikes remain unverified. No enemies were created. No claim is made that absent errors prove these systems work.

Source seats (five and one) are reported by the planner and consistent with observed stationed miners, but an independent terrain/occupancy enumeration was not retrieved. Source IDs, bodies, locations and containers were obtained directly. No current named-creep deadlock was established from matched sequential positions. Readability issues and truncated text were observed; overlays also obscure significant portions of the room. Dashboard population values were not captured at the identical tick as the runtime population snapshot, so no exact-tick mismatch is claimed.

The telemetry VM reproduction ran only in a separate Node process with mocked Game/Memory/require objects and read the source file. It did not load code into Screeps or touch game Memory.

See CPU_ANALYSIS.md, MEMORY_ANALYSIS.md, GAMEPLAY_FINDINGS.md, cpu_samples.csv and evidence.json for supporting detail.

## Continuation: ticks 456913–457703

A second read-only pass added three runtime snapshots and a generation-matched hauling comparison. Across 790 ticks, all 13 surviving matched Freighters recorded positive cargo unloading, totaling 12138 energy; controller progress increased from 7190 to 7573. Memory fluctuated 249951 → 274362 → 242635 characters, ending 7316 lower than the first continuation sample. The telemetry exception persisted (1584 occurrences across 455956–457539), and GC completed another traversal at 457460. Remaining retrieved construction sites at 457539 were roads with zero progress.

This narrows M1: fragmented bodies and uneven utilization remain supported, but initially idle workers subsequently hauled energy. It does not support calling all those workers useless or simply removing them. A newly identified metric limitation is that truthy `freighterJob="idle"` can classify moving idle creeps as working. Treat work utilization as a movement heuristic and cargo unloading as a separate measure. Unloading includes controlled drops; it does not prove final consumer receipt. See CONTINUATION_FINDINGS.md, continuation_evidence.json and hauling_matched_790.csv. No implementation was changed.
