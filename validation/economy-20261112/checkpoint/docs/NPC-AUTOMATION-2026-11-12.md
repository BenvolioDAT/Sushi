# Automatic NPC operations - November 12, 2026

## Deployed result

Automatic, staged Source Keeper operations and conservative level-zero Invader Core clearance are enabled on the verified local server's `Sushi` branch. This supersedes the manual-patrol limitation in the earlier Keeper audit. Ordinary Invader defense retains its existing ThreatLedger owner. Player attacks and stronghold assaults have not been enabled by this change.

The final runtime fingerprint is `507ba4c0040d5e1a1563b4dcdf2d83f274ef05450c26cc3c36edb497ada2c7c5`, with 114 modules. Root JavaScript is uploaded by the established local client workflow. Original runtime bytes and subsequent follow-up backups are under `validation/deployments/npc-auto-*/original`; the deployment receipt is `validation/audit-20261112/npc-auto-release.json`. No public-server folder, world reset, hostile injection, manual Memory deletion or structure destruction was involved.

There is no W6N4 literal in runtime JavaScript. The running AI independently discovered Keeper candidates **W6N4, W6N5 and W5N4**, and lesser-core candidates **W6N3 and W5N3**, through its existing remembered/scouted room intelligence.

## Keeper rollout and civilian safety

`Keeper.Operations` owns the sequence:

1. **Assess:** confirm current vision, standard Keeper profiles, reachable source seats, canonical route/container geometry, replacement costs, spawn occupancy and income after displacement of ordinary remotes. Geometry preparation creates Memory plans, not construction sites or civilian admission.
2. **Assemble:** request one fixed guard per energy lair. Every required guard must actually exist before departure; queued or spawning units cannot authorize deployment. One funded Keeper portfolio per home competes with core operations for the combat budget.
3. **Clear:** deploy the complete force, retain fixed lair assignments, kite at range three and self-heal. Unexpected NPCs, damage, home defense needs, inadequate lifetime or missing authorization cause withdrawal. Unproductive attacks and premature losses back off rather than creating endless waves.
4. **Guard:** require actual healthy coverage at every energy resource and 25 consecutive verified secure ticks.
5. **Mine:** admit the complete source group and seven-WORK miners; retain one canonical source container/station per source.
6. **Haul:** open hauling only after miners physically occupy all source stations with sufficient WORK. Once commissioned, normal short miner evacuation windows do not repeatedly dismantle the hauling fleet. Whole-operation suspension or guard loss closes admission again.

The standard unboosted guard is **20 MOVE, 10 RANGED_ATTACK, 10 HEAL: 40 parts, 5,000 energy**. It supplies 100 ranged damage and 120 self-healing per tick before part loss. Current coverage conservatively requires one guard per energy lair; a single roaming guard has not been certified for several separated lairs. Mineral protection is excluded from the automatic energy business case.

`Keeper.Intel` retains bounded lair/resource IDs, positions, current countdowns, absolute spawn estimates, active Keepers and separate hostile/core signals. Resources within five tiles are associated conservatively, including overlap. A living Keeper overrides a timer. Unknown countdowns and stale vision cannot establish safety. Per-source windows budget approach, work/loading, actual terrain/body evacuation time and ten ticks of margin. This can stop work even while a guard is present: protection is not permission to ignore an imminent spawn.

`NPC.Policy` revalidates stages, physical guards and fixed bodies at spawn execution and civilian entry. Existing retreat, partial-load delivery, reservation and movement ownership remain in place. Guard death cancels requests and closes civilian gates; repeated early losses produce exponential cooldown and eventual abandonment. Active operation rooms/routes are protected from ordinary stale-intel cleanup.

## Lesser cores and fixes found during validation

`NPC.Operations` accepts only a currently visible, unopposed **level-zero Invader-owned core**, with no deployment/invulnerability, hostile towers/ramparts/walls or armed/healing defenders. Harmless Invader reservers are permitted. It requires an economic interest, stable funding, a safe route and enough lifetime to travel, destroy the core and return. A new expedition also requires 100 consecutive ticks in its current healthy economy state, preventing brief recovery exits from financing forces that immediately need recall. Existing forces may resume when safe. Its fixed **6 MOVE + 6 ATTACK** Ronin costs 780 energy and deals up to 180 melee damage/tick. A WORK breacher is not used against the core.

Existing queue cleanup could erase specialized defense requests; it now preserves mission-owned requests. Fixed-body and execution checks prevent weak substitutes. Keeper planning no longer charges its own queued force twice or deadlocks hauling admission against its own newly requested CARRY. Economy's earlier tick ordering is handled by a one-tick forecast allowance with current physical protection; actual actions still require current authorization. Ronin no longer self-heals in attack range in a way that suppresses melee in this engine.

Live observation exposed Scouts leaving before a staged force arrived. A funded assembly/deployment temporarily retains safe Scout vision until a combat unit supplies it; unfunded discovery does not pin the Scout. A live core attempt also exposed a progress clock spanning authorized pauses. Leaving CLEAR now removes that clock, so recovery/vision pauses do not count as failed attacks. Continuous stalls still trigger cooldown. A body that ultimately expires without clearing its target consumes the retry budget as well: safe pauses cannot fund endless natural-expiry replacements. Three failed attempts stop automatic retries for that same core. No previous failure counters were manually cleared.

## Evidence and limits

The complete `npm test` suite passes **226 PASS checks**, including **34 new NPC automation scenarios**. These cover real request production/queue cleanup, arbitrary rooms, full-force staging, canonical preparation and atomic source selection, fixed seven-WORK miners, phase admission, guard death, vision loss, mixed threats, economic rejection, hauling stability, actual target intents, Scout observation and pause-versus-stall behavior. Module graph: 114 reachable modules, zero cycles. Movement audit: 15 sites with valid ownership.

Three additional isolated checks execute the installed engine's combat processors with fixed positions and no world writes:

| Fixture | Result | Interpretation |
| --- | --- | --- |
| Standard guard versus Keeper at range three | Keeper destroyed in 50 ticks; guard retains 4,000 hits | Supports ranged/self-healing body choice |
| Same guard forced to range one | Guard dies in 14 ticks; Keeper survives | Kiting and retreat are essential |
| Ronin versus unopposed 100,000-hit core | Core destroyed in 556 ticks | Supports ATTACK body and lifetime budget |

These fixtures do not prove terrain navigation, traffic, formations or a live victory. The preceding Keeper audit also records eight installed-engine lair/action mechanics checks, including this server's countdown behavior. Accelerated ticks do not change these mechanics.

Server snapshots at ticks **679994, 680819, 682427, 683609 and 684695** showed all 114 uploaded modules matching the corresponding deployed source. The desktop independently executed build `edb984fa...` at tick **683564**; subsequent corrections are identified by the final fingerprint above and the final verification receipt. Three Keeper operations consistently deferred with `GUARD_BODY_UNAFFORDABLE`: current home W7N4 is RCL5 with **1,800 capacity**. No Keeper mission guards or mining fleet were released. A core attacker did assemble naturally, then withdrew intact as authorization closed; no live core destruction was observed. A subsequent natural-expiry replacement prompted the bounded-attempt and sustained-economy corrections. Its recorded stall cooldown was retained, with future pause accounting corrected.

The ordinary remote economy remains constrained: snapshot 683609 reported healthy remote CARRY 0 versus required 128, and 14,143 energy of backlog. The home was in RECOVERY. These are reasons to defer expansion, not evidence of profitable Keeper mining. New `npcOperations` CPU samples were approximately 0.285-0.299 CPU while deferring, against total completed-tick samples around 31-35 CPU and a 100 CPU limit. Funded operation CPU has not been benchmarked. Memory length varied from 288,644 to 306,175 then 290,443 characters; this short interval does not establish a long-term leak or its absence.

**Final release verification:** the desktop console returned the complete final fingerprint at tick **685576**. Snapshot **685652** independently matched all 114 modules, kept the three Keeper operations deferred, and recorded the surviving core attacker at home with full 1,200 hits. Its operation was unfunded; the other core lacked vision. New NPC planning used about **0.326 CPU** in the recorded completed-tick sample, total CPU about **37.02**, bucket 10,000. Memory was 283,801 characters. Recent retained blackbox entries contained no ERROR/CRITICAL events; the historical Annex error record remained unchanged at tick 642475/count 100370. These bounded diagnostics do not prove there were no historical errors or that the remaining ordinary economy is healthy. The verification receipt records seven snapshots and the final test/build checks.

Follow-up snapshots **685962/686069** also matched the final runtime. Natural ordinary-Invader activity produced an automatic `defend:W8N3` operation with Volley/Cleric bodies; the Volley had advanced into W7N3 by 686069. Owned-room defense was recorded complete after live safety returned, but kill attribution was not established. The remote operation was recovering when target vision disappeared. This verifies automatic response/spawning and partial deployment, not a remote combat victory or coordinated-squad certification. The core attacker remained intact at home near natural expiry; unfinished-expiry accounting is deterministically tested and is reconciled when the target is next visible.

## Combat readiness

| Scenario | Current capability | Verification | Limitation |
| --- | --- | --- | --- |
| Ordinary NPC Invaders | Existing automatic defense retained | Automated policy regressions; live automatic defense/spawning and partial deployment | No attributed remote victory; economy and vision gates still apply |
| Level-zero Invader Core | Automatic unopposed clearance | Decision/intent tests, isolated engine kill; live assembly/withdrawal | No live victory; rejects defended cores |
| Source Keepers | Full-force staged patrol and civilian commissioning | Automated stage tests and fixed-range engine battle; live safe deferral | Current home cannot afford guards; terrain combat/mining unverified live |
| Low-level strongholds | Classified and excluded | Automated rejection | No siege force or assault controller |
| Mid/high-level strongholds | Currently infeasible for this implementation/colony | Rejection tests, no assault | Missing boosted coordinated siege, tower/defender adaptation and certified sustain |
| Remote room defense | Ordinary defense plus protected Keeper stages | Automated safety decisions | Mixed Keeper/Invader rooms suspend instead of launching combined arms |
| Coordinated squads | Fixed per-lair assignments and full-roster departure | Automated staging | No shared-patrol or multi-unit siege certification |
| Retreat and recovery | Recall, civilian windows, cooldowns and resumption | Automated tests; live intact core withdrawal | Keeper guard-loss recovery not exercised live |

## Remote operations assessment

| System | Improvement | Verification / remaining constraint |
| --- | --- | --- |
| Room selection | Reusable discovery, capacity/profit/spawn/displacement gates | Three Keeper rooms discovered live; no hardcoded target |
| Mining | Seven-WORK single-seat-safe requests after secured coverage | Automated; no live Keeper production |
| Containers | Adopt or plan one canonical station before construction release | Geometry tests; no Keeper infrastructure built live |
| Hauling | Stage after stationed miners; stable operation latch and source safety windows | Automated; no live Keeper deliveries |
| Hauler population | Peak production and terrain-aware round trips determine CARRY | Automated budget checks; road improvements need runtime measurement |
| Threat response | Actual coverage, active Keeper/timer checks, immediate suspension | Automated; live unaffordable operations remain closed |
| Recovery | Loss detection, request cancellation, retry cooldown, renewed secure stages | Automated; live core pause/withdrawal observed |
| Economic efficiency | Guard/miner/hauler lifetime, maintenance, spawn share and displaced income included | Modeled only; current ordinary hauling deficit prevents certification |

The automation is deployed and enabled. The current colony correctly refuses an unaffordable Keeper operation. A future affordable, profitable operation can progress through the stages without a room-specific edit; actual Keeper commissioning and combat must still be verified when those conditions naturally exist.
