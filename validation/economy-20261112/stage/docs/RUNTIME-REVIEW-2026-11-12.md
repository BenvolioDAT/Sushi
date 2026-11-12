# Live runtime review - November 12, 2026

## Result

Inspected the running local Screeps desktop and compared the active `Sushi` branch with local source before deployment. Baseline tick 763085 matched all 114 modules of build `507ba4c0...`. The colony had reached RCL6, although spawning capacity remained 1,800. No new role exception was present: the retained Annex error still had its historical tick 642475 and count 100370.

Fixed two threat-reporting bugs and one diagnostic-toggle bug:

- Source Keepers had a distinct `SOURCE_KEEPER` classification but aggregate counting treated every classification except `npc` as human. Live W6N4 reported four human threats, zero NPCs. Keeper threats now count as NPCs, retain a separate `sourceKeeperCount`, and remain excluded from ordinary automatic defense. Refreshing cached intelligence repairs these totals without pretending to have new vision.
- Missing critical-target proximity is represented by null. JavaScript's `null <= 3` made remote Keeper rooms report an emergency. Only a finite measured range within three tiles, or an actual recorded attack, can now trigger that emergency flag. Real nearby-hostile defense is covered by regression tests. Danger and civilian exclusion remain separate and stay active.
- Nested operation profiling still sampled every 25 ticks with diagnostics OFF. OFF now bypasses that sampling while returning the wrapped operation's normal result.

## Temporary diagnostics

Added `Diagnostics.Probe`, default **off**. The existing blackbox and operational CPU governor retain their established settings. The new probe does not issue gameplay actions or change policy.

```js
// Enable one room for 500 ticks, one sample every 25 ticks.
Sushi.debug.probe(true, {room: "W7N4", duration: 500, interval: 25})

// Current switch, expiry and collection status.
Sushi.debug.probe()

// Read retained samples and opt-in exception stacks.
Sushi.debug.probeReport()

// Stop collection immediately; keep the bounded evidence.
Sushi.debug.probe(false)
```

Room names are arguments to a reusable tool, not runtime target checks. Without a room argument, it rotates among at most three visible owned rooms. Duration is capped at 2,000 ticks and interval has a ten-tick minimum. It retains at most 20 samples/eight exception records and 30,000 serialized characters; large samples reduce the retained count. It deduplicates repeated exceptions and retains stack text up to 1,600 characters only while enabled. Sampling skips when current CPU exceeds 80% of the account limit. Expiry, tick rollback, manual OFF or master diagnostics OFF stops collection. Disabled collection performs no scans, CPU reads or Memory writes. Retained evidence can still be read after OFF.

Samples show economy freshness/reasons, actual source WORK and backlog, local/remote CARRY coverage, spawn admission, hauler positions/cargo/assignment/flow counters, CPU and historical-error age. This distinguishes old errors from current failures and physical hauling progress from nominal capacity.

## Live findings and limits

The temporary live probe started at tick **764594**, with a 1,000-tick expiry and ten-tick sampling interval. Build `6c9f2a87...` was independently executed through the desktop console; server snapshots matched all 115 modules. At tick 765246 it had collected 66 samples, retained 14 within 29,811 characters and captured no exceptions. Sample collection usually cost roughly 0.2-0.7 CPU on sampled ticks; this is diagnostic overhead, not a gameplay speed improvement. The default 25-tick cadence costs less than the temporary ten-tick audit setting.

The hauling recovery warnings are not simply an exception or a false threat count. At tick 764595, healthy local CARRY was 21 against required 21, but local source backlog was 2,483 energy; one source had over 2,200 including spill. Around 764655, an aging 12-CARRY worker left healthy coverage, and a replacement request subsequently appeared. The colony later returned to STABLE, then source backlog rose again while nominal CARRY remained covered. Remote CARRY remained zero despite staffed remote sources. Local delivery workload, replacement continuity and remote admission need further economic work; this release does not relax those safety gates or claim the remote bottleneck is solved.

The two old lesser-core records now show visible-disappearance completion. Their removal is not attributed to a Sushi victory: a completed observation alone cannot establish a kill. Keeper operations remain unaffordable and civilian admission stays closed.

## Validation and release evidence

The complete suite passes **238 PASS checks**: the previous 226, eight new diagnostic scenarios, and four new threat-summary regressions. The module graph has 115 reachable modules and zero cycles; movement ownership remains valid. Focused tests verify disabled no-work behavior, automatic expiry, retained-history bounds, rollback, CPU skipping, independent normal error recording, NPC/player separation, unchanged Keeper engagement exclusions and legitimate proximity emergencies.

Final build: `57b0fa09ad95782c9c9ab82f330bc74cad8dc1cc673237184c3a4ab18080bef6`. Deployment receipts, matched server snapshots, retained probe evidence and test logs are in `validation/audit-20261112/runtime-review-*`. Recoverable runtime backups are in `validation/deployments/runtime-review-*/original`. Only the verified local branch is targeted. Final live observations and the final switch state are recorded in `runtime-review-verification.json`.

Final desktop confirmation at tick **765998** returned that exact fingerprint, `probe:false`, four NPC threats, zero human threats and `emergency:false` for W6N4. Server snapshots **765883/766130** matched all 115 modules. The probe expired automatically at 765594 after 99 samples; its last collected tick stayed **765585** and its count/history stopped changing through 766130. It retained 14 samples in 29,985 characters and no exceptions. Keeper threats remained non-actionable to ordinary defense. The historical Annex error counter remained unchanged and recent retained blackbox entries contained no new errors. Tests ran on the exact runtime bytes deployed, verified by complete inventory comparison; all 115 modules also compiled successfully.
