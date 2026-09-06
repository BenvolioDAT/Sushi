# Season 11 strategy audit (before implementation)

Discovery is feature gated through Season11.Adapter. Scouts and the bounded visible-room scan record finite Thorium deposits and Reactor snapshots. Depletion remains sticky. Mining ranking excludes stale/hostile/foreign rooms, prefers remaining yield, then distance. The planner selects up to maxMiningRooms; actual mining requires an owned room, active extractor and staging store.

Logic.Season11 stores one selectedReactorId/Room. Reactor ranking prefers owned, then unowned, then short safe routes. Every mining assignment generates a haul route to that one Reactor. Haulers have full mobility, use tile-total logarithmic aging, and reject routes exceeding their loaded lifetime. Spawn planning checks essential economy and bucket; DemandBoard and the economy arbiter protect core local capacity. Startup uses a global fixed reserve (including unassigned transit) and any viable haul route, rather than reserved per-Reactor supply.

Season11.Operations mirrors mining, hauling and one Reactor into HiveMind operations. It uses HiveMind.Utility but continuity has no explicit next-tier urgency. Owned Reactors enter SUPPLYING/HOLDING; observed threats request a duo, larger threats request a quad. No quiet-room standing readiness exists. Threat parts omit CLAIM. Loss returns cargo and enters RECOVERING, or CONTESTING under the legacy manual recapture boolean. Combat.Policy rejects allies; the legacy boolean is an explicit offensive directive. Claim requests have a fixed delay but no claimant-loss backoff.

ThoriumMiner harvests until depletion or full cargo, then stages locally. ThoriumHauler refuses foreign/unclaimed Reactors and returns cargo; ReactorClaimer calls the feature-detected adjacent claim intent. Staging drains after depletion; missing operations recover and eventually complete. HUD/diagnostics summarize the primary Reactor and global stores/ETA. Generic minerals and terminals exclude seasonal Thorium. Memory migration already places runtime under hive.season.season11 and settings under config.season11.

Integration constraints: preserve the economy's ACTIVE/SPAWNING/QUEUED distinctions, do not grant Season combat the owned-room emergency bypass, retain shared travel wrappers and acyclic module graph. A portfolio must drive spawn plans, role withdrawal permissions and every operation, not merely display extra candidates.

# Implementation report

## 1. Architecture before

The audit above was recorded before implementation. One selected Reactor controlled all claim and haul plans, operations, reserve checks, and HUD output. Mining filled a fixed room cap. Recapture was a boolean directive; claimant losses did not accumulate failure cost.

## 2. Architecture after

Season runtime schema 3 adds `reactorPortfolio`, per-Reactor route allocations and `thoriumReservations`. `selectedReactorId` and `selectedReactorRoom` remain compatibility aliases for the primary supported Reactor. Reactor and hauling operations are generated per Reactor. Spawn plans carry exact Reactor/source IDs. A small independent `Season11.Portfolio` module contains policy math and uses `HiveMind.Utility`.

The default `maxActiveReactors` is **1**. Raising it to 2 enables capacity assessment and execution for two Reactors; it does not force two captures. Existing configured mining caps remain intact. The default cap for newly initialized settings is now 5, with dynamic selection below it. An existing cap of 2 may still constrain an empire below two sustainable Reactors.

## 3. Defense policy

For positive work, `rate = 1 + floor(log10(work))`; zero work retains the existing zero scoring convention. The next threshold is `10^rate`. For work >= 10, tier urgency rises linearly from 0 to 30 within the final 15% of a tier. Continuity value is:

`clamp(12 * rate + 6 * log10(work + 1) + tierUrgency, 0, 100)`.

Potential lost score integrates score tiers over a 1,000-tick horizon and compares continued work with restarting. Historical **our** work is preserved for recapture; enemy work does not substitute for our investment.

- NONE: low value, no threat and short response. Work 20 with a short safe route does not station combat.
- WATCH: value >= 45, slow response, known nearby hostile ownership, or readiness blocked. A targeted Scout can maintain vision.
- READY: value >= 65 with healthy economy and combat readiness. A small responder stays at its home colony. Work 5,000 qualifies without visible enemies.
- HOLD: current CLAIM/combat threat, or value >= 80 combined with near-tier urgency, prior loss or route/nearby threat. The responder positions near the Reactor.

The interceptor uses two RANGED_ATTACK and two MOVE parts, targets CLAIM creeps first, never attacks structures, and returns home when a fight is too dangerous. Escorted threats use the existing duo. A quad is considered only for high-value owned defense, bounded threat, low spawn pressure and a 5,600-energy-capacity home. Automatic recapture refuses expensive defended targets rather than automatically escalating to a quad. Existing squad movement, readiness and retreat behavior remain responsible for squad execution.

## 4. CLAIM threat

Each non-ally CLAIM part contributes 60 ownership-threat points within range 5 of the Reactor, otherwise 35. ATTACK/RANGED_ATTACK/WORK contribute combat threat; HEAL contributes support threat and doubles its ownership contribution when accompanying CLAIM. Boost presence is conservatively charged at a maximum multiplier. Damaged body parts do not count. Only compact current totals and a claimant target ID are stored. The Reactor itself is excluded from hostile-defense structure counts.

## 5. Recapture policy

New settings default to `recaptureMode: 'auto'`. `disabled` refuses recapture. `manual` requires the legacy explicit `recapture: true` directive. Existing legacy true settings migrate to manual mode.

AUTO requires all of the following:

- Previously ours, fresh visible target intel, and no ally owner.
- Combat.Policy permits offense without inventing a manual directive. Observed theft records a diplomacy incident, while ally classification remains authoritative.
- Healthy home economy, controller downgrade margin, storage energy, combat readiness and spawn pressure below 0.75.
- Verified viable routes, allocated sustainable throughput >= 1/t, sufficient reserved startup stock, and feasible startup bounds.
- At least `max(1500, 2 * startupReserve)` remaining assigned Thorium.
- Continuity value >= 45, positive utility margin >= 35, and enemy defense within the configured budget (default 12).
- No active backoff and fewer than three failures within the failure window.

A profitable candidate without live workers enters pipeline preparation: miners and haulers can assemble safely before offense. Approval waits for live mining WORK at the source and sufficient live hauling capacity on its assigned routes. The fragile claimant is withheld while any hostile CLAIM, combat/support force or foreign defense structure remains. AUTO recapture is therefore distinct from both preparing supply and executing a claim.

Claimant disappearance, timeout and permanent claim errors count as failures. Backoff is `min(maximumClaimBackoff, claimCooldown * 2^failures)`, defaulting to a maximum 8,000 ticks. Three failures hold the mission until its 10,000-tick failure window expires. A failed creep is not counted repeatedly. Confirmed ownership clears attempt state. Rejected recapture releases its shared fuel/source budgets for other candidates.

## 6. Multi-Reactor capacity

Mining production is estimated from the affordable miner body, extractor cooldown and local harvest/offload cycle. Haul throughput uses the affordable carry body, hauler count and round-trip time. Route reliability discounts delivery for loaded aging exposure and observed/nearby threats. Finite remaining supply is limited to a 1,500-tick sustainability horizon.

The count starts with `floor(sustainableThoriumDeliveryPerTick)` and is bounded by opportunities, finite supply, healthy combat-capable colonies, spawn availability/pressure, other combat commitments, CPU condition and `maxActiveReactors`. Shared source budgets prevent a miner from being credited independently to multiple Reactors. Each selected Reactor receives at most one unit of recurring consumption allocation before another is admitted.

One bootstrap candidate can build its pipeline below full sustainability, but cannot claim until live supply meets the requirements. Under low CPU, optional growth is frozen while ownership and fuel decisions continue. Capacity is an estimate, not proof of actual live throughput.

## 7. Dynamic mining portfolio

The planner targets `targetReactorCount * 1.15 + 0.25` Thorium/t, bounded by known opportunities, healthy homes and the configured maximum. Ranked accessible assignments are selected until their estimated production meets this target or the hard room cap is reached. Existing owned-room/extractor/staging prerequisites remain.

Only sources actually allocated to supported Reactors harvest. A miner delivers carried cargo and pauses once staging reaches the startup-stock target of its assigned Reactors. This prevents unused candidates and idle pipelines from draining finite deposits. Depleted staging is retained for draining; it is not treated as regenerating production.

## 8. Dynamic startup reserve

For each assigned route:

`required = deliveryETA + replacementDelay + jitter + reactorSafetyStock + defenseRisk`

`replacementDelay = bodySpawnTicks + haulerReplacementMargin + estimatedQueueDelay`

`jitter = ceil(roundTrip * (0.1 + 1 - reliability))`

The worst assigned-route requirement is used. Loaded lifetime affects route viability, reliability and replacement planning. Queue delay is estimated from current queued/busy spawn pressure. The result is clamped between `minimumStartupReserve` and `maximumStartupReserve` (default 1,000). A null minimum falls back to legacy `startupReserve` (default 500), and the minimum cannot fall below `reactorSafetyStock` (default 150). If the unclamped requirement exceeds the upper bound, claiming is refused; the cap is not treated as evidence of safety.

## 9. Fuel priority and reservations

Among owned Reactors: near-tier urgency, established score rate, continuity value, then delivery ease decide order. Owned continuity precedes new capture. With 1.2/t for two Reactors, one continuity stream is supported and the lower-priority Reactor enters HOLD_OFF; new withdrawals and haul demands for it stop. Existing cargo can finish a safe owned delivery. A valuable owned Reactor can retain protection while consuming its last internal buffer.

Reservations rebuild from current staging stock each tick in priority order, subtracting each Reactor's own buffer and destination-specific cargo. A shared 800-unit store can grant 500 to A and only 300 to B. Successful withdrawal intents immediately reduce the allowance for subsequent creeps in that tick. Expired allowances grant zero. Enemy/unclaimed ownership still returns cargo to staging.

## 10. Files changed

| File | Reason |
| --- | --- |
| `Logic.Season11.js` | Portfolio orchestration, source budgeting, reserves, live readiness, claim backoff, critical intel, dynamic mining and spawn plans; schema 3. |
| `Season11.Portfolio.js` | New policy math for continuity, threat, defense, utility, capacity and reservations. |
| `Season11.Operations.js` | Per-Reactor operations, readiness forces, pipeline preparation, demand/squad retirement and operation metrics. |
| `Combat.Operations.js` | Recognize policy-approved Season recapture without manufacturing a manual directive; respect disabled/manual modes. |
| `HiveMind.Strategy.js` | Run critical Season checks outside optional scheduling; retain urgent CLAIM defense scheduling under CPU pressure. |
| `Spawn.DemandBoard.js` | Revalidate and revoke stale Season demands before queue admission; retain the shared economy arbiter. |
| `Squad.Quad.js` | Honor the requested Season response size instead of expanding every approved contest to a quad. |
| `role.ReactorClaimer.js` | Obey current portfolio admission and retire a permanently failed claimant. |
| `role.ThoriumHauler.js` | Limit withdrawals to per-Reactor fuel allowances. |
| `role.ThoriumMiner.js` | Pause unassigned/adequately stocked mining while delivering carried cargo. |
| `role.Volley.js` | Scoped Reactor interceptor behavior, including CLAIM priority and home readiness positioning. |
| `role.Scout.js` | Scoped Reactor watch assignment. |
| `Visual.Dashboard.js` | Portfolio count, defense/CLAIM/combat threat, second Reactor, estimated flow and recapture wait reason. |
| `test.Season11.js` | Scenarios A–M plus integrated capture, recapture, defense, reservation, queue, mode and CPU regressions. |
| `test/phase7.js` | Expect additive schema 3 and explicit manual recapture mode in the legacy compatibility scenario. |
| `SEASON11-STRATEGY.md` | Pre-change audit, implementation report and manual lifecycle traces. |

No economy, remote energy mining, road, expansion, generic mineral or terminal logistics implementation was changed. Existing body plans and Adapter feature detection remain in use.

## 11. CPU impact

- Every tick: refresh ownership/CLAIM and defense-structure intel in known visible Reactor rooms; reuse indexed hostile creeps. All visible Reactors are checked even when the optional scan budget is one room.
- Every tick: one indexed creep pass for destination cargo, ETAs, workers and claimant lifecycle; readiness checks once per relevant home; bounded candidate fuel ordering/allocation and scalar defense/recapture decisions.
- Every 17 ticks by default (clamped to 10–25): select up to 12 portfolio candidates (configurable, hard bounded to 24), evaluate candidate/source routes and body-based throughput. Known Reactor ownership intel is retained outside this scoring cap.
- Mining ranking retains the existing adaptive planning cadence. Deep routes retain the 2,500-tick cache and shared 1–6 route-search budget; low bucket permits zero searches. Unverified linear-distance fallbacks cannot authorize a new pipeline.
- Route aging observations are indexed once per tick rather than rescanning all creeps for each route. Assignment counts use role-specific TickIndex lists.
- Existing operation utility/maintenance scans remain; multi-Reactor operation work grows with assigned routes. Full live CPU cost has not been measured.

## 12. Memory impact

```js
Memory.hive.season.season11 = {
  schemaVersion: 3,
  rooms: { /* existing finite deposit/intel records */ },
  reactors: { /* existing snapshots plus priorContinuousWork, ownershipLosses,
                 reactorThreat, hostileDefenseStructures, claim failure scalars */ },
  assignments: { mining: {}, selectedReactorId: 'R0', selectedReactorRoom: 'W30N1' },
  reactorPortfolio: {
    reactors: {
      R0: {
        reactorId: 'R0', roomName: 'W30N1', homeRoom: 'W1N1',
        active: true, state: 'SUPPLYING', owned: true,
        scoreRate: 3, continuousWork: 950, continuityValue: 73.87,
        ticksUntilNextScoreTier: 50, starvationRisk: true,
        assignedMiningRooms: ['W10N1', 'W11N1'], routes: [],
        allocatedThroughput: 1, reservedThorium: 400,
        startup: { reserve: 500, feasible: true },
        defenseTier: 'READY', threat: {}, recapture: {}, lastEvaluated: 100
      }
    },
    candidateIds: ['R0'], activeReactorIds: ['R0'], desiredActiveCount: 1,
    sustainableCount: 1, sustainableThoriumDeliveryPerTick: 1.5, plannedAt: 100
  },
  thoriumReservations: { tick: 100, stores: { staging0: { total: 800, reactors: { R0: 400 } } } },
  dashboard: { tick: 100, reactors: [], activeCount: 1, desiredCount: 1 }
};
```

Only IDs, strings, numbers, booleans, compact arrays and plain objects are stored. Reservations replace the previous tick's ledger. Portfolio entries outside the candidate budget or obsolete intel are removed. Useful ever-ours intel survives ordinary stale cleanup; stale former-owned records do not occupy current candidate slots. Failure scalars age out or clear on confirmed ownership. Existing bounded event histories remain unchanged.

## 13. HUD examples

Illustrative rows within the existing panel footprint:

```text
SEASON 11
Reactors 1/1 W30N1
Defense READY CLAIM 0 COMBAT 0
T 420/1000 continuous 5k
Score 4/t empty 420 ETA 76
Est flow 1.5/t CPU ...
```

With a second candidate the final flow row can show `W31N1 3/t 190t READY`. When stolen, the alert row shows a compact WAIT reason and remaining retry ticks. Full utility, reserve, state and reason are available through `Memory.hive.season.season11.dashboard` and `reactorPortfolio.reactors[id]`. Observed delivery-event throughput remains available in the existing Season operations dashboard separately from estimated sustainable flow.

## 14. Tests and manual lifecycle trace

Validation commands: `npm run test:season11` and `npm run validate`. The focused suite contains 50 tests. The full suite includes combat/duo/quad, spawn and ACTIVE/SPAWNING/QUEUED handling, economy recovery, memory migration/GC, operation transitions, controller safety, remote economy regressions, module graph and movement audit. Final command results are reported with delivery.

Results: the full validation command passed, including all combat/spawn/economy/memory/operation suites, 95 reachable modules with zero cycles, and the movement ownership audit. The final focused command passed all 50 tests, including the additional destination-specific ETA regression. Final JavaScript syntax checks and `git diff --check` passed. Work remains on `main`.

Manual logic trace of the implemented paths:

1. **First discovery:** Adapter-gated scans record finite Thorium and Reactor intel. The adaptive planner selects accessible owned extractor/staging rooms according to demand. Route warm-up may take multiple passes because speculative distances cannot authorize capture. Mining starts only on allocated sources and stops at staging targets.
2. **First claim:** A candidate reserves startup fuel and stages haulers. A claimant cannot spawn until the route is verified, reserve bounds are feasible, live source WORK/haul capacity suffice, the home is healthy and target vision is clear. The role rechecks admission and calls only the adjacent feature-detected claim intent.
3. **Stable fueling:** Current per-Reactor cargo and stock reduce its reservation deficit. Haulers consume exact allowances; a safe confirmed owned target receives cargo. Temporary undersupply preserves priority continuity instead of splitting stock blindly.
4. **High continuity:** Work 5,000 raises READY even in peace. Imminent tier transitions, historical theft and nearby danger can raise HOLD. Ordinary local survival remains protected by the economy arbiter.
5. **Stolen Reactor:** Every-tick observation preserves our prior work, records theft, updates ownership and threat, and prevents delivery to the enemy. A live claimant cannot proceed on stale admission.
6. **Approved recapture:** Valuable finite supply, reserved stock, a ready live pipeline, manageable defenses and diplomacy permission produce an approved contest. Small defense demand denies enemy claimants; our claimant waits for the target to clear. Confirmed ownership clears backoff.
7. **Rejected recapture:** Allies, unhealthy economy, insufficient supply, high defense cost, stale vision or repeated failures produce RECOVERING and a reason/retry. Fuel reservations and source budgets are released; rejected replacement demands are removed.
8. **Second opportunity:** With maxActiveReactors 2, sufficient finite production/haul capacity and healthy defense/spawn capacity, source budgets and stock are allocated separately to two IDs. Otherwise one is supported. Exhausted deposits drain staging; depleted/missing operations retain the existing depletion/retirement lifecycle.

Mocks validate decisions and integration contracts. They do not prove actual seasonal engine intent resolution, travel time, route safety, enemy responses, or live CPU consumption.

## 15. Remaining risks

- **Combat:** An interceptor arriving after an adjacent hostile CLAIM intent may be too late; proactive positioning reduces this risk but cannot guarantee ownership. Boosted escorts, terrain, towers and enemy tactics can invalidate static estimates. Conservative refusal and existing retreat checks remain essential.
- **Spawn pressure:** Queue delay, body affordability and other combat commitments are estimated. New Season demands still use existing economy admission, and no Season defense receives an owned-room emergency bypass.
- **CPU:** Candidate/source work is bounded and throttled, but critical visible-Reactor checks still scale with known visible Reactor rooms. Real shard profiling is required before increasing portfolio limits.
- **Memory:** Ever-ours history intentionally persists. Portfolio state and fuel ledgers are compact/bounded, but total historical Reactor intel can grow over the season.
- **Finite Thorium:** Body/cooldown/offload estimates can overstate achievable income. Stock caps prevent unlimited mining, and depletion never creates replacement production.
- **Starvation:** Reserved staging fuel is not already inside a Reactor. Movement jitter, contested routes and failed delivery intents can still interrupt scoring. The HUD labels capacity estimates and exposes ETA/buffer risk.
- **Ownership thrashing:** Backoff prevents endless claimant replacement but also delays response after temporary failures. Manual mode remains subject to value, supply and ally safeguards.
- **Local economy:** Existing recovery policy and tests remain authoritative. Season roles and squads can consume spare capacity, so live queue/economy telemetry should be checked before raising the default Reactor count.
