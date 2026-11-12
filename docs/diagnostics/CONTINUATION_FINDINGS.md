# Continued live monitoring

Read-only continuation on the existing local W7N4 session. No source/runtime edits, deployments, Memory deletion, structure changes, enemies or server restarts.

## What the new evidence changes

The fleet is fragmented, but idle snapshots alone overstated the case for unused haulers. All fourteen matched surviving workers unloaded energy during the first 311 ticks. Thirteen survived the full 790-tick comparison, and all thirteen unloaded energy: 12138 total, or 15.365 per game tick for this cohort. This excludes expired workers and newcomers, so it is not total fleet throughput. Unloading includes controlled overflow drops and is not measured final consumer receipt.

Generations were matched by both name and equality of `snapshot tick + ticksToLive`. Names reused after death do not qualify. Each matched worker's observed counter increased by exactly 790. Numerical evidence is in continuation_evidence.json and hauling_matched_790.csv.

| Tick | Memory characters | Controller progress |
|---|---:|---:|
| 456913 | 249951 | 7190 |
| 457224 | 274362 | 7317 |
| 457703 | 242635 | 7573 |

Controller progress rose 383, about 0.485 per tick. Memory first rose, then ended 7316 characters below the starting value. This does not establish a memory leak or prove every memory branch is bounded.

## Persistent telemetry defect

At tick 457539, the same telemetry exception record has count 1584 over ticks 455956–457539, one occurrence per tick over that stored range. Stack remains HiveMind.Telemetry:45:40 followed by main:41:44. No fix was applied. GC completed a traversal at tick 457460 (work 20, removed 0, pending:false). CPU cost of that cleanup remains unavailable.

## Workload metric limitation

role.Freighter.js calculates `jobMovement` using truthiness of `creep.memory.freighterJob`. The string `idle` is truthy, so movement with an idle job can count as active work. This is a source-confirmed ambiguity in the meaning of utilization; it is not evidence that the engine action itself failed.

Freighter_009 unloaded 150 energy and recorded 333 parking ticks over 790 ticks, compared with Freighter_011 unloading 1968. Workloads are uneven. Recommend distinguishing productive assignment travel, parking and idle movement in diagnostic counters before using utilization to resize the fleet. Risk is low for display/counters and higher if these values feed capacity admission; audit readers before implementation.

## Construction and Scout limits

The tick 457539 construction-site response lists only roads, all with zero progress. Site IDs were not collected, so uninterrupted stagnation of individual sites is not proven. The dashboard shows no Artificer row and continues to prioritize core recovery. Road postponement may follow policy rather than broken job ownership; investigate admission/budget decisions before diagnosing abandoned jobs.

Console history contains repeated Scout births, including recurring Scout_001 names over short wall-clock intervals. Exact birth/death ticks, damage causes and server tick-rate measurement were not obtained, so this remains an investigation lead. Accelerated time makes wall-clock lifetime comparisons unreliable.

## Interface limitations

Clipboard paste again supplied stale text rather than the intended query. The unsubmitted editor text was cleared; subsequent successful queries were entered with direct keyboard events and verified on-screen before submission. Several window focus/bounds actions failed and were recovered by fresh observations. No successful fresh dead-creep count, per-tick CPU distribution, or remote profitability measurement was obtained in this continuation; earlier measurements retain their original scope.

Recommended order remains: repair telemetry schema compatibility first; improve interpretation of workload counters; then evaluate larger-body replacement and construction priorities using matched action/delivery evidence. No further runtime changes are authorized by this monitoring task.
