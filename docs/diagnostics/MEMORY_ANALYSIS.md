# Memory analysis

Measurements are `RawMemory.get().length` (serialized string characters), not heap usage or a verified byte count. Sparse reads only; no Memory was deleted by the audit.

| Game tick | Serialized characters | Dead creep records |
|---|---:|---:|
| 436213 | 250255 | unavailable |
| 436958 | 240839 | 0 |
| 452696 | 274048 | 0 |
| 452956 | 286693 | 0 |

Size initially falls by 9416, then rises in later observations. The observations do not establish an unbounded leak, a steady growth rate, or causation. Colony development, scouting, queues and diagnostic retention change over this interval. No 2000-tick deletion rule should be inferred from record age alone.

## Cleanup is present and executing

Live GC reports:

| Query tick | GC last-report tick | Examined work | Removed count | Sweep pending |
|---|---|---:|---:|---|
| 436213 | 436149 | 25 | 1 | true |
| 436958 | 436957 | 25 | 1 | true |
| 452696 | 452612 | 20 | 0 | false |
| 452956 | 452915 | 25 | 1 | true |

HiveMind.Memory defaults configure interval 101 and workBudget 25. Tick.Finalize.cleanDeadCreepMemory runs each reached optional-work phase. The separate GC uses Scheduler.run with the 101-tick staggered cadence and can defer under CPU pressure; it is not a hard guarantee to clean every 101 ticks. Its scalar cursor advances across sweeps; live `sweepPending:false` at 452612 confirms at least one completed traversal. It is **not configured as a 2000-tick maintenance cycle**.

The GC preserves home/remote/active-operation/expansion rooms and applies domain-specific retention. Intel retention defaults to 20000 ticks, operations 1000 after terminal state, squads 250, expansion candidates 10000, and inactive resource/debug records 5000. It prunes selected old intel fields rather than indiscriminately deleting rooms. Removal counts can represent fields as well as records. These are source defaults; complete live configuration overrides were not queried.

`workBudget` limits processed candidate records, not total enumeration/sorting cost: records() regenerates/sorts keys, and resuming past the cursor can enumerate prior records before spending the processing budget. This is a source-derived scaling concern, not a measured live CPU spike. Do not claim strict constant-time GC without profiling.

## Domain size snapshot at 453204

Individually serialized top-level values: rooms 180785; hive 35815; creeps 13176; sourceInfos 7244; config 3198 characters. These exclude their enclosing property names/commas and therefore are not a substitute for the whole RawMemory string measurement. Hive values included telemetry 17424, threats 8163, resources 4740, expansion 3889, capacity 1028 and gc 100. Legacy sourceInfos/mineralInfos are present, but age and active-reader ownership were not established; their existence is not evidence they should be deleted.

Confirmed stale incompatible data: the CPU telemetry object at 436213 lacks the shape required by the current reader. This is a schema compatibility defect, not proof of an ongoing memory leak. See CPU_ANALYSIS.md.

Dead-creep memory cleanup is supported by three zero-dead-record samples. Stale job references, invalid construction references, movement record obsolescence, per-room intel ages and boundedness of every memory branch were not exhaustively measured. Diagnostics defaults have event/character limits, but actual long-term memory boundedness was not stress-tested. GC CPU spikes remain unverified because there is no isolated GC timer in the captured instrumentation.

## Continuation measurements

| Game tick | Serialized characters |
|---|---:|
| 456913 | 249951 |
| 457224 | 274362 |
| 457703 | 242635 |

Memory rose then fell, ending 7316 characters below the first continuation sample. These observations strengthen the conclusion that the previous rise alone does not establish an unbounded leak. GC lastReport at tick 457460 reports work 20, removed 0, sweepPending:false, retrieved at 457539. No fresh dead-creep count or GC-specific CPU timing was successfully collected in this pass.
