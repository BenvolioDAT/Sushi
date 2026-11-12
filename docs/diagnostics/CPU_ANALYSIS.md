# CPU analysis

Local private server, configured CPU limit 100. Results do not predict official-world CPU cost.

## Retained sample statistics

47 HEALTH_SNAPSHOT events, ticks 448284–452884, every 100 ticks. Values in cpu_samples.csv are rounded to four decimal places from retrieved console data. Each is the CPU value passed to Diagnostics.finish, before final diagnostics completion, pixel work, and Telemetry.finish. These are **partial-loop measurements**, not complete engine tick costs. Fixed-cadence samples can miss peaks and systematically miss periodic work at other offsets. Diagnostics record 1–2 visible rooms, not owned-room counts. CPU is empire-wide and cannot be assigned entirely to W7N4.

Statistics calculated from those 47 samples, rather than from the broken rolling EMA, are in cpu_summary.json. Peak means highest retained sample, not the peak of all intervening ticks. Bucket was 10000 in every retained sample. No measured timeout or bucket depletion was established.

| Statistic | Partial-loop CPU |
|---|---:|
| Mean | 21.8635 |
| Median | 21.2530 |
| 95th percentile (nearest rank) | 29.6540 |
| Highest retained sample | 37.5078 |
| Minimum | 16.4461 |

These average about 21.9% of the local 100-CPU allowance at the sampling position. They do not establish the full-loop percentage or an official-world CPU budget.

## Confirmed telemetry failure

At 436213, `Memory.hive.telemetry.cpu` was `{used:12.431599999999946,bucket:10000,limit:100}`. It lacked `phases`, `samples`, `total` and `tick`. At 436437, error records span 434926–436437 with message `Cannot read properties of undefined (reading 'diagnostics')`, stack `Object.finish (HiveMind.Telemetry:45:40)`, then `main:41:44`. A later record spans 452525–452956 with count 432.

Trace: HiveMind.Telemetry.finish selects the truthy saved CPU object as `previous` at line 42. The key enumeration guards `previous.phases || {}` at line 44, but line 45 directly indexes `previous.phases[name]`. The current `diagnostics` phase therefore triggers the exception when the legacy record has no phases. The new heap rolling record is not assigned because execution fails before line 47. Progress sampling and persistence later in finish are also skipped. main.js catches the subsystem exception, allowing colony actions on subsequent ticks.

HiveMind.Memory migration can copy legacy `Memory.stats` fields into hive telemetry at line 249. That is a plausible entry path for this shape, not proven historical provenance. The invalid saved shape and failing access are directly confirmed.

An isolated VM reproduction with the exact observed legacy CPU record and mocked API reproduced `TypeError ... (reading 'diagnostics')` at HiveMind.Telemetry.js:45:40. No runtime change was made. Proposed fix: validate/normalize previous.phases and all numerical EMA fields before use, with regression coverage for legacy/partial records and resumed valid samples. Do not delete Memory as a workaround during monitoring.

## Existing subsystem measurements

At 452696, existing heap telemetry total was 19.4934; creepExecution 7.4280, traffic 3.0831, diagnostics 2.8766, planning 2.6289, spawnPlanning 1.4150, visuals 0.6767. At 453204 total was 20.7889; creepExecution 5.3563, planning 4.1271, spawnPlanning 3.7022, traffic 2.9531, diagnostics 2.5368, visuals 0.7839. Planning contains nested economy/strategy measurements; adding every phase would double count. Total is sampled inside finish before the failing work and catch overhead, not a complete engine total. These are two observations, not subsystem averages or proof of a bottleneck.

Freighter role EMA at 452800 reported total 2.8036 CPU, per-creep 0.1771, utilization 0.6480. This is an existing rolling role metric, distinct from whole-loop telemetry and from a raw tick measurement.

## Traveler warning interpretation

Earlier console history (9:51:00–9:51:07 PM; game ticks unavailable) shows Scout_001 repeatedly alternating W8N2 (1,20)/(1,21), destination W9N2 (25,25), with CPU labels rising 1001–1540. Traveler.js:129–135 accumulates search CPU into `state.cpu`; **1540 is not a measured single-tick CPU cost**. This history is a movement/performance lead, not evidence the current colony exceeded its 100 CPU limit. Its build identity was not established.

## Limits and next measurements

GC is scheduled within the visuals phase, and diagnostics provide no separate GC cost here. Existing sparse samples cannot attribute any spike to cleanup or prove cleanup is cheap. If separately authorized later, add bounded complete-tick CPU samples and GC duration/result pairs; preserve game tick and sample position, report monitoring overhead, and avoid serializing Memory each tick. No instrumentation was deployed.
