# Sushi operational audit — November 10, 2026

## Executive summary

Implemented targeted construction and NPC-safety corrections, preserving the current economy, hauling, spawn, movement and job architecture. Observed the official client on shard3, branch Sushi, and collected console diagnostics from the running colony. This is an implemented audit of the paths described below, not a claim that every possible colony state has been validated.

The two eastern-source containers and two controller containers are real. Tests reproduced a current planner defect capable of producing this result: the room planner ignores existing container construction sites when selecting positions, and its construction release checks only the selected tile. Utility can therefore build one location while an older room plan subsequently builds another. The correction adopts existing sites and checks the infrastructure's purpose again before releasing a new site. Historical logs do not prove which invocation created each particular live duplicate.

The other major correction prevents unsupported NPC clearing missions and ordinary remote-defense missions from becoming accidental stronghold assaults. The previous viability calculation treated requested combat capability as a ready army. The WORK-only CoreBreaker deliberately did not dismantle an Invader Core, leaving that worker unable to damage its objective. Core observations now persist across lost vision, clearing remains explicitly unsupported, and existing clearing/remote-defense missions at core installations withdraw through the established cancellation paths.

The largest observed economic constraint remains hauling and CPU admission, rather than local source WORK or empty controller containers. A separate harvesting defect was also corrected: waiting until CARRY was full forced an unload-only tick. Miners now attempt an in-place transfer of existing cargo shortly before filling, allowing a simultaneous harvest. No matrix dispatcher, workforce reset, container demolition, live Memory reset, or unrelated rewrite was introduced.

## Current architecture and responsibilities

| Area | Implemented ownership and behavior |
| --- | --- |
| Tick orchestration | `main` calls Bootstrap, Planning, Rooms, Creeps and Finalize. Threat observation precedes strategy; traffic resolves movement after roles. |
| Shared state | `HiveMind.Index` supplies tick-local creeps, structures, hostiles, sources and sites. Durable JSON records live in Memory; heap caches rebuild after reset. |
| Strategy | ColonyState controls lifecycle/alerts. Economy controls income, hauling demand, reserves and spending permission. Operations and Strategy coordinate persistent objectives through utility and economy gates. |
| Spawning | Producers feed DemandBoard/Arbiter and existing queues. Policy, Capacity, Sizing and the spawn consumer revalidate execution. Existing renewal/consolidation helpers forecast replacements without retiring productive predecessors. |
| Harvesting | Harvest.Planning computes seats and WORK demand. Extractor/utility.Creep assign stations, perform handoffs and offload; remote lanes remain canonical for remote miners. |
| Logistics | Logistics.Index coordinates pickup/delivery reservations and shared candidates. Freighters select prioritized work; the Foreman protects local filling. Explicit transport jobs and mineral couriers remain distinct. |
| Construction | Planner.Brain builds staged room plans and releases a bounded number of prioritized sites. Utility also maintains source containers. Planner.Remote owns remote station/route geometry; Roads consumes that geometry. |
| Work jobs | Artificer manages build/repair assignments and fallback work. Tech consumes controller energy and holds a productive station. Neither is replaced by a new logistics scheduler. |
| Movement | Roles request movement through utility.Travel.Creep. Traveler/path caches support travel; traffic_manager owns final movement resolution. |
| Combat | Policy and Math classify threats and effective combat power. ThreatLedger generates defense objectives. WarRoom, independent roles, duos/quads and tower logic execute defense. Core/stronghold clearing is now explicitly excluded from automatic execution. |
| Maintenance | Scheduler staggers optional work; MemoryGC bounds known records; Diagnostics and Telemetry expose decisions and costs. |

Overlapping source-container ownership was the confirmed construction conflict. The fix coordinates those existing producers through adoption and release-time checks, without adding a competing planner.

## Live observations and baseline

Inspected the running desktop client, including its room view, Script branch, Console, colony dashboard, container inventory and remote diagnostics. The client initially resisted input because of stale window bounds; raising the current window restored useful interaction. Read-only console commands were used for measurements. No artificial Invader was spawned into the live colony.

At tick **84199647** the runtime identified build `23050e014b752497d53d41ef97a7f6257c584289a52ce7a82cc975ea74ab1bcf`, 109 modules. Visible rooms were W38S47, W39S47 and W39S48. The dashboard showed RCL4, RECOVERY, full local source WORK and a logistics constraint.

| Baseline measurement | Value |
| --- | ---: |
| Current reported tick CPU | 19.19 / 20 |
| Rolling CPU, 1,000 reported samples | 16.39 / 20 |
| CPU bucket | 7,815 |
| Rolling economy phase CPU | 3.73 |
| Rolling spawn-planning CPU | 2.81 |
| Rolling creep-execution CPU | 4.61 |
| Rolling traffic CPU | 1.79 |
| Stored energy | 102,467 |
| Safe reserve target | 6,800 |
| Local gross income estimate | 20 energy/tick |
| Proven remote income estimate | 4 energy/tick |
| Remote required / available CARRY | 23 / 13 |
| Controller progress rate reported | 2.89/tick |

Phase fields overlap: planning includes subphases, so do not sum every displayed column. A diagnostic invocation itself consumes CPU; these are observations, not isolated benchmarks.

At tick **84199652**:

| Location | Containers | Observed energy |
| --- | --- | --- |
| W39S47 source at (10,3) | (9,4) | 536 |
| W39S47 source at (32,24) | (33,24), (31,24) | 419, 0 |
| W39S47 controller at (7,35) | (5,33), (5,34) | 2,000 each |
| W38S47 source at (25,45) | (25,44) | 218 |
| Other visible remote sources | No built source container in the queried range | — |

There were no visible hostile creeps or cores in those three rooms at that observation. Thus no live combat success or retreat-under-fire was observed.

At tick **84199719**, remote diagnostics showed four selected active source routes, but only two staffed sources: one W38S47 source with three WORK and thirteen assigned CARRY, and one W39S48 source with three WORK and no assigned CARRY at that moment. That second route reported INSUFFICIENT_HAUL. Two other selected routes had no miner and reported SPAWN_CAPACITY_SHORTAGE. Selection/route usability is not proof of productive income. Reported net EPT figures (approximately 3.67 and 4.00 for the staffed routes) are planner estimates, not measured realized profit.

The two local miners each had five WORK. Remote miners each had three WORK. Existing logic was observed spawning a 100-energy Freighter and later a 900-energy Freighter; this audit did not cause those births. Workers changed positions between observations, and replacement production continued. Those observations establish activity, not an absence of congestion or long-term death loops.

## Confirmed defects and implemented corrections

| Severity | Defect and root cause | Correction | Verification |
| --- | --- | --- | --- |
| Medium | Local and remote miners used mutually exclusive harvest/unload branches, losing a harvest tick whenever CARRY filled. | Transfer existing cargo before the full-store boundary and harvest with the available starting capacity. Preserve full/missing-sink fallbacks. | Three throughput models use start-of-tick intent semantics, including full sinks and stationary movement. |
| High | Stronghold approval derived desired DPS/healing from the opponent, then evaluated those desired numbers as capability. No actual force-readiness proof was required. | Reject automatic clearing, distinguish lesser cores, prevent discovery from creating missions, clear legacy execution demands and abort existing missions. | NPC safety suite covers levels 0–5, unknown level, huge imaginary capability, invulnerability and legacy orders. |
| High | A core with no hostile creep could lose its route exclusion after vision disappeared; the unseen-room path gate lacked a durable core record. | Persist `{id, level, observedAt}` from combat observation and planner fallback. Block unseen known-core rooms and request intel; clear only after fresh visible absence. | Lost-vision, 2,000-tick aging, module-reset and safe-observation regression. |
| High | Stronghold defender creeps could independently trigger ordinary DEFEND_REMOTE operations, bypassing clearing restrictions. | Preserve harmful-threat reporting, suppress automatic engagement at remote core installations, and abort their ordinary remote-defense operations. Home defense remains available. | Regression proves cancellation and ordinary remote-defense availability after core removal. |
| Medium | Source/controller position selection reused built containers but ignored pending sites. `canPlanAt` correctly rejects an occupied site, so simply selecting that site would also fail to record it. | Reuse built containers first, then pending sites; preserve the saved station among existing duplicates. Adopt sites through plan recording. | Container suite reproduces the pre-fix selection failures and verifies adoption. |
| Medium | Stale planned coordinates could build a second container after another producer created one elsewhere. Exact-tile checks did not protect the source/controller function. | Check nearby infrastructure serving that source/controller immediately before site creation. | Built-container and pending-site regressions, plus missing/unrelated infrastructure cases. |
| Medium | Disabled CoreBreakers stayed idle wherever they were; their WORK body could not damage the core. | Remove clearing spawn demands and return disabled/terminal independent CoreBreakers toward home. | Role regression verifies the homeward travel request. |
| Medium | Clearing execution dereferenced `remainingNpc.length` without guarding lost visibility. | Only complete on visible absence of both core and defenders; revoke unsupported missions otherwise. | Lost-vision regression verifies no exception or false completion. |

No historical causal claim is made for the individual built duplicates. The code paths above are reproduced causes capable of generating duplicates, and are corrected prospectively.

## Container, harvesting and controller assessment

One suitably placed source container is the normal policy. Additional buffers do not increase the source's regeneration rate. Existing WORK demand is source-output based: a normal owned 3,000-energy source over 300 ticks needs five unboosted WORK at two energy per WORK per tick; a normal unreserved remote needs three WORK to cover its lower average output. Seats constrain how that demand is staffed. More workers or more containers alone do not fix transport capacity.

The eastern duplicate is preserved because the current mining code can use an existing second container as a supplemental seat. The controller pair is preserved because both hold usable energy. Neither is removed merely to make a diagram cleaner. Full controller buffers at the sampled tick do not support a diagnosis of controller-delivery starvation.

Existing local Freighter delivery tiers include spawn/extensions, towers, controller containers and storage, with shared energy reservations. Tech selects stocked controller containers from the room index and protects a productive upgrade/refill tile. Links have a later-RCL role in the existing planner; this audit does not destroy containers before a replacement supply path exists.

The new construction guard acts on source/controller containers. It does not claim to have redesigned mineral-container placement, source/controller overlap geometry, automatic container retirement, or all higher-RCL layouts.

## Logistics comparison and decision

Reviewed the supplied transcript of [Logistics in Screeps](https://www.youtube.com/watch?v=uQsSXYxniCo), including assignment coordination, matrix normalization, recalculation triggers and simplified simulations. The transcript's simulation omits collisions, terrain variation and creep death; its results cannot establish a speedup for this colony.

| Approach | Practical assessment for Sushi |
| --- | --- |
| Existing implementation | Already combines a dedicated Foreman, local/remote Freighters, shared reservations, sticky destinations, distance estimates and cached route geometry. Keep this foundation. |
| Priority requests with reservations | Already substantially present. Added coverage for competing deliveries, partial cargo, death, target loss and spawn-refill preemption. |
| Fully pooled global assignment | More flexibility, but adds cross-room cost, safety and service-guarantee complexity. No measured benefit established here. |
| Video-style matrix assignment | Potentially useful for dense request clusters, but requires an appropriate benchmark and tuning; normalization is not a free CPU improvement. |
| Hybrid critical service plus flexible hauling | Best fit to current evidence. Preserve Foreman/service floors and coordinated Freighter reservations rather than introducing a new dispatcher. |

Partial loads can reserve a shared larger delivery deficit. A newly available spawn refill preempts an existing lower-priority controller destination. Death and disappeared targets release claims through tick-local reconstruction. Tests establish these decisions; they do not model engine traffic or guarantee optimal routes.

## Construction, remotes, combat and waste review

The room planner uses RCL unlocks, a staged plan, CPU/bucket gates, a three-site-per-run limit, a global site limit and infrastructure-before-bulk-road ordering. The remaining structure categories retain their existing modules. No evidence justified replacing that architecture or deleting planned roads during this audit.

Remote discovery, ownership/reservation intel, route validation, source profitability estimates, staged selection and source-specific production/hauling demand remain in Planner.Remote/Economy. Existing tests cover miner commitments, stale backlog, replacement timing, source output caps and queue/admission behavior. Persistent core exclusion improves their safety lifecycle without interpreting elapsed time alone as clearance.

Ordinary NPC-creep defense retains boosted body analysis, damage/healing estimates, tower support, operations and duo/quad controllers. Core installations now have a distinct unsupported-clearing outcome. This includes level-0 cores: the audit supplies safe avoidance, not a falsely advertised cheap clearing attacker. A real low-core attacker needs attack/ranged damage, lifetime/travel feasibility, capability guarantees, target and cancellation behavior, and integration tests before enabling it. Higher stronghold siege needs a substantially stronger force-readiness implementation.

The main observed CPU costs are economy, spawn planning, creep execution and traffic. No numeric CPU saving is claimed from this patch. Next profiling should distinguish repeated economy/commitment calculation from necessary live revalidation. Do not disable traffic or weaken recovery floors merely to make the CPU display smaller.

## Tests and performance comparison

The original validation suite passed before changes. Container regressions then failed against the original planner and passed after the correction. New NPC, throughput and logistics suites exercise the changed safety behavior and existing reservation guarantees. Final validation passed **142 checks: 140 named scenarios plus module-graph and movement-ownership audits**. This includes 26 new scenarios (7 container, 11 NPC safety, 5 logistics reservations and 3 throughput). All 109 root runtime modules passed `node --check`; `git diff --check` passed. No final test failures remain. Intermediate failing cases were corrected before creating the final deployment plan.

The complete final validation output is `validation/deployments/2026-11-11T04-20-00-050Z/validation.log`, also copied to `validation/operational-audit-validation.log`. The scenarios are deterministic mocks and capacity models; the private engine was unavailable, and no production hostile battle or controlled live before/after throughput benchmark was run.

| Measure | Before | After / evidence limit |
| --- | --- | --- |
| Idealized 300-tick local harvesting | 2,500 energy | 3,000 with five WORK, 50 CARRY capacity and an available sink |
| Idealized 300-tick remote harvesting | 1,500 energy | 1,800 with three WORK, 50 CARRY capacity and an available sink; actual unreserved-source regeneration still caps sustained output |
| Pending container-site adoption | Failed reproduced source/controller cases | Passes deterministic regressions |
| Stale container-plan release | Could create a second functionally equivalent container | Blocked in deterministic regressions |
| Core exclusion without vision | No persistent core-specific gate | Retained across reset/aging until visible clearance |
| Unsupported clearing demands | Legacy WORK breacher and squad missions possible | Discovery emits none; legacy orders cancelled |
| Live CPU / delivery throughput | Baseline above | No controlled before/after engine benchmark yet |
| Remote defensive losses / recovery time | Not observed under attack | Safety decisions tested; no live combat experiment |

## Deployment and final checks

**Deployment was attempted and blocked by filesystem permissions. The official runtime is unchanged.**

The release tool validated the source, checked target provenance, backed up all 109 deployed modules, and prepared eight changed runtime files. Applying that plan failed on the first write to `scripts/screeps.com/Sushi/Combat.Operations.js` with EPERM. Its automatic rollback also lacked permission to write the target; a subsequent full inventory hash comparison proved that all 109 official-folder modules still exactly match their pre-attempt hashes. No partial release was left behind.

| Release item | Status |
| --- | --- |
| Authoritative project | Updated and validated |
| Prepared build | `5d35cd2adb57c4cc27858879ba066814b043fa3e14a9a207523621bcf793d86e`, 109 modules |
| Changed files | Combat.Operations, Combat.Stronghold, Combat.ThreatLedger, Planner.Brain, Planner.Remote, role.CoreBreaker, role.Extractor, Runtime.Build |
| Plan and verified backup | `validation/deployments/2026-11-11T04-20-00-050Z/` |
| Official local runtime copy | Blocked; target unchanged |
| Server receipt of new build | Not achieved |
| Live verification of changed behavior | Not achieved because deployment was blocked |

From the authoritative project folder, the prepared release can be applied in a normal user PowerShell session:

```powershell
npm run deploy:apply -- "validation\deployments\2026-11-11T04-20-00-050Z\plan.json"
```

The command rechecks source, target and backup hashes before writing. If anything changes first, create and review a new plan with `npm run deploy:plan`; do not bypass its drift checks. After copying, confirm official-server branch Sushi synchronization and `Sushi.debug.build()` against the prepared build ID. Then observe miner transfer/harvest events, local deliveries and remote recovery over complete trips.

At the final live check, tick **84199888**, the server still reported the original build `23050e014b752497d53d41ef97a7f6257c584289a52ce7a82cc975ea74ab1bcf`, 109 modules. W39S47 had 1,300 spawn/extension energy, controller progress 58,018 and 18 living/spawning creeps across visible rooms. Current CPU was 14.59, rolling CPU 17.78 and bucket 7,918. These are additional observations of the **unchanged old build**, not improvement measurements. No runtime exception appeared in the inspected console output during these observations.

## Remaining limitations

- Automatic lesser-core clearing and stronghold siege remain unsupported; safe avoidance can delay remote recovery until scouting confirms clearance.
- No live hostile/core encounter was present during the baseline. Combat safety corrections are covered by deterministic tests, not a live battle.
- Remote transport remained short of demand at the sampled tick. Existing replacement logic was active; long-term hauling recovery still needs observation over full trips and creep lifetimes.
- Existing duplicate containers remain, and their historical creation events are unavailable. Future retirement should be reviewed with actual consumers and cargo state.
- Higher-RCL layouts, every Artificer assignment failure, exact path congestion, actual remote profit and global matrix-dispatch benefits were not exhaustively simulated.
- The official server's slow ticks limit causal comparisons. Successful upload and a quiet first few ticks cannot prove long-term performance improvement.
- This session could not write the official deployment directory. Apply the verified release before attributing any live behavior to these fixes.

## Mechanics references

- [Official NPC Invaders documentation](https://docs.screeps.com/invaders.html): raids, strongholds and lesser cores.
- [Official API reference](https://docs.screeps.com/api/): source regeneration, harvesting, container storage and Invader Core deployment/invulnerability.
- [Official simultaneous actions documentation](https://docs.screeps.com/simultaneous-actions.html): independent action pipelines and start-of-tick CARRY semantics used by the throughput model.

Architecture changes are summarized in `docs/ARCHITECTURE_HANDOFF.md`. Tests remain executable through the project's validation command.
