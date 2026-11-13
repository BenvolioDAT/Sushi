# Sushi traffic and diagnostics audit — November 12, 2026 (US Eastern)

## Scope and result

The task starts a fresh live window at console tick **2,191,631** on the existing W1N7 colony. The code baseline is the previously verified local IP-folder branch, build `744e6480d2d774a20a97302b4ad03134cee7c3d2e64d089b238c234e3e55ffa3`, 116 modules. `git status` was clean at the start. No public-server files, world reset, manual creep reassignment, hostile injection or economic Memory repair was used.

The release changes shared-path station avoidance, diagnostic warning resolution and human-readable console/dashboard presentation. It builds as `2871b12c1eceab25dc150e4b7c96c220195dabee7622c8a581e80cf5d7956044` (116 modules), confirmed by the desktop console at tick **2,196,399**. Only `192_168_0_217___21025/Sushi` receives the release. `validation/traffic-20261113/` contains the original runtime checkpoint, isolated stage, test logs, byte-verified release plan and rollback bytes.

## Confirmed causes and changes

### Shared lanes routed through protected miners

At tick 2,192,620, Freighter_001 was at (36,28) requesting (35,29), occupied by protected Extractor_006. Its flow recorder showed **639 consecutive ticks without useful progress**, with only 500 energy picked/delivered. Freighter_008 queued behind it at (36,27), with 121 idle ticks. Freighter_005 also requested (16,23), occupied by protected Extractor_005. The traffic manager correctly refused to displace productive mining stations. Shared route planning, however, ignored those stations; stuck fallback could repeatedly reacquire the same unsuitable lane.

`utility.Travel.Creep` now uses the existing tick index and traffic manager's existing `isProtectedStationaryMiner` predicate. New shared-path matrices block physically protected miners, excluding the moving creep itself. Following a cached lane checks its next tile; a protected station invalidates that lane and uses fresh Traveler pathfinding with current creeps considered. Ordinary moving haulers and moving/retreating miners do not invalidate lanes. No new traffic controller, forced miner displacement or persistent reservation system is added.

### Warning counts mixed unresolved symptoms with recovered history

The old dashboard displayed warning records from a recent window without saying that they were historical records or whether the symptom still existed. Direct use of the suggested structured `Sushi.debug.room(...)` command produced `[object Object]` in this desktop console. Its movement warnings also lacked target coordinates and stuck duration. Healthy lifetime-replacement plan changes were routinely WARN even while the incumbent covered current production.

Diagnostics now retains resolved warnings with optional root fields **`resolvedAt`** and **`resolution`**. It resolves only evidenced cases: actual later movement progress, a vanished actor or a demonstrably different creep generation; restored spawn energy/reserves; resumed growth; restored harvest; or completed economy recovery. Current/fresh room samples are required. Unknown warnings, unresolved failures and every ERROR remain intact. Ordinary history retention still bounds the ring. A later recurrence receives a new record instead of overwriting a resolved incident. Rows retain original IDs, counts, data and observation timestamps and are re-sorted before age retention.

Resolution runs during the existing 100-tick diagnostic room snapshot and on explicit `Sushi.debug.review(room)`; it does not change gameplay policy. `Sushi.debug.report(room)` returns readable text while `room()` retains its structured object API. The dashboard names the 1,000-tick recent window, shows resolved history separately, points to `report()`, and adds local CARRY/worker/idle/stalled/backlog rows. Movement records now include destination tile coordinates and stuck ticks. A physically covered, productive source with no replacement risk reports routine replacement-plan changes at INFO; actual shortages remain WARN.

No history-wide `clear()` was called. Reduced active-warning counts alone are not evidence of improved gameplay; source backlog and creep-flow observations are evaluated separately.

## Warning inventory and disposition

All retained WARN records were grouped by event at tick 2,194,680, beyond the initial last-100 warning sample.

| Warning family | Records at inventory | Cause and disposition |
| --- | ---: | --- |
| MOVEMENT_PERSISTENT_BLOCK | 78 | Protected-miner/shared-lane mismatch confirmed live; corrected. Later progress/death closes old actor symptoms while retaining history. Ordinary congestion remains visible. |
| SPAWN_ENERGY_STARVATION | 23 | Spawn energy repeatedly dipped after births despite energy elsewhere. Keep new deficits; mark old episodes resolved only after spawn energy returns to at least 200. No energy injection. |
| SPAWN_REJECTED | 12 | Observed Artificer requests exceeded reserve admission or configured role caps. These policy denials are not proof of broken execution. Unknown/outstanding rejections remain in history/recent warning counts; no blanket dismissal. |
| HARVEST_PLAN_CHANGED | 27 | Mixture of actual missing/replacement WORK and routine lifetime handoffs. Healthy covered maintenance becomes INFO; restored physical source coverage can resolve the old shortage record. |
| ECONOMY_CONSTRAINT_CHANGED | 20 | LOCAL_HARVEST_SHORTAGE during handoffs and LOCAL_HAUL_SHORTAGE from backlog. Preserve ongoing recovery; resolve old recovery episodes only when STABLE/SURPLUS is actually observed. |
| GROWTH_PAUSED | 4 | Economic/local-floor pause. Close only on current `growthAllowed: true`. |
| CRITICAL_HARVEST_CAPACITY_MISSING | 4 | Real temporary 7–9/10 WORK gaps during replacement. Close only on Economy's HEALTHY coverage; no reduction of required mining WORK. |
| ROOM_EXIT_OSCILLATION | 1 | Historical Scout exit episode, last observed at 2,192,646. Existing Scout recovery remains responsible; a later verified move or actor generation change closes the historical symptom. No new Scout rewrite. |

These are record counts, not numbers of failing creeps or numbers of failed ticks. Deduplicated movement records may represent hundreds of attempts.

## Observation checkpoints

| Tick | Evidence |
| --- | --- |
| 2,191,631 | Console baseline: 81 recent warnings, no retained errors; completed-tick CPU EMA 29.61/100; bucket 10,000. |
| 2,191,963 | 20/19 healthy local CARRY, 4,305 source energy backlog, one no-progress worker; controller progress 17,705. |
| 2,192,620 | Exact next-tile/miner conflicts and 639-tick stuck hauler confirmed. CPU EMA 36.05. |
| 2,194,680 | Full warning inventory; multiple haulers still stalled for 280–391 ticks. CPU EMA 35.36; controller progress 24,253. |
| 2,195,084 | First screenshot of the new dashboard: 20/19 CARRY, six workers, zero no-progress workers, backlog about 3,300; revised warning/history labels render. |
| 2,195,432 | STABLE; backlog 566; no stalled workers in the panel. |
| 2,195,479 | STABLE; backlog 294; no stalled workers. |
| 2,195,632 | Brief RECOVERY; backlog about 1,900; no stalled workers. |
| 2,196,101 | Backlog 637, five hauling workers, zero no-progress workers; controller 64.8% through RCL2. |
| 2,196,298 | Backlog 116, five workers, no stalled workers; one replacement pending. |
| 2,196,399 | Console executes exact corrected build fingerprint. |

Dashboard ticks come from `Game.time`. The changing workload, natural births/deaths and controller/structure growth prevent treating these samples as a controlled throughput or CPU benchmark. A successful move request is not proof of actual movement; the initial conflict was verified against physical positions and resolved flow data.

## Tests and remaining limits

The complete staged and final local suites pass **294 checks**, including three new station-traffic regressions and six new diagnostic-resolution scenarios. The graph retains 116 reachable modules and zero cycles. Tests cover stationary versus moving occupancy, own-station departure, cached-lane rejection, unresolved/stale evidence protection, movement resumption, dead/reused generations, recurring incidents, error/history preservation and readable/structured API compatibility.

Clipboard-based automation proved unreliable during the session, including previously copied prompt text appearing in the console. Some accidental console input was submitted before the race was recognized. Verification switched to direct individual key events and recovered reliable command entry. A computer-tool notification also detected simultaneous user input, after which a fresh observation was taken. Console-only accidental input is distinct from AI runtime errors and must not be counted as a colony failure.

Ordinary traffic conflicts still happen near busy sources and the spawn, and replacement cycles can cause brief RECOVERY periods. Local healthy hauling capacity alone does not guarantee uncongested service. Remote W2N7 is selected, but new remote income, dangerous combat and mature expansion are not certified by this traffic audit. No warning was suppressed simply to make the dashboard look healthy.

## Final verification

**Measured window: 2,191,631 → 2,198,058 = 6,427 elapsed game ticks.** Multiple code/console snapshots and dashboard observations are listed above, with final checkpoints below. The conservative post-release interval starts at the **executed build receipt**, 2,196,399, rather than the earlier upload or revised-dashboard appearance: **1,659 additional ticks**. Both the 5,000-tick overall minimum and the 1,000-tick deployment minimum were exceeded. No wall-clock estimate substitutes for either tick count.

The explicitly started diagnostic lease ran **2,196,617–2,197,717**, with 50-tick cadence, then stopped with `EXPIRED`. It added **22 samples** to the recorder's pre-existing 20 (42 cumulative); 11 samples remained within its character budget. It skipped none and retained **zero exceptions**. The final report query at tick 2,198,058 confirmed the recorder OFF. The retained new samples cover ticks **2,197,168–2,197,668**.

Those samples contain late-tick CPU readings **22.37–43.07/100**, excluding final sampling/telemetry overhead, and completed-tick rolling EMA **32.78–42.11**. The baseline EMA was 29.61 with a smaller workload. Sampled dashboard buckets remained 10,000. This demonstrates headroom on this 100-CPU local server, not a controlled CPU optimization or sustainable 20-CPU public-world result. Probe sampling itself cost approximately 0.54–1.62 CPU on sampled ticks and is now OFF.

Six workers matched by **name and absolute expiry tick** across the retained 500-tick interval, fencing name reuse. Their delivered-energy counter increases were:

| Worker | Delivered energy increase |
| --- | ---: |
| Freighter_002 | 1,400 |
| Freighter_003 | 2,250 |
| Freighter_004 | 550 |
| Freighter_006 | 2,200 |
| Freighter_007 | 553 |
| Freighter_005 | 500 |
| Total for these six survivors | **7,453** |

This is actual cargo-delta flow evidence for those workers, excluding workers born/dying during the comparison. It is not total-colony profit or a before/after throughput benchmark. At tick **2,197,707**, all eight observed haulers had no more than one idle tick, surviving-worker delivered totals reached 17,572, and modeled healthy CARRY was 13 plus five spawning against 18 required. Controller progress reached **35,369**, compared with 17,705 at the early behavior snapshot. A later screenshot at **2,197,990** showed STABLE, roughly 81.9% RCL2 progress, backlog 413 and no no-progress workers.

The longer sample also exposed a limitation: several loaded haulers stayed at unchanged positions and delivery totals from tick **2,197,468 to 2,197,518**, while source backlog rose to 3,176. They resumed by the next samples. A temporary 8/10 WORK replacement gap was recorded at tick 2,197,218. Thus the original long-lived stationary-miner lane conflict was corrected, but **ordinary local crowding, incomplete lifetime-replacement continuity, small recovery bodies and backlog-driven RECOVERY episodes remain**. The warning display can still rise substantially during a real current incident; it was deliberately not forced to zero. Unresolved policy denials and unknown warnings remain available.

`Sushi.debug.report("W1N7")` was executed live at tick **2,197,431** and displayed readable colony/economy/mining/energy text instead of `[object Object]`; the structured API remained available for the subsequent verification query. The changed dashboard's hauling panel, recent-warning label and resolved-history count rendered throughout the post-release interval. Warning records were marked resolved through evidence-based reconciliation; no bulk history deletion was performed.

The final source fingerprint, **294 PASS checks**, all 116 runtime syntax parses and `git diff --check` were verified. The runtime backup remains in `validation/traffic-20261113/release/backup`. No public-server deployment occurred.
