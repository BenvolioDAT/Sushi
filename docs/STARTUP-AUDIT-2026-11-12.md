# Sushi local startup audit — November 12, 2026 (US Eastern)

## Scope and release

The desktop client's **Open local folder** opened `C:\Users\xbenv\AppData\Local\Screeps\scripts\192_168_0_217___21025\Sushi`. Its console reported the matching 116-module baseline build `4d8b6c0841cde31ab8008c1edfaebf412d65d25620e5ccb06e0108790178f85f` at tick 2,181,282. This session's verified target supersedes the different local-folder ownership recorded in historical reports. The requested IP folder is the only runtime destination changed in this audit. The public-server deployment command was not used.

The correction changes `HiveMind.MemoryGC.js` and generated `Runtime.Build.js`, producing build `744e6480d2d774a20a97302b4ad03134cee7c3d2e64d089b238c234e3e55ffa3`. The full pre-change runtime, source hashes, isolated test copies, validation logs, release plan and recoverable deployment backup are in `validation/startup-20261113/`. The release checked source drift, staged build identity and every destination runtime byte. No Git reset, respawn, creep kill, manual economy repair or hostile injection was performed by the auditor.

## Confirmed defect and correction

`HiveMind.MemoryGC.protectedRooms()` used its growing set of protected rooms to decide which rooms could protect their own remote portfolios. Consequently a former colony, correctly reclassified as INTEL, became a remote parent again if a current route crossed it or an active/suspended NPC mission protected it. Its obsolete planner then indefinitely protected unrelated remote intelligence. This depended on strategic references and, for transit protection, room enumeration order.

The root home-room set is now separate from the derived protection set. Current homes, HOME/OWNED_BOOTSTRAP identities and visibly owned controllers can still protect their selected/active/established source routes. A room protected only as remote/transit/mission intel cannot use its historical planner to protect additional rooms. Existing intel age thresholds and sweep budgets remain unchanged; durable layouts/planners and remembered dangers are retained. This introduces no schema changes or new persistent Memory fields.

Two new regressions reproduce the transit and suspended-mission cases. The transit test failed on the original code and passed with the correction. Existing tests retain ordinary remote/transit protection, established suspended remote protection, abandoned-home cleanup and owned rooms without spawns.

A suspected mature-colony lifecycle defect was ruled out: the existing transition already permits MATURE to BOOTSTRAP. Three added lifecycle decision scenarios verify immediate workforce-collapse recovery, spawn loss and normal hysteresis/stepwise recovery with mocked economy/index inputs. No lifecycle production change was needed.

## Live startup evidence

Observation began after the user's respawn; the initial spawn action itself was not observed. The dashboard first showed tick 2,181,120. Console snapshots use actual `Game.time`, independently of wall time.

| Tick | Colony evidence | CPU completed-tick EMA | Other evidence |
| --- | --- | ---: | --- |
| 2,181,282 | RCL1, progress 0, BOOTSTRAP/RECOVERY; 9/10 local WORK, 7 active local miners | 28.22 / 100 | 17 local Freighters; source-specific harvest health blocks controller growth |
| 2,181,348 | Still RCL1; source upgrade cooldown; spawn fills to 300 | — | 17/17 local CARRY, zero remote CARRY demand; two planned source containers; 50 sites including 48 low-priority sites |
| 2,182,369 | RCL1 progress 100; 10/10 active and physically stationed WORK, estimated income 20/20 | 32.56 / 100 | 8 Freighters retain 17/17 CARRY; Tech and Scout present; replacement staged while incumbent continues mining |
| 2,182,867 | RCL2 progress 43; GROWTH lifecycle, healthy local harvest | 38.10 / 100 | 11 visited rooms in new Scout plan; 42 remembered rooms; 500,096 serialized Memory characters |
| 2,183,828 | Running corrected build confirmed in console | — | Bounded 500-tick probe enabled until 2,184,328; retained error query returned an empty array |
| 2,184,364 | RCL2 progress 2,315; capacity 550; probe expired normally | 38.80 / 100 | 18 visited Scout rooms; 530,781 Memory characters; no probe errors; selected remote W2N8; no measured remote harvest/delivery |

These observations preceded or bracketed the small GC release; the mining upgrades, hauling consolidation, Scout exploration and RCL2 growth are evidence of existing functionality, not benefits attributed to the GC fix. The initially fragmented fleet improved through normal replacement and miner handoffs. Brief returns to RECOVERY occurred during replacements and retained their confirmation delay; this alone is not a deadlock.

## Systems reviewed and limits

- Tick phase boundaries keep creep execution, traffic and final telemetry independently reachable after a planner failure. Bootstrap failure stops dependent work. Diagnostics are bounded and retain error age/context; a quiet console alone is not a health check.
- Economy owns harvest/transport health and spending. Harvest planning tracks per-source WORK, seats, stationed production, incoming work and bounded upgrade handoffs. Incoming or excess work on another source cannot falsely satisfy an uncovered source. First recovery bodies may be small; later replacement can enlarge/consolidate them.
- Spawn producers, policy, capacity admission and execution retain separate ownership. Useful ordinary bodies can wait briefly for energy; recovery preserves income first. This audit did not rewrite these systems or raise population/CPU limits.
- Source/controller container policy and logistics reservation tests cover duplicate placement and worker claims. Live source plans had one canonical container position per source. Mature built-container delivery and every abandoned room were not certified from those plans.
- Scout fairness and progress-watchdog tests cover repeated intel priorities and successful-intent oscillation. Live exploration advanced beyond the home. Remote plans existed, but profitable remote extraction/delivery and second-colony claiming were not established in the sampled early economy.
- Invader, core, stronghold, Keeper visibility/coverage, retreat, ranged standoff and civilian admission policies were inspected and exercised by existing automated tests. Live NPC operations were safely deferred for unavailable vision or homes outside range. No live battle, core kill, stronghold victory or profitable Keeper economy was observed; RCL2/300-energy capacity cannot field the standard 5,000-energy Keeper guard.
- Cleanup uses domain-specific retention, current strategic references, bounded sweep work and dead-creep deletion. Remembered rooms retained across respawn are not all disposable. No blanket age-based wipe or Memory reset was applied.

## Remaining weaknesses

Early startup creates many small workers before affordable replacement consolidates them; this costs CPU and traffic. Harvest health gating delayed the first Tech but subsequently resolved without intervention. Movement-block warnings persisted near crowded stations. Fifty early construction sites include many roads, and essential container completion should continue to be checked against those jobs. Early remote route decisions repeatedly reported `DESTINATION_CHANGED`; successful remote income still needs a longer mature-economy observation. Memory size and CPU samples reflect changing workloads, not a controlled leak or speed benchmark. Sustained public-world operation at 20 CPU and autonomous combat/late expansion remain unverified.

## Final verification

The exact console window was **2,181,282 → 2,184,364: 3,082 elapsed game ticks**. Including the earlier dashboard tick 2,181,120 gives 3,244 ticks, but the stricter console interval is used for the headline. At least 536 ticks elapsed between the corrected-build receipt and final console snapshot. This is observation of the running colony across spaced samples, not a trace of every action on every tick.

`npm test` passed **280 checks before changes** and **285 after changes**. The increase is two GC regressions plus three lifecycle decisions. All 116 runtime files passed syntax parsing; module resolution/reachability, zero dependency cycles, movement ownership and deployment safeguards passed in the suite. `git diff --check` passed. Logs include the intentionally failed pixel-generation fixture; its failure is expected and its backoff test passes. Existing unrelated local changes were preserved.

The desktop console confirmed build `744e6480d2d774a20a97302b4ad03134cee7c3d2e64d089b238c234e3e55ffa3` at tick 2,183,828. The 500-tick diagnostic lease collected **20 samples**, retained the last ten within its character budget, skipped none, recorded **zero exceptions** and switched OFF with `EXPIRED`. The retained samples span 2,184,079–2,184,304 and all report 10/10 local WORK. Their late-tick CPU readings range **29.18–49.37**, before final telemetry overhead; corresponding rolling EMA samples range **34.00–45.14**. The initial/final completed-tick EMA values were 28.22/38.80, with a 100 CPU limit and full 10,000 bucket at reported checkpoints. Workload grew, so these are not speedup claims or measurements of every possible CPU spike.

At tick 2,184,358 GC processed its configured 25 records, removed zero in that slice and retained a pending sweep cursor. This verifies continued operation, not natural triggering of the newly covered historical-planner edge case. Serialized Memory grew by 30,685 characters between ticks 2,182,867 and 2,184,364 while scouting and infrastructure expanded; neither leak freedom nor a memory reduction is established.

Remote accounting at tick 2,184,364 covered 1,865 sampled ticks and reported zero harvested/delivered remote energy. Selection changed from W2N7 (modeled distance 70) to W2N8 (121). A selected plan is not an operating remote mine. The final remote-admission and built-container query could not be completed because the desktop interface stopped reliably accepting console input, despite continuing to render game updates. Focus restoration and refresh attempts did not restore reliable input. No speculative remote-policy correction was made without the missing execution evidence. The last successful probe was already expired/OFF; no indefinite recorder remains enabled.

Sushi demonstrated local startup growth, recovery/replacement, basic construction/upgrade progress and expanding intelligence. **Autonomous remote profitability, claiming, dangerous defense, stronghold assaults, Keeper commissioning and mature end-to-end autonomy remain uncertified.**
