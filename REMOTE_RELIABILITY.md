# Remote reliability follow-up

This pass supersedes the earlier convention of retaining invalid routes in
`activeSourceIds`. Durable portfolio and lifecycle history stays in `sourceInfos`;
`activeSourceIds` now contains only selected, operational sources. Economy exposes
`portfolioSources`, `selectedSources`, `operationalSources`, and `provenSources`;
its compatibility `activeSources` count now means operational sources.

## Scheduling and intel

The existing five-tick hashed scheduler remains. Planner heavy work, rescoring,
and debug output use elapsed `lastHeavyPlanAt` (75 ticks), `lastRescoreAt` (1,000),
and `lastDebugAt` (500) stamps, so scheduler phase cannot prevent them running.
Route validation retains its bounded queue and endpoint/revision invalidation.
Visible metadata refresh rotates two rooms per planner invocation using
`visibleRefreshCursor` and `lastVisibleRefreshAt`; heavy route planning rotates
one room per heavy pass using `routeRefreshCursor`.

ThreatLedger observes relevant visible HOME, candidate, historical remote and
transit rooms even when there are zero hostiles. Safe live vision overrides old
threat snapshots. Repaired routes set `selectionDirty` to restart selection.

Controller snapshots record `lastObservedAt`; reservation snapshots record
`observedAt`. Effective reservation ticks subtract elapsed time and expire.
Untimed legacy reservations require scouting rather than promising remaining
duration. Unseen ownership remains recorded, with `ownershipIntelStale` after
500 ticks. Rooms request the existing Scout through `intelRefreshRequestedAt`,
`intelRefreshReason`, and `intelPriority`. Scouts prioritize these requests over
ordinary rescans; fresh observation records `lastIntelRefreshAt` and clears them.
No durable source, delivery, ownership, or route history is discarded.

## Reservation and spawn admission

Annex requests for initial bootstrap use `remoteBootstrap`; reservation continuity
and established remote restarts use `remoteMaintenance`. Real claim expansion
keeps its expansion policy. Extractor/Freighter caps derive from approved work
and carry demand, retaining the configured floor and one replacement overlap.
Optional `spawn.economyRoleHardCaps` bounds default to 32 Extractors/64 Freighters.

Sources expose `currentNetEPT` and `projectedReservedNetEPT`. A currently negative
remote can bootstrap only with positive reserved income after Annex upkeep,
startup liquidity, payback within 1,500 ticks, spare spawn capacity, and an allowed
bootstrap spend. Each candidate conservatively pays its full Annex upkeep;
historical sources cannot subsidize it. Projected income is not realized income
and does not qualify the source for road investment.

`reservationBootstrap` moves through BOOTSTRAPPING, RESERVING, and ACTIVE once
reservation is observed. An admitted Annex records `reservationBootstrapStartedAt`
and `reservationBootstrapUntil`. During that bounded window, a matching queued or
living Annex preserves its already-funded bootstrap through temporary liquidity
loss. Route safety and economy gates continue to apply.

## Diagnostics and verification

Use `require('Planner.Remote').getDiagnostics('W1N1')` with the actual HOME name.
It reports portfolio/operational counts, scheduler stamps and per-source route,
current spend decision, miner queue, assigned carry, reservation age, intel
request, container, haul and delivery data. It derives a blocked reason rather
than persisting a second diagnostics snapshot. Source admission also records
`spendCategory` and `spendAllowed` for the most recent planner decision.

`test/remote-reliability.js` exercises the real hashed scheduler over 2,100 ticks,
safe-room recovery, invalid-only portfolio bootstrap, economy counts, RECOVERY
Annex admission, reservation aging/ownership retention, Scout priority, fair
metadata refresh, demand-aware caps, affordable reservation startup, committed
funding, historical-source cost isolation and current diagnostics. Existing route,
delivery, lifecycle and Season 11 suites remain part of `npm run validate`.

Live-shard tuning remains for the 1 EPT reserved margin, 1,500-tick payback,
0.5 spawn-pressure ceiling, 500-tick ownership refresh, intel priorities and
replacement overlap. Validate these against actual reservation continuity,
spawn queues, delivered energy, CPU and calibrated travel; mocked tests do not
establish live-shard throughput.
