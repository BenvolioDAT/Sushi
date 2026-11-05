# Sushi engineering report — November 5, 2026

> Historical review-stage report. The completed changes have since been integrated
> into the original working Sushi repository. See [INTEGRATION-2026-11-05.md](INTEGRATION-2026-11-05.md)
> for the current repository, validation and synchronization status.

The standard-game update is implemented in an isolated review checkout on
`codex/black-box-dashboard-v2`, based on `7b1ce32`. The original watched Screeps
checkout remains unchanged. No pull request, push, game deployment, live account
inspection, or live CPU benchmark was performed.

Read [SUSHI-OPERATIONS.md](SUSHI-OPERATIONS.md) for the exact deployment procedure,
console commands, configuration and chunked export instructions.

## A. Black box implementation

### Existing architecture and active paths

The previous audit, `AUDIT-2026-11-05.md`, and its fixes were inspected before
changes. Bootstrap builds the shared TickIndex and migrates Memory; planning
samples Economy/ColonyState, strategy and spawn demand; the room phase manages
structures; independent roles and squads execute before final traffic resolution;
visuals and telemetry finish the tick. These ownership boundaries remain.

Economy owns SURVIVAL/RECOVERY/STABLE/SURPLUS, per-source WORK/income, logistics,
reserves and hysteresis. ColonyState adds lifecycle, core workforce and growth
eligibility. Spawn requests pass through DemandBoard, Arbiter, Policy, Capacity
and the established room queue. Existing CPU telemetry already measures phases,
keeps rolling averages, persists periodically, and samples role utilization.
Existing console messages include successful spawns, throttled role errors and
Traveler notices; a competing console logger was not introduced.

Code defaults enable normal strategy, resources, standard power processing and
the dashboard. WarRoom compatibility, pixel generation, market activity and
power-creep auto-creation remain opt-in/off by their existing defaults. These are
source/configuration findings, not observations of the user's live Memory.
Before cleanup, Season 11 was still called from bootstrap, strategy, role
execution, observers and resource handling. Its operating decisions depended on
seasonal API detection and configuration. Actual live operation could not be
established from source alone.

### Service and storage

`Diagnostics.js` is a manager-independent service. Callers provide scalar
facts; the service accepts ECONOMY, SPAWNING, MOVEMENT, JOBS and ERRORS categories
and DEBUG/INFO/WARN/ERROR severities. Records contain tick, room, event,
category, severity and data, plus an id, repeat count and last occurrence tick.
Data accepts at most 12 bounded primitive fields. It skips getters and nested
objects, including live game objects and their `toJSON` methods. Errors retain
bounded message, subsystem and stack-location context.

The existing `Memory.hive.telemetry` domain owns the fallback. The larger ring
lives in heap and, when available, one RawMemory segment. Default limits:

| Control | Default / hard ceiling |
| --- | --- |
| Recent events | 1,000; serialized size can reduce this substantially |
| Segment/history serialized size | 90,000 ASCII characters including envelope allowance |
| Ordinary-Memory fallback | 64 events and 16,000 serialized characters |
| Health snapshots | Every 100 ticks, plus an initial sample after heap reset |
| Segment flush | At most once every 25 ticks when dirty |
| Duplicate aggregation window | 50 ticks |
| Retention | 50,000 ticks after the most recent occurrence |
| Event admission | 20 calls per tick, with capacity up to 30 for ERROR events |
| Actor/job observation state | Bounded maps; stale actor observations are removed |

Unicode escaping makes the serialized limits byte-safe as well as character
limits. Encoded records and their sizes are cached; routine ticks do not stringify
the large history. Ordinary Memory is still serialized by the Screeps runtime.
The small fallback is updated when events or retention change. A persistent
namespace id preserves heap history across ordinary per-tick Memory parsing.

No preexisting RawMemory consumer was found. Segment 98 is requested
asynchronously, with currently active ids preserved. A full ten-slot active set,
an ownership conflict, unavailable API, nonempty unrecognized/foreign data,
malformed JSON, or failed write causes safe fallback. Ownership is recorded in
`Memory.hive.segmentOwners`; no foreign contents are overwritten. The API makes
activation available on later ticks and subsequent activation calls replace prior
requests, so a future additional consumer must share an activation coordinator.
See the [official RawMemory documentation](https://docs.screeps.com/api/#RawMemory).

A global reset rebuilds from fallback immediately and merges the owned segment
when available, deduplicating ids. Unflushed older records beyond the fallback
can be lost on a reset. This is bounded diagnostic retention, not an audit log
with guaranteed delivery. `clear()` persists a marker so pre-clear segment data
cannot reappear after a reset before its next flush.

### Events, commands and failure isolation

Economy records state/constraint transitions, recovery activation/completion,
growth pause/resume, reserve crossings, starvation and periodic room health.
Spawning records accepted bodies, emergency replacements, blocked requests,
energy waits, API failures and unexpected idle demand. Movement observes
persistent no-progress, repeated failures, invalid destinations, exit oscillation
and unrecoverable return codes. Resource jobs report invalid claims, unreachable
targets, sustained eligible idleness, repeated abandonment and failed reassignment
after an observed worker death. Job-wide checks reuse the current board and run
every 25 ticks; they are bounded heuristics, not a complete intent-resolution trace.

Independent role errors retain the earlier audit's counters and throttled console
messages, now also producing structured records. Throwing role/spawn console
loggers cannot turn an accepted spawn or another worker's execution into failure.
Main-phase exceptions are recorded with phase context; later independent phases,
traffic and telemetry remain reachable. A failed bootstrap skips dependent work
for that tick. Recorder failures, including a conflicting console global, do not
escape into colony operations.

`Sushi.debug` is installed/reinstalled by the tick conductor:

```javascript
Sushi.debug.status()
Sushi.debug.events(20)
Sushi.debug.errors(20)
Sushi.debug.room('W3S47')
Sushi.debug.cpu()
Sushi.debug.mode('PROFILE', 100)
Sushi.debug.export(3000)
Sushi.debug.exportChunk(0)
Sushi.debug.clear()
```

Exports freeze one compact JSON snapshot into bounded chunks; later ticks cannot
shift offsets between calls. All user steps are in the operation guide.

### CPU controls and measured limits

The existing phase timer now measures in `finally`, retaining elapsed cost when
work throws. Additional named phase costs cover room/road planning and recorder
begin/observation/flush work. Existing aggregate creep, spawning, traffic and
visual costs remain. PROFILE temporarily changes existing role sampling from
once per 25 ticks to every tick and records compact phase samples every five
ticks. It expires after its bounded duration. NORMAL adds no new per-creep CPU
profiling. DEBUG permits extra records such as resource-job assignments.

OFF returns before recording, storage activation, data sanitation or CPU reads
inside the service. The conductor still has its small coarse timer boundaries,
and established capacity/CPU telemetry remains enabled. Diagnostic event hooks
inside another phase are charged to that phase; the diagnostics phase is not a
complete attribution of every hook's CPU cost. Phase measurements are nested and
must not be summed as independent totals.

Automated evidence verifies call counts, bounded work/data, flush cadence and
OFF behavior. It does not establish a live CPU percentage or prove that NORMAL
has negligible cost on this colony. Live profiling and bucket comparison remain
necessary.

## B. Seasonal cleanup

Removed production modules:

- `Logic.Season11.js`
- `Season11.Adapter.js`
- `Season11.Operations.js`
- `Season11.Portfolio.js`
- `Season11.ResourcePolicy.js`
- `Season11.Strategy.js`
- `role.ThoriumMiner.js`
- `role.ThoriumHauler.js`
- `role.ReactorClaimer.js`

Removed hooks include seasonal pixel suppression; strategy/operation scheduling;
provider registration; seasonal role dispatch/body plans; observer priorities;
Reactor guard and maintenance exceptions; resource staging/retirement paths;
Reactor inventory accounting; aging calculations; traffic priorities; offensive
operation types; spawn aliases; expansion compatibility fields; and seasonal
visual panels. The recurring generic-demand scrub originally used by the
Thorium pipeline was removed rather than left in the main execution path.

Preserved reusable systems include Strategy.Provider's generic boundary,
source-specific demand/replacement accounting, economy gates, hysteresis,
capacity/body scaling, standard mineral/logistics policy, labs, boosts, terminal
balancing, scouts/expansion, diplomacy, squads, traffic, Power Banks, power
processing, power creeps, and all earlier audit corrections.

`Season.Retirement.js` runs once, with a persistent completion marker. It removes
confirmed seasonal operations, related demands/squads/queue entries, owned season
configuration/state and enumerated fields. Queue entries are removed in place to
preserve existing references. It clears invalid assignment references on related
creeps. Surviving miners/haulers become ResourceCouriers and return home; claimers
become Scouts. Cargo is not destroyed. Existing standard expansion remains
committed. Standard resources, power state, room economy, unknown fields and
custom data survive. Unknown fields in a legacy `hive.season` branch remain.

Remaining seasonal references are intentional: old-schema compatibility in
HiveMind.Memory; the one-shot retirement module/marker; regression fixtures and
absence checks; the unchanged previous audit; and historical engineering reports.
Historical documents are explicitly marked. Active runbooks use current commands.

Retired test suites: `test.Season11.js`, `test/phase7.js` and the old combined
season/power suite. Its nine ordinary power cases were preserved in
`test/power-pipeline.js`. Eleven seasonal-only resource tests were retired; its
25 general resource cases remain. Generic cap, body, traffic, migration and
scouting coverage was retained/adapted rather than discarded.

## C. Economic investigation

### Actual code path

The supplied W3S47 values come from one described screenshot. No live snapshot,
creep assignments, queue or spawn decision was supplied. Therefore an exact
historical cause of that room's idle spawn cannot be established here.

1. `Economy.buildSnapshot` enumerates local sources and assigned local Extractors.
   Required WORK for each source is
   `ceil((energyCapacity / ENERGY_REGEN_TIME) / HARVEST_POWER)`. A normal
   3,000-energy source therefore needs five WORK, or ten across two such sources.
2. Active WORK excludes spawning actors. Each source is capped at its own demand;
   surplus miners at one source cannot cover another. Unassigned miners are
   reported separately. Income is estimated only from active WORK stationed
   within one tile of that source.
3. Recovery checks aggregate and per-source WORK at 90%, and income at 65%.
   A reported 14/20 income is above the aggregate income threshold; it alone
   cannot explain the warning. A per-source deficit or insufficient WORK can
   still legitimately trigger it.
4. `ColonyState.decide` uses that per-source health check. Its phrase “minimum
   local miner floor missing” is a capability/flow gate, not a universal count of
   exactly two miners. Multiple small bodies may be necessary. Queued/spawning
   WORK is incoming and cannot satisfy active productivity.
5. Request generation targets missing local capability. Arbiter revalidates it;
   supported mandatory local recovery bypasses discretionary capacity/caps.
   The consumer still checks policy, body affordability, names and spawn API
   results. Empty queues, already-spawning replacements, policy rejection,
   unavailable energy, missing spawns or failures have distinct explanations.
6. Stored energy affects reserves and bootstrap recoverability, but a spawn uses
   energy available in spawns/extensions. Stored energy needs usable transport.
   The previous audit's self-delivery and active-versus-incoming hauling fixes
   remain covered by the audit suite.
7. Economy deterioration is immediate. Improvement requires sustained evidence:
   12 ticks from SURVIVAL and 40 from RECOVERY; transitions advance one state
   at a time. A core shortage may legitimately keep growth paused until fixed.
   No code evidence justifies relaxing these thresholds to hide the screenshot.

### Confirmed defects and reporting fixes

A new regression reproduced a one-tick inconsistency: buildSnapshot calculated
growth using the previous economy state, then hysteresis finalized the current
state. Growth could still report LOCAL_HARVEST_SHORTAGE on the tick active
harvesting recovered out of SURVIVAL. Growth is now recalculated against the
finalized state only when the state changes. Thresholds and hysteresis remain.

Spawn diagnostics now calculate the minimum currently selectable body cost
rather than presenting a full-capacity planned body as the minimum requirement.
For a normal recovery Extractor this is 200, not an arbitrary 550. Successful
selection clears obsolete waiting/block reasons; multi-spawn records carry each
actual body's cost. Logging failures no longer mislabel a successful spawn.
These are diagnostic/reliability fixes, not evidence that they caused W3S47's
historical screenshot.

The new room view exposes per-source active/stationed/spawning/queued WORK,
income, current priority, spawn role/stage/reason, available/required energy and
sample ticks. Stale data is labelled. This supplies the evidence needed to trace
an actual post-deployment incident without guessing.

## D. Dashboard V2

`Visual.Layout.js` supplies reusable tile-coordinate columns, margins, padding,
line spacing, dynamic heights, alignment, truncation, row/content limits and
overflow summaries. Backgrounds draw before text. Panels stay between x=0.6 and
49.25 and below y=49.1. A panel is omitted when it cannot fit at a readable size.
The upper layout leaves lower room space available; world objects underneath a
panel can still be covered, and COMPACT/OFF provide alternatives when needed.

The green/black terminal aesthetic is retained. Header/colony/alerts/population/
diagnostics occupy the left column; sources, spawning, meaningful remotes,
resources and optional debug information occupy the right. Sources identify
WORK and income directly. Population separates active, spawning and queued
actors. Resource rows omit zero inventories. Diagnostic summaries include
room-local and global failures; they inspect a bounded tail without repeatedly
parsing/exporting history during rendering.

OFF, COMPACT, NORMAL and DEBUG are controlled by
`Memory.config.visuals.dashboardMode`, with NORMAL default and the existing
showDashboard disable override preserved. Optional remote overlays appear only
for active visible remotes. No animation, effects, DOM or CSS dependency was added.

`dashboard-preview.svg` and `dashboard-preview.png` render mock RoomVisual calls
from the layout fixture. They were visually inspected during implementation;
they are not screenshots of W3S47 or proof of in-game font/label appearance.

## E. Validation

The original complete validation passed before modification, including the
seasonal suites. Final validation executes 37 scripts and includes all remaining
general regression coverage. Detailed results are retained under `validation/`.

Focused added coverage:

| Suite | Result |
| --- | --- |
| `test/diagnostics.js` | 30 cases passed |
| `test/season-retirement.js` | 7 cases passed |
| `test/dashboard-layout.js` | 10 cases passed, including RCL1–8 × three visible modes |
| `test/local-economy-recovery.js` | Existing cases plus 3 new cases passed |
| `test/power-pipeline.js` | 9 preserved standard power cases passed |
| `test/audit-regressions.js` | All 24 previous audit cases passed |
| Dependency graph | 105 modules resolved/reachable, zero cycles |
| Movement ownership | Passed |
| Syntax/load/main-loop smoke | Passed |
| `git diff --check` | Passed |

The diagnostic cases cover structured data, deduplication, retention/size limits,
fallback cleanup, asynchronous/conflicting/malformed segments, activation/write
failures, periodic flushes, resets, normal Memory deserialization, OFF/severity/
PROFILE controls, frozen exports, logger/namespace/error failures, phase isolation,
movement/job/economy events, cadence and dashboard error summaries.

Geometry checks inspect mock draw coordinates, panel intersection, text width
and bounds, long strings, missing/empty data, saturated population/resource/remote
rows, mode switches and stale decisions. They cannot establish exact live font
metrics or world-label readability. The mock CPU provider supplies controlled
values; no live game CPU performance, spawn success, resource delivery or server
integration result is claimed.

## F. User instructions

Use [SUSHI-OPERATIONS.md](SUSHI-OPERATIONS.md) for the complete steps to deploy,
enable NORMAL/DEBUG/temporary PROFILE, change dashboard modes, inspect recent
errors and CPU, freeze/print JSON chunks, and share a room/CPU snapshot plus a
current screenshot. Do not treat this review checkout or its commits as a game
deployment. Copying into the original watched directory is an explicit future
deployment action.

## G. Repository status

The implementation, dashboard, and documentation are recorded in logical local
commits on `codex/black-box-dashboard-v2`. Commit identities and the complete file
inventory follow below. No push or pull request was made. The original watched
checkout is unchanged and clean. Deployment and live validation remain pending.

### Complete final validation command inventory

Each script below completed successfully in `npm run validate` (exit 0).
The full output, including named cases, is in [validation/final.log](validation/final.log).
The original pre-change run is in [validation/baseline.log](validation/baseline.log).

| Script | Result |
| --- | --- |
| `test/strategy-provider.js` | Passed |
| `test/run.js` | Passed |
| `test/phase2.js` | Passed |
| `test/phase3.js` | Passed |
| `test/phase4.js` | Passed |
| `test/phase5.js` | Passed |
| `test/phase6.js` | Passed |
| `test/phase8.js` | Passed |
| `test/phase9.js` | Passed |
| `test/economy.js` | Passed |
| `test/local-economy-recovery.js` | Passed |
| `test/memory-schema.js` | Passed |
| `test/lifecycle-spawn-gc.js` | Passed |
| `test/controller-growth.js` | Passed |
| `test/artificer-controller.js` | Passed |
| `test/growth-corrections.js` | Passed |
| `test/remote-economy.js` | Passed |
| `test/remote-routing.js` | Passed |
| `test/remote-integration.js` | Passed |
| `test/remote-reliability.js` | Passed |
| `test/scout-bootstrap.js` | Passed |
| `test/remote-container-bootstrap.js` | Passed |
| `test/remote-multiple-extractors.js` | Passed |
| `test/module-graph.js` | Passed |
| `test/movement-audit.js` | Passed |
| `test/surplus-investment.js` | Passed |
| `test/population-capacity.js` | Passed |
| `test/body-scaling.js` | Passed |
| `test/combat-diplomacy.js` | Passed |
| `test/resource-policy.js` | Passed |
| `test/spawn-pipeline.js` | Passed |
| `test/spawn-memory.js` | Passed |
| `test/audit-regressions.js` | Passed |
| `test/power-pipeline.js` | Passed |
| `test/diagnostics.js` | Passed |
| `test/season-retirement.js` | Passed |
| `test/dashboard-layout.js` | Passed |

### Local commits

- `f3e971f` — retire Season 11, add the recorder, recovery/reporting fixes and regressions.
- `28402a5` — dashboard layout engine, modes, geometry tests and mock previews.
- The final documentation commit contains this report, the archive notices and validation logs; see `git log -3 --oneline` for its identity.

Push: **not performed**. Pull request: **not created**. Deployment: **not performed**.
Live verification: **pending**. The original watched checkout remained clean.

### Complete file inventory relative to the starting commit

A = added; M = modified; D = removed.

| Status | File |
| --- | --- |
| M | `BodyProfiles.js` |
| M | `COMBAT-DIPLOMACY.md` |
| M | `Combat.Operations.js` |
| M | `Combat.ThreatLedger.js` |
| A | `Diagnostics.View.js` |
| A | `Diagnostics.js` |
| A | `ENGINEERING-REPORT.md` |
| M | `HIVEMIND.md` |
| M | `HiveMind.Economy.js` |
| M | `HiveMind.Memory.js` |
| M | `HiveMind.Operations.js` |
| M | `HiveMind.Strategy.js` |
| M | `HiveMind.Telemetry.js` |
| M | `Logic.Expansion.js` |
| D | `Logic.Season11.js` |
| M | `MEMORY.md` |
| M | `POPULATION-CAPACITY.md` |
| M | `RESOURCE-STRATEGY.md` |
| M | `Resource.Manager.js` |
| M | `Resource.Minerals.js` |
| M | `Resource.Observer.js` |
| M | `Resource.Policy.js` |
| M | `Resource.Terminals.js` |
| M | `SEASON11-HARDENING.md` |
| M | `SEASON11-STRATEGY.md` |
| M | `SEASON11.md` |
| A | `SUSHI-OPERATIONS.md` |
| A | `Season.Retirement.js` |
| D | `Season11.Adapter.js` |
| D | `Season11.Operations.js` |
| D | `Season11.Portfolio.js` |
| D | `Season11.ResourcePolicy.js` |
| D | `Season11.Strategy.js` |
| M | `Spawn.Arbiter.js` |
| M | `Squad.Quad.js` |
| M | `Strategy.Provider.js` |
| M | `Tick.Bootstrap.js` |
| M | `Tick.Creeps.js` |
| M | `Tick.Planning.js` |
| M | `Visual.Dashboard.js` |
| A | `Visual.Layout.js` |
| A | `dashboard-preview.png` |
| A | `dashboard-preview.svg` |
| M | `main.js` |
| M | `package.json` |
| M | `role.Artificer.js` |
| M | `role.MineralMiner.js` |
| D | `role.ReactorClaimer.js` |
| M | `role.ResourceCourier.js` |
| D | `role.ThoriumHauler.js` |
| D | `role.ThoriumMiner.js` |
| M | `role.Volley.js` |
| M | `role.creepBodyConfig.js` |
| M | `spawn.manager.js` |
| M | `spawn.request.manager.js` |
| D | `test.Season11.js` |
| M | `test/body-scaling.js` |
| A | `test/dashboard-layout.js` |
| A | `test/diagnostics.js` |
| M | `test/local-economy-recovery.js` |
| M | `test/memory-schema.js` |
| M | `test/phase2.js` |
| M | `test/phase4.js` |
| D | `test/phase7.js` |
| M | `test/phase9.js` |
| M | `test/population-capacity.js` |
| A | `test/power-pipeline.js` |
| M | `test/resource-policy.js` |
| M | `test/run.js` |
| M | `test/scout-bootstrap.js` |
| A | `test/season-retirement.js` |
| D | `test/season11-power-pipeline.js` |
| M | `test/spawn-memory.js` |
| M | `traffic_manager.js` |
| M | `utility.Travel.Creep.js` |
| A | `validation/baseline.log` |
| A | `validation/final.log` |
