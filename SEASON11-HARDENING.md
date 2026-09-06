# Season 11 recapture and startup hardening

Restoration note: the subsequent population-capacity preflight found clean main
at `0183985` contained this report only. The JavaScript changes were absent locally.
The population-capacity pass restores the behavior below and validates 55 Season
11 tests, including critical Reactor defense under exhausted optional CPU capacity.
See `POPULATION-CAPACITY.md` for the combined implementation and validation report.

## Defense assessment

The old observation counted every non-ally hostile structure except the Reactor.
Recapture used `combatThreat + supportThreat + hostileStructureCount * 20`, against
the unchanged default budget of 12. Separately, any nonzero structure count blocked
the claimant even if recapture was approved. Thus an Extension could block both gates.

Both consumers now use `defenseAssessment.totalThreat`. Military feasibility is
`combatThreat + supportThreat + totalThreat`; CLAIM, combat and healer presence
still independently block the fragile claimant. CLAIM/body classification is unchanged.

| Structure | Threat |
| --- | --- |
| Active hostile tower with at least 10 energy | `ceil(Combat.Math.towerDamage(tower, reactor) / 30)`; normally 5–20, including existing power-effect math |
| Non-public hostile rampart within Chebyshev range 2 | 15 each |
| Constructed wall within Chebyshev range 2 | 15 each |
| Distant barriers, public ramparts, inactive/empty towers | 0 |
| Extensions, links, storage, terminals, labs, extractors, containers, roads, observers, power spawns, factories, nukers, spawns and other infrastructure | 0 |

Own and allied structures and Reactors are excluded. Walls have no owner and are
read from the existing TickIndex structure collection. Missing tower store data is
treated conservatively as armed. Even a distant armed tower contributes threat:
tower coverage uses damage falloff, not a hard range cutoff. A low-scoring tower
may permit a combat mission, but the claimant still waits for defense clearance.

The range-2 barrier model deliberately approximates obstruction of the immediate
approach. It does not prove enclosure or find a path. It can conservatively reject
an isolated nearby barrier with an alternate approach, and miss a larger enclosure
outside that radius. Path-based siege feasibility remains outside this focused change.
An empty tower can be refueled after observation; fresh observation and the existing
combat system remain necessary. No live-server CPU or combat outcomes were measured.

## Startup reserve and risk audit

Previously the default null minimum fell back to `startupReserve = 500`.
Now the default minimum is 150, matching Reactor safety stock; existing null values
also resolve to 150. Explicit numeric minimum overrides remain effective.
The legacy `startupReserve` configuration remains for compatibility paths/alerts.

The formula remains ETA + replacement delay + rounded route jitter + safety stock
+ defense buffer. Negative numeric terms become zero, reliability is bounded to
0–1, invalid values use defaults, and extreme magnitudes saturate before arithmetic
to keep all returned numeric fields finite. Positive infinite ETA is infeasible.
Maximum is never below minimum or safety stock. A capped display/reservation amount
does not imply safety: `required > maximum` still returns `feasible: false`, and the
claim gate requires feasibility.

Examples with safety stock 150:

- ETA 25, replacement 30, round trip 60, reliability 1: reserve 211, formerly 500.
- ETA 250, replacement 150, round trip 500, reliability 0.9: reserve 650.
- ETA 1500 with the default maximum 1000: infeasible.

Each existing threat use has a distinct meaning:

- **Reliability:** probability/timing risk. Recent hostile traffic subtracts 0.2
  and nearby hostile ownership subtracts 0.1. Reliability discounts throughput
  and increases route jitter; it is not a multiplier on military defense.
- **Startup defenseRisk:** an additive fuel buffer, one extra tick per current
  ownership-threat point. Added once per route reserve calculation. Multiple
  allocated routes use the worst reserve, not the sum of their defense buffers.
- **Recapture enemyDefense:** military feasibility and the existing utility risk
  component. The hard budget and utility gate express different acceptance limits;
  neither feeds back into route reliability or reserve calculations.
- **defenseTier:** whether to station/react with defenders at an owned Reactor.
  It does not add a second reserve penalty.

The existing scales are retained. For example, 60 ownership-threat points add 60
fuel while recent traffic adds 0.2 times round-trip duration to jitter. This is
additive protection against interruption, not repeated multiplication of 60.
Route reliability and defense buffers refresh on portfolio rescoring; current
military/CLAIM gates update from fresh observations independently.

## Manual code traces

1. `observeRoom` / `refreshVisibleReactor` -> `observeReactors`: reuse hostile
   structures and indexed walls, exclude allies/self, classify defenses relative
   to each Reactor, and store current plain diagnostics. `refreshPortfolio` adds
   creep combat/support threat to structural threat and calls `Portfolio.recapture`.
   Budget refusal includes TOWER/BARRIER; approved combat still gates the claimant.
2. Mining assignment -> `makeHaulerPlan`: route tiles and aging lifetime determine
   ETA/reliability; body spawn time, replacement margin and home spawn pressure
   determine replacement delay. `startupReserve` determines the worst allocated
   route's reserve and feasibility. Shared `reserveFuel` grants fuel without double
   spending. `pipelineReady` checks live mining WORK and reliable hauling capacity.
   Final `claimReady` requires reserve, feasibility, throughput, fresh vision,
   capability, cooldown clearance, live pipeline and no remaining military threat.
3. Theft observation retains `everMine` and `priorContinuousWork` and records loss.
   Infrastructure is assessed as above. Eligible previously owned Reactors can
   receive allocations/reservations before ownership. A profitable target without
   live supply enters `recapture.preparing`, retains its active allocation and
   emits hauling preparation. Staffing that pipeline permits recapture approval;
   clear military/CLAIM gates permit the per-Reactor claimant request. There is no
   ownership prerequisite for this preparation. The observed-theft regression
   explicitly exercises preparation, staffing and claimant emission.

## CPU, Memory and diagnostics

No new pathfinding or independent per-Reactor room scans. Full observations reuse
their hostile collection; refreshes collect hostiles once for all room Reactors.
Walls come from TickIndex. Harmless structures are filtered once, then each Reactor
checks the defensive candidates with constant-time range/damage math. Only barriers
within range 2 contribute. Cost is O(structures + Reactors * defensive candidates).

One fixed-size current assessment replaces the old count, plus two scalar portfolio
and dashboard fields. No history arrays or growing caches. The existing HUD row
shows, for example, `DEF 20 TOWER CLAIM 0 COMBAT 0`. An illustrative Memory value is:

```js
defenseAssessment: {
  totalThreat: 35, towers: 1, relevantRamparts: 1,
  relevantWalls: 0, harmlessStructures: 14, reason: 'TOWER+BARRIER', tick: 12345
}
// recapture.reason: 'enemy defense exceeds Season combat budget: TOWER+BARRIER'
```

Multi-Reactor allocation, reservations, source budgets, continuity priorities,
backoff and maxActiveReactors=1 remain intact. No changes to expansion or general
energy, remote, spawn, movement or combat behavior.

## Regression coverage

Focused tests cover observed theft with many harmless structures, armed/empty/
inactive towers and falloff, local/distant/public/ally barriers, indexed unowned
walls, default/legacy-null short reserves, long and infeasible routes, malformed
numeric inputs and claimant preparation. Existing multi-Reactor allocation,
shared reservation, combat/CLAIM, low-CPU and claimant-backoff tests remain in place.

Validation performed on 2026-09-06: `npm run test:season11` passed (55 tests);
`npm run validate` passed, including all existing suites, module graph, movement
audit and Season 11. Explicit `node --check` passed for all four changed JavaScript
files. `git diff --check` passed. These are Node/mock checks, not a live Screeps run.

Files changed: `Logic.Season11.js`, `Season11.Portfolio.js`, `Visual.Dashboard.js`,
`test.Season11.js`, and this report. Work remains on the current `main` branch.
