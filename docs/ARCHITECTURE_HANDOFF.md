# Sushi architecture handoff

Updated November 7, 2026 for Freighter renewal. General tick order and subsystem architecture remain documented in [`HIVEMIND.md`](../HIVEMIND.md).

## Freighter replacement flow

`HiveMind.Economy` continues to own production-based local/remote hauling targets and live CARRY coverage. `spawn.request.manager` remains the request producer; `Spawn.Arbiter`, `Spawn.Policy`, `HiveMind.Capacity`, and `spawn.manager` retain admission and execution ownership. Pickup, delivery, Traveler, and traffic ownership are unchanged.

`Freighter.Renewal` is a forecasting helper used by Economy. It performs no creep actions, queue writes, or demand inflation. Instead of replacing each tiny retirement deficit independently, it examines nearby natural expiries and proposes one body covering the required capacity after that cohort expires. Local and remote assignments are evaluated separately; explicit transport workers do not join either cohort.

1. The producer refreshes the current commitment ledger, then asks Economy for a local renewal before optional remote work. Without a valid cohort it uses ordinary deficit requests.
2. The helper reads physical, movable CARRY, known expiry times, existing successor claims, spawning bodies, accepted intents, and unexpired requests from the existing indexes. Ordinary healthy coverage and actual physical capacity are deliberately distinct: aging workers keep serving until death.
3. Lookahead is the maximum useful body's spawn time plus two modeled haul trips and a 20-tick refill allowance. A cohort needs at least two predecessors and a body of at least two CARRY. The body must cover its forecast deficit completely, fit current active spawning capacity and spendable energy, and have no greater replacement energy cost than its predecessors. Expected lifetime after overlap must justify the worker reduction. At most 50 predecessor records are considered per proposal to bound metadata and computation; this is not a population target.
4. Earliest physical CARRY shortfall determines `needBy`. Busy spawns, other queued production, a full haul trip, and a ten-tick arrival margin must fit before that deadline. Remote renewal requires known, operational trip geometry and a covered local hauling floor. No pathfinding is added.
5. Economy revalidates the named cohort and future deficit at admission and execution. A valid renewal can use the worker-saving replacement allowance through soft CPU/population/role guards. Energy reserves, spawn-load limits, queue policy, and the hard population safety cap remain enforced. This replacement allowance supports critical CPU recovery; it does not promise zero temporary CPU cost during overlap.
6. Execution applies the renewed minimum CARRY capability to the affordable-body preview. Temporary low energy cannot silently turn the combined request into another one-CARRY body. If the cohort, income, route, funding window, demand, or deadline becomes unsuitable, the request becomes obsolete or falls back to ordinary recovery with no retained cohort claims. Generic spawn-policy disabling does not disable the capability guarantee.
7. Predecessors keep collecting/delivering normally until natural expiry. No retirement, recycling, suicide, reassignment, or forced cargo drop is introduced. Once a successor exists, its claims prevent another renewal from selecting the same old generation. Claims expire with the old workers, and damaged/dead successors release them.

Ordinary Freighter replacement lead now includes body production, a full modeled haul trip, and the existing margin. Coverage, Economy snapshots, and local admission use that same travel basis; remote lead uses operational route geometry when available. This allows recovery bodies time to complete a delivery before outgoing capacity expires.

## Optional Memory fields

| Owner | Fields | Lifetime |
| --- | --- | --- |
| Spawn request | `freighterRenewal: { assignment, plannedAt, predecessors, needBy, through }`, `replacementFor` | Existing persistent queue; discarded on completion, obsolescence, or recovery fallback. |
| Successor creep | `freighterPredecessors: [{ name, deathAt }]` | Copied through ordinary spawn Memory. `role.Freighter` prunes after each predecessor expires or changes generation; damaged successors release claims. |
| Admission/preview | `missingCarry`, `minimumCarryParts`, validated predecessor list | Derived per evaluation; cached previews include minimum CARRY in their signature. |

`deathAt === Game.time + predecessor.ticksToLive` fences reused names. Future `plannedAt` values fail closed after a tick rollback. Fields are optional and need no schema migration or live Memory edit.

`Sushi.debug.room(name).current.logistics.renewals` exposes queued forecasts. Individual `current.freighters` rows expose predecessor records for live successors. Existing spawn admission reasons identify consolidation; flow/cargo/CPU diagnostics retain their current meaning.

## Validation and limits

Run `npm run validate`: the focused renewal suite plus module-graph and movement-ownership audits. The earlier cleanup removed the old test collection; only the necessary mock helper and two structural audits are retained alongside these new regressions. The default commands now reference present files.

The 500-tick models reduce six one-CARRY workers to one hauler, and twelve to two, without a modeled delivery-capacity gap. Funding loss, critical CPU, route closure, damaged parts, queue blocking, rollback, reused names, and live cargo preservation have separate regressions. These are automated decision/capacity models, not engine pathing or live performance measurements.

Trip geometry and throughput remain estimates. Actual congestion, attacks, room topology, changed sinks, or starvation can invalidate readiness assumptions. Sparse expiries or insufficient funding can still require small recovery bodies; continuity takes priority over consolidation. Population falls as predecessors expire and can temporarily rise while successors come online. No deployment is part of this change.

After a separately approved deployment, inspect queued `current.logistics.renewals`, successor predecessor records, selected spawn bodies, and matched-worker delivery deltas using `Sushi.debug.room("W39S47")`. Observe several trips and the old cohort's natural expiry. Confirm that healthy plus incoming capacity remains adequate, predecessor cargo continues moving, and headcount falls after overlap. Compare `Sushi.debug.cpu()` rolling usage and bucket trend over a creep lifetime; the automated capacity models do not establish a live CPU saving.
