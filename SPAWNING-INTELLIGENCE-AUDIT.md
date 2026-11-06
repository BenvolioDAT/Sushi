# Sushi autonomous spawning intelligence audit

November 6, 2026. Changes remain in the current working branch. No upload,
deployment, live-game console command, commit, or pull request was performed.

## A. Executive summary

The reported idle spawn is not, by itself, proof of incorrect body selection.
At 300 maximum spawn energy, the existing generator can build a local two-WORK
miner, but cannot build enough WORK to saturate an ordinary source through one
seat. If that seat already has two WORK and the other source has five, another
ordinary miner cannot improve the constrained source. Seven of ten WORK,
RECOVERY, and an idle spawn can therefore be accurate observations.

The architectural problem is whether the remaining economy can fund the
infrastructure and replacements needed to make progress. This investigation found
and corrected eight failure classes in those interactions:

1. Bootstrap harvest demand starved additional hauling needed to enable the
   existing infrastructure-recovery permission.
2. An early-upgrade request retained its stronger-body minimum after its
   predecessor approached death or died.
3. Staging successors inflated active source capacity before the physical handoff.
4. Retiring incumbents could make necessary new mining requests appear obsolete.
5. Final body selection could bypass the calculated active spawn-energy ceiling.
6. Empty-room startup could spend the entire first harvest budget on a carrier.
7. A queued upgrade could remain actionable after healthy workers restored coverage.
8. The SURVIVAL-to-RECOVERY transition could stop miner self-delivery before a
   local hauler was active.

The changes reuse the existing planner, Arbiter, policy, body generator, and role
lifecycle. No prescribed Extractor body, new planning framework, or remote-mining
rewrite was introduced. Larger bodies remain subject to source demand, seat
limits, energy, replacement urgency, and the existing upgrade payback check.

## B. Root cause analysis

### Actual execution pipeline

| Stage | Execution path and decision ownership |
| --- | --- |
| Tick context | `main.loop` runs `Tick.Bootstrap` and the shared `HiveMind.Index` before planning. |
| Economic state | `Tick.Planning.runStrategy` calls `HiveMind.Economy.run/updateRoom`. Source income, active WORK, transport, local/remote hauling, spawn fill, replacement risk, reserves, and energy trend feed the raw state and hysteresis. |
| Lifecycle and priorities | `HiveMind.ColonyState.run/update` evaluates active economic floors, bootstrap/growth phase, controller danger, defense, and minimum controller progress. `HiveMind.Capacity.get` supplies CPU, population, energy, and spawn-load limits. |
| Infrastructure | The existing remote and structure planners run under scheduler/CPU limits. `Planner.Brain` stages containers, extensions, and other infrastructure; placement and construction are separate from requesting a builder. |
| Demand generation | `Tick.Planning.generateSpawnRequests` invokes resource/squad/power producers and `spawn.request.manager.run`. `runForRoom` prunes expired work, builds a planning context, runs emergency planning every pass, and refreshes full demand on its scheduled passes. |
| Harvest requirement | `getSourceMiningDemand` derives theoretical WORK from source regeneration, and includes allowed remote demand separately. The local branch of `requestRoleForRoom` uses `Harvest.Planning.describe` for each visible source. The generic role count is not the authority for local source admission. |
| Effective capability | Economy caps useful active WORK separately at each source. `Harvest.Planning` separates active, spawning, staging, queued, retiring, and replaced workers. Planned WORK substitutes successors for incumbents instead of adding both. Stationed WORK remains an income estimate, not a measurement of delivered energy. |
| Seat feasibility | `Harvest.Planning.seats` calls `utility.getValidSourceMiningSeats`, validating stored positions against terrain and blocking structures. It records theoretical demand, maximum achievable WORK, and affordable/current versus full-capacity bodies. |
| Source allocation and count | Local requests target a concrete source. The planner adds an occupant only when there is a seat and missing useful WORK; otherwise it considers a named lifetime replacement or a stronger, cost-repaying upgrade. Pending source work suppresses duplicate admissions. The established one-source-per-pass limit remains. |
| Body generation | `Harvest.Planning.body` and `role.creepBodyConfig` use `BodyProfiles.build`. Requests retain their source/work caps. `Spawn.Arbiter.normalize` may initially select an emergency minimum; final execution sizes against current energy again. |
| Queue admission | Legacy and `Spawn.DemandBoard.flush` requests converge on `Spawn.Arbiter.admit`. Stable request IDs, expiry, terminal-operation cleanup, `Spawn.Context`, `Spawn.Policy`, Economy permissions, and Capacity decide admission. Mandatory recovery can bypass soft limits; the hard safety cap remains. |
| Spawn scheduling | `spawn.manager.runRoom/runRoomInternal` prunes, orders, and revalidates candidates. Urgent recovery, controller safety, and imminent owned defense can move ahead of discretionary miner upgrades. Unaffordable candidates reserve energy only within the existing bounded policy. Other admissible work can proceed when reservation rules permit it. |
| Wait versus spend | `Spawn.Sizing.evaluate` preserves the existing 20-tick efficient-miner wait. Urgency, deterioration, impossibility, or expiry release it. A discretionary upgrade cannot fall below the WORK needed to beat its incumbent. A lifetime replacement can use an affordable productive fallback. |
| Execution | The final body is constrained by current available energy and active spawn/extension capacity. Accepted `spawnCreep` calls update `Spawn.Intents` so another idle spawn cannot spend the same energy or duplicate the accepted request. Actual body capability is saved for in-progress production. |
| Worker behavior and replacement | `role.Extractor.run` invokes `utility.Creep.runExtractorLifecycle` before normal assignment. The incumbent keeps its seat until a successor can hand off; timeout/obstruction preserves the incumbent. Normal `getAssignedSource/getAssignedMiningSeat` cleans dead assignments, preserves targets, reconciles reservations, and checks physical occupancy. Miners offload, drop, or temporarily self-deliver according to hauling availability. |
| Return to growth | The next economy sample incorporates actual living and incoming bodies. Ordinary health still requires per-source coverage and income evidence. Capacity-limited infrastructure recovery remains a separate bounded permission; it does not declare the theoretical harvest target satisfied. Existing state and lifecycle hysteresis remain in effect. |

### Confirmed interaction failures

**Bootstrap/hauling circular dependency.** In `runStartupBootstrap`, a theoretical
harvest shortage returned immediately after asking for miners. At a fully occupied
capacity-limited source there was no useful miner request. Infrastructure recovery
required adequate hauling, but a small existing Freighter satisfied the separate
headcount floor. More hauling was never requested on that path. The correction
requests missing local hauling before returning from harvest recovery.

**Queued job changes were not reflected in body constraints.** A two-WORK
incumbent could receive an upgrade request requiring at least three WORK. If its
TTL later fell to 20, or it disappeared, that request still rejected a productive
200-energy replacement. `Economy.localRecoveryRequest` now classifies the current
replacement need using the same lead calculation as the harvest planner;
`Spawn.Policy` carries that decision to execution. Execution relaxes the minimum
only for a lifetime replacement and releases discretionary waiting. Targeting is
preserved. Healthy incumbents retain the stronger-body requirement.

**Lifecycle capacity disagreement.** `Harvest.Planning.describe` and Economy
previously counted a non-spawning successor as active while it still waited for
its predecessor's seat. Conversely, local request revalidation counted retiring
miners that the planner had already excluded. A shared `activeMiner` predicate
now governs active source estimates, and retiring miners cannot satisfy recovery
coverage. Staging WORK is explicitly incoming. `localHarvestCoverage` uses
replacement-aware planned WORK for incoming coverage.

**Capacity check bypass.** Final selection calculated the active energy ceiling,
then several role-specific selectors received the original room with its larger
available-energy value. All those selectors now receive the bounded budget.
Fixed and generated profiles already respected the local budget. The regression
deliberately supplies an inconsistent energy/capacity snapshot to verify this
last-line guard; it does not claim the live room had that exact inconsistency.

**Startup resource allocation policy.** The prior emergency policy put Foreman
first whenever the minimum miner was recoverable, including when the only energy
was already in the spawn. A CARRY/MOVE body then consumed the first income budget.
An empty room without miners or refill reserves now protects the initial miner.
Stored-energy startup retains Foreman-first behavior. This is a deliberate policy
improvement, covered on both sides of the decision.

**Obsolete upgrades.** A queued stronger body remained admissible after another
healthy worker restored the source's WORK. Revalidation now discards that request
rather than spending energy on capability the source cannot use.

**Delivery state coupling.** `shouldBootstrapSelfDeliver` only recognized SURVIVAL.
Mining could begin and change the state to RECOVERY while hauling was still absent,
stranding the next load at the source. Self-delivery now covers both states until
local hauling is active. Queued hauling is not treated as active hauling.

## C. Engineering decisions

The first six regression scenarios were executed against the original behavior:
all six failed. After completing the suite, all 22 final scenarios were also run
against the original Git HEAD production modules loaded in memory, without
replacing working files. Eleven passed and eleven failed; the corrected modules
pass all 22. This includes the physically valid stale-upgrade scenario with an
additional accessible seat. The comparison is retained in
`validation/spawning-intelligence-original.log`.

The chosen corrections repair information sharing and queue revalidation rather
than changing the body generator. Always spawning the largest body would delay
first income and death recovery. Always spawning the smallest body would exhaust
scarce seats and increase replacement/CPU overhead. Clearing whole queues would
discard useful source reservations and restart waiting deadlines. Raising role
caps would not resolve an occupied unique seat or the hauling/bootstrap cycle.

Existing local bodies retain CARRY because the role stores harvested energy before
offloading or delivery. Local MOVE density accepts slower travel for stationary
mining; the planner includes a travel allowance. Road-backed hauling, controller-fed
workers, and remote transport use the existing infrastructure profiles. No new
claim is made that those profiles are globally optimal.

Official mechanics consulted:

- [Creeps and movement](https://docs.screeps.com/creeps.html): spawn/extension energy
  availability, body limits, fatigue, and disabled body parts. This supports using
  an actual energy budget and retaining a travel allowance rather than optimizing
  WORK in isolation.
- [Spawn API](https://docs.screeps.com/api/#StructureSpawn.spawnCreep): spawn inputs,
  production constraints, and return handling.
- [Official source documentation](https://github.com/screeps/docs/blob/master/api/source/Source.md):
  source capacity and regeneration. The planner reads each source's capacity;
  it does not assume every source requires the same WORK.

These mechanics informed the analysis; the recovery policies are engineering
choices verified by repository scenarios, not strategies prescribed by the docs.

## D. Implemented changes

| File | Meaningful change |
| --- | --- |
| `Harvest.Planning.js` | Shared active-miner classification, explicit staging capability, and reusable targeted-replacement lead; reuse the already computed preferred body during source planning. |
| `HiveMind.Economy.js` | Align active/replacement accounting; use substitution-aware incoming coverage; exclude retired miners from recovery; reclassify death replacements; cancel no-longer-useful upgrades; preserve self-delivery during unhauled recovery. |
| `Spawn.Policy.js` | Pass current lifetime-replacement classification and minimum useful WORK to execution through the existing admission result. |
| `spawn.manager.js` | Apply the active energy ceiling to every role selector; recognize aging upgrades as urgent recovery; update their body minimum before selection. |
| `spawn.request.manager.js` | Request missing hauling before the bootstrap harvest return; prioritize first income when neither miners nor refill reserves exist. |
| `Diagnostics.View.js` | Expose staging WORK separately from active, spawning, and queued WORK. |
| `Visual.Dashboard.js` | Include staging capability in the source's incoming WORK total. |
| `test/spawning-intelligence.js` | Add 22 interacting behavioral scenarios, including a controlled 900-cycle economy replay and body-budget boundary checks. |
| `test/controller-growth.js` | Replace the obsolete unconditional funded-startup assumption with income-first behavior; add the stored-energy Foreman-first counterpart. |
| `package.json` | Include the new suite in `test` and `validate`; add `test:spawning-intelligence`. |

Items other than startup resource ordering are corrections to inconsistent or
stale decisions. Startup ordering is an explicit economic policy change. The
diagnostic changes describe those decisions without suppressing existing warnings.

## E. Behavioral validation

The original complete `npm run validate` passed with 525 logged PASS checks.
The final `npm run validate` exited successfully: all 39 validation commands passed,
with 548 logged PASS checks, including the 22 new scenarios and the additional
stored-energy startup regression. The graph covers 107 reachable modules with no
cycles; the movement audit checks 14 call sites. `git diff --check` passed.
Results are recorded in `validation/spawning-audit-final.log`; the focused suite
is also available through `npm run test:spawning-intelligence` and recorded in
`validation/spawning-intelligence-final.log`.

| Requested scenario | Evidence |
| --- | --- |
| A: initial startup | Real demand/admission/execution at 200 available energy chooses first income without reserves; the controller-growth suite retains the stored-energy carrier-first case. |
| B: stable development | Healthy sources create no redundant miner demand and permit the baseline controller worker. |
| C: economic recovery | Constrained harvest with one inadequate hauler requests additional hauling; retiring miners cannot cancel necessary recovery; absent hauling retains actual miner delivery. |
| D: constrained positions | One/six-seat allocation, unique-seat replacement, pending-source deduplication, and explicit zero-seat/access constraints. Existing harvesting tests also cover physical handoff and stale reservation behavior. |
| E: energy constraints | Boundary budgets from 0 through 700; efficient-body refill arrival; bounded fallback; no equal/weaker discretionary replacement; active extension loss. |
| F: population loss | Total miner loss prioritizes concrete source income over optional development; the long replay removes both mining and hauling. |
| G: replacement timing | Shared lead includes preferred spawn duration and slow travel; a healthy incumbent is retained; queued upgrades adapt to near death and predecessor death. |
| H: conflicting priorities | Imminent owned defense preempts discretionary upgrading; existing harvesting/spawn suites cover urgent local hauling, controller safety, waiting armies, and blocked optional work. |
| I: impossible demand | At 300 maximum energy and an occupied constrained source, bounded critical infrastructure remains admissible while the SPAWN_CAPACITY warning and RECOVERY state remain visible. No-seat demand produces an access diagnosis instead of a futile miner. |
| J: multiple cycles | 900 cycles use real demand, admission, queue, sizing, spawn duration, TTL, and handoff decisions with an approximate delivery model. After the forced loss at cycle 60, mining/hauling recover at cycle 878. The run starts 26 creeps, reaches a maximum queue of four, completes two modeled handoffs, and ends with healthy harvest coverage and growth allowed. |

The replay deliberately refills at no more than eight energy per tick from existing
mining, plus normal low-energy spawn regeneration. It places completed workers at
their jobs and models a clear handoff exit; it does not run engine movement,
construction, pickup, transfer, combat, or pathfinding physics. Its recovery duration
is a result of that fixture, not a live-game promise.

The new calculations retain bounded body searches and linear source/worker scans.
No extra persistent planner, periodic output, or unbounded history was added.
Staging details live in the existing per-tick snapshot/view. Real server CPU and
Memory costs have not been measured.

## F. Remaining risks

- The exact original live room was not inspected. In particular, the actual
  assignments, container status, stored energy, blocked tiles, and body requests
  cannot be reconstructed conclusively from dashboard values alone.
- Stationed WORK estimates potential income. Full stores, offloading cadence,
  mobility or CARRY damage, boosts, and actual hauling can make realized production
  lower. This audit does not add a delivered-energy feedback controller.
- The long replay still produces many minimum-size emergency Freighters under
  sustained low energy. Immediate hauling recovery is preserved; adaptive saving
  or later consolidation of those haulers remains a future efficiency improvement.
- Lifetime/travel margins do not fully model swamp fatigue, congestion, every
  competing spawn job, or multiple simultaneous deaths. Physical handoffs and
  blocked exits still need live resolved-tick observation.
- Seat feasibility excludes walls and blocking structures, but moving occupants
  and contention are resolved by existing runtime reservation/occupancy checks.
  Completely inaccessible sources still require access restoration; no terrain or
  structure removal policy was introduced.
- Low CPU, the hard population safety cap, prolonged defense, or inability to build
  accessible extensions can legitimately delay growth. Diagnostics retain these
  blocks rather than manufacturing a healthy state.

## G. Live gameplay verification

After reviewing and deliberately deploying the changes yourself:

1. Inspect `Sushi.debug.room("W3S47")` and compare each source's required, active,
   stationed, planned, maximum, and incoming WORK; inspect miner names and bodies.
   Staging successors should appear as incoming, with active WORK increasing only
   when the handoff completes.
2. At an occupied weak seat, look for one targeted useful replacement, a credible
   energy wait, or an explicit capacity/access/payback constraint. A particular
   body layout is not a success criterion.
3. During capacity-limited RECOVERY, missing local hauling should be requested
   even when one Freighter exists. Once sustainable attainable mining and hauling
   are covered, critical builders should reach extension construction. The warning
   should remain until capacity or access actually improves.
4. If hauling disappears, watch a loaded local miner deliver to a spawn/extension
   during RECOVERY. Queued haulers alone should not stop that fallback.
5. When an upgrade's predecessor approaches death, inspect the spawn decision's
   admission/body reason. A useful affordable lifetime replacement should proceed
   without retaining an obsolete stronger-body minimum.
6. Watch extension completion/filling, subsequent body capability, actual delivered
   energy, controller progress, and bounded queue length over several generations.
   Repeated aborted handoffs, persistent source crowding, or repeated tiny haulers
   without improving delivered energy warrant further investigation.
7. Check CPU trend and diagnostics for rejection causes and handoff events. State
   recovery should follow real active coverage and the existing confirmation period,
   rather than temporary queued capability or a suppressed warning.

No live gameplay improvement, successful engine-resolved handoff, or server CPU
benchmark is claimed by this report.
