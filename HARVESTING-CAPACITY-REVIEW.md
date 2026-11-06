# Sushi harvesting capacity and adaptive spawning review

November 5, 2026. Changes were made in the existing Sushi checkout. No pull
request, game console mutation, script upload, or deployment command was run.

**Verified diagnosis and limits of the evidence**

The original code was loaded from Git HEAD into an in-memory module loader,
without checking out another repository or replacing working files. A mock
reproduction used W3S47, RCL3, 300/300 spawn energy, six local Extractors, two
active WORK on source A, five on source B, one seat on A and six on B.

With no live container at A, the original result was: zero requests, empty queue,
and `Queue empty`. The actual code path was:

1. Economy correctly reported five theoretical WORK per source and seven active
   useful WORK overall. ColonyState consequently kept the room in core recovery.
2. Source demand used the capacity-sized generic body and capped non-container
   demand by seat count. This mixed attainable capacity with theoretical demand;
   its non-container calculation also substituted the legacy six-WORK constant
   for the source's calculated regeneration demand.
3. The local request loop counted both WORK and assigned creeps. At the weak
   source, `livingAssignedCount >= maxSeats` suppressed a request even when WORK
   was short. The other source was already covered. The role-wide count was not
   the sole cause: the Extractor branch had its own per-source seat/count gates.
4. No early replacement request could target a healthy but underpowered occupant.
   A larger available body therefore could not improve an occupied unique seat.
5. Body selection, spawn admission and execution never received a local request
   in this reproduction. Energy at the spawn was not the immediate blocker.
6. Bootstrap returned immediately after asking for insufficient local WORK. If
   that WORK was unattainable at the existing capacity, the return could prevent
   reaching builder demand. Separately, ColonyState and controller spending
   required theoretical harvest health before allowing minimum growth.

The live-container branch matters. With the same single two-WORK occupant and a
live container added, the original code requested and spawned another two-WORK
miner. Its container-specific rule allowed one primary plus one supplement or
handoff, even without a second usable tile. Two assigned miners suppressed that
branch as well. Thus the pasted observations alone cannot establish which branch
the actual live room took. No live Memory, source/container objects or resolved
ticks were available. The reproduction and static gates are verified; an exact
live-state diagnosis remains unverified. See
[original-code reproduction](validation/harvesting-idle-reproduction.log).

**Per-source planning and affected modules**

`Harvest.Planning.js` supplies a shared capability model to Economy and the
existing request manager. It calculates regeneration demand, validates source
seats using the existing utility, counts each assigned miner's active parts,
separates spawning and queued bodies, and records maximum and current-energy
body capability. Realistic spawn capacity excludes inactive or destroyed energy
structures while retaining partially damaged active extensions.

Economy's source rows now expose theoretical required WORK, active WORK,
stationed WORK, maximum achievable WORK, planned WORK after replacing incumbents,
available seats, miner names/body metrics, replacement state, bottleneck and next
action. Incoming miners never become active income; destroyed WORK contributes
zero. Same-tick accepted spawn intents and spawning creeps absent from Game.creeps
reserve the source without being counted twice. Existing per-source transport,
container/link analysis and source-distance data remain in use.

The local request loop in `spawn.request.manager.js` uses this shared model rather
than its old duplicated counting and container admission logic. It retains the
one-source-per-pass limit, queue deduplication, planning schedule, remote planner,
and centralized Arbiter/Policy/Capacity ownership.

**Body sizing and energy policy**

Inspection found no general one-WORK-only Extractor body bug. The existing
`BodyProfiles.js` generator already supported these local bodies; the new planning
and execution logic uses them consistently:

| Energy budget | WORK | CARRY | MOVE | Cost |
| --- | ---: | ---: | ---: | ---: |
| Emergency minimum | 1 | 1 | 1 | 200 |
| 300 | 2 | 1 | 1 | 300 |
| 450 | 3 | 1 | 2 | 450 |
| 550 | 4 | 1 | 2 | 550 |
| 700 or more, ordinary source | 5 | 1 | 3 | 700 |

Bodies are also capped by the source's requested capability. Filling a final
one-WORK shortage can appropriately produce a one-WORK supplement. CARRY remains
necessary: Sushi harvests into its store, transfers to local stores or drops for
haulers, and can self-deliver during bootstrap. A CARRY-less miner would break
that implementation. Local MOVE density favors stationary mining and accepts
slower travel; the replacement lead includes a conservative travel allowance.

`Spawn.Sizing.js` and `spawn.manager.js` add a 20-tick bounded reservation for a
preferred, attainable efficient miner. Startup/emergency recovery can immediately
use a useful affordable body. A stalled preferred-body wait releases; economic
deterioration releases an affordable fallback; urgent recovery, controller safety
and imminent defense can preempt discretionary upgrades. Impossible fixed bodies
do not reserve energy. A replacement cannot shrink below the WORK needed to
improve its incumbent, except a necessary lifetime replacement. Unchanged energy,
capability and capacity reuse the cached body preview. Capacity and capability
changes trigger reevaluation. Population/economy hysteresis remains in place.

These choices follow the game's spawn/extension energy and movement rules:
[Screeps creep documentation](https://docs.screeps.com/creeps.html) and
[spawn API](https://docs.screeps.com/api/#StructureSpawn.spawnCreep).

**Replacement lifecycle**

Occupied seats can now receive a named replacement when an attainable stronger
body repays its cost before the incumbent's lifetime replacement window. Imminent
death also creates a lifetime replacement. The request reserves the source and
names its predecessor; admission and execution revalidate the gain and current
maximum capacity. Another pending replacement suppresses duplicates.

`role.Extractor.js` calls lifecycle handling in `utility.Creep.js` before normal
source selection. The successor approaches without claiming its predecessor's
seat. The incumbent continues its normal work until the successor is adjacent and
a valid exit is available. Seat reservations and physical occupancy prevent two
owners. After vacating, the incumbent goes through existing movement to a home
spawn for recycling, and the successor claims through the normal source/seat
helpers. No separate role controller or movement system was added.

If the incumbent dies, the successor keeps the targeted source and can claim the
vacated seat. If the successor dies during retirement, a surviving incumbent can
resume. A missing/blocked seat, changed predecessor assignment, inadequate body or
150-tick handoff timeout aborts the successor without evicting the incumbent.
Aborted successors recycle. A failed early handoff is suppressed against the same
incumbent, seat count and capacity, rather than repeatedly buying replacements;
lifetime replacement remains possible. Infrastructure changes allow reevaluation.
Successful partial upgrades also start a 250-tick early-upgrade cooldown, so an
affordable intermediate body does not immediately trigger another replacement
wave. This cooldown does not suppress an imminent lifetime replacement.

**Recovery and infrastructure growth**

`HiveMind.Economy.js` still evaluates health against theoretical source demand.
Seven out of ten WORK is still RECOVERY. A separate infrastructure-recovery
permission requires all sources to cover their currently achievable capacity,
stationed income evidence, sufficient local hauling, a working Foreman, at least
200 spawn energy and a non-deteriorating energy trend.

When these conditions hold, `HiveMind.ColonyState.js` permits minimum controller
progress while reporting the core floor incomplete. Economy bounds this to one
controller WORK and keeps discretionary spending restricted. Infrastructure
Artificer requests are bounded to two planned/live WORK. Bootstrap now reaches
critical construction instead of repeatedly returning on unattainable harvesting
demand. `Spawn.Policy.js` admits critical infrastructure during bootstrap through
the existing policy/capacity path; the hard population safety cap remains.

The existing structure planner places extensions, and existing Artificers already
prioritize critical extension/container construction. Filling completed active
extensions raises achievable body capability; named upgrades can then improve
unique seats. Genuine workforce, seat-access or logistics shortages do not satisfy
the infrastructure escape gate. Economy state transition hysteresis is preserved.

**Diagnostics**

`Diagnostics.js`, `Diagnostics.View.js` and `Visual.Dashboard.js` now expose seat
count, achievable/stationed/planned WORK, miner body composition and names,
replacement status, spawn capacity/current energy, selected body and preferred
cost, sizing reason, admission reason and recommended action. Admission rejection
is retained even when it leaves the queue empty. Idle capacity-limited spawns
explain the bottleneck instead of reporting only an empty queue.

The Black Box records plan/constraint transitions and handoff completion/abort.
Unchanged source plans do not create an event each tick. Existing bounded event
storage, deduplication, Dashboard V2 geometry and overflow limits remain in use.

**Automated verification**

The unmodified existing `npm test` suite passed before implementation. The final
validation command is `npm run validate`, which runs the entire existing suite,
module graph validation, movement ownership audit, and the new harvesting suite.
`npm test` and `npm run validate` both include the new tests; `npm run
test:harvesting` runs them alone.

`test/harvesting-capacity.js` adds 27 scenarios, including all 15 requested cases:
one/six seats, mixed/destroyed WORK, 300 energy and extension-backed bodies, full
energy with idle spawn, productive upgrades, in-progress replacements, blocked
handoffs, capacity-limited recovery and infrastructure growth, emergency bodies,
stalled preferred energy, incumbent death, economic deterioration and unavailable
extensions. Additional cases verify physical handoff/reservation behavior, urgent
hauler preemption, repeated-failure suppression, capacity loss invalidation,
stranded-successor recycling, the full builder-demand pipeline, event transition
behavior, cached body selection, admission rejection visibility and partial-upgrade
cooldown behavior.

The full run and command outcome are recorded in
[final validation log](validation/harvesting-final.log). These are Node/mock and
static validations, not live-game performance measurements.
The final command exited successfully: all 38 validation commands passed, with
525 logged PASS checks, including the 27 new harvesting scenarios. The graph
validated 107 reachable modules with no cycles; the movement ownership audit and
`git diff --check` also passed.

**Remaining live validation**

Read `Sushi.debug.room("W3S47")` to confirm the real stored source seats, assigned
names, live container status, current decision and bottleneck. After a deliberate
deployment, observe resolved ticks for a unique-seat handoff, incumbent recycling,
Traveler/traffic behavior at narrow exits, extension construction and filling,
actual delivered energy, and CPU/Memory overhead. The source income displayed by
Economy is a stationed-WORK estimate; offloading, delivery, terrain and congestion
can lower realized income. A short movement gap during a resolved handoff is
possible and requires live observation. No successful live handoff, extension
build or sustained income improvement is claimed here.
