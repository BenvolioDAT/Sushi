# Sushi room intelligence and architecture review

Reviewed and implemented locally on November 6, 2026. No Screeps deployment was initiated.

## What already worked

- `utility.scanRoom` merges source/controller/mineral observations into existing room records, preserving assignments and logistics metadata. Terrain seats were already saved alongside each source, rather than assuming every room has two sources.
- `HiveMind.Index` provides an automatically rebuilt, heap-only tick snapshot of structures, creeps and other dynamic objects.
- `HiveMind.Economy` computes source demand from regeneration, caps useful WORK per source, distinguishes active/stationed/incoming capacity, estimates transport demand, and accounts for source Links and backpressure.
- `Harvest.Planning` already compares theoretical demand with seats, body affordability, active spawning capacity, pending requests and named replacements. `Spawn.Sizing` bounds preferred-body waiting and supports emergency bodies. These systems were retained.
- The existing economic recovery policy protects harvesting, hauling and controller survival while allowing bounded infrastructure work when spawning capacity limits production.
- Remote planning already owns routing, terrain travel estimates, reservations, source portfolios and income evidence. `Remote.Intel` ages unseen controller observations and requests new vision. These responsibilities were retained.

## Problems found and corrections

| Finding | Implemented correction |
| --- | --- |
| Local seat assignment and container placement had their own weaker seat conversions. They could reuse a blocked remembered tile or accept an inappropriate coordinate. | Both now consume `utility.getValidSourceMiningSeats`, also used by local harvest planning and remote capacity. Remembered seats and container stations must still pass the current validator. |
| Container-source assignment admitted at most two miners even when harvesting demand planned more weak workers across available seats. | Assignment now uses validated physical seats and the source's WORK target. The primary container station and named replacement lifecycle remain intact. |
| Seat validation omitted adjacent natural objects and repeated tile checks across consumers. | It excludes sources, minerals and controllers as well as blocking structures and private hostile ramparts. Results are shared for the current tick. Roads, containers, friendly/public ramparts, temporary creep occupancy and unfinished construction sites retain their proper meanings. |
| A valid zero-seat scan was treated as broken data and rebuilt repeatedly. Nonempty legacy geometry could remain incorrect. | The existing source record gets a small `seatVersion` marker. A normal scan repairs legacy geometry once; a valid zero remains valid. No parallel persistent room/source registry was added. |
| Repeated source/mineral enumeration was scattered across cooperating consumers. | Lazy source and mineral lists extend the existing tick index. Seat checks, room scanning, economy, Scout floors and local spawning reuse them. Remote route validation/cost matrices reuse indexed structures rather than introducing duplicate scans. |
| Source WORK formulas were duplicated, and Extractor admission used a default five-WORK target rather than each live source's demand. | `utility.getSourceHarvestProfile` supplies capacity, regeneration, harvest rate, average income and required WORK. Economy, local demand, harvest planning, assignment and local Extractor admission use the same formula. Admission also respects current seats. |
| Economic Scout eligibility required two miners regardless of the room's actual source count, and two miners at one source could satisfy the count. | The floor follows accessible sources and requires an assigned working miner for each. One-source rooms can qualify with one miner; three-source rooms require coverage of all three. Sources with no physical seats do not create an impossible floor. |
| Remote selection could trust old `numOpen` even after visible structures blocked a source. Contradictory saved counts could also override explicit valid coordinates. | Remote selection/demand use the shared validator while visible. Coordinate records take precedence over stale count fields. Last-observed access limits remain conservative without vision; a blocked source requests new intel and requires fresh observation to clear the limit. Unknown or explicitly zero counts no longer imply one seat. |
| Remote keeper income was halved because it lacked a reservation, despite those rooms having a different source-capacity regime. | Only normal remote rooms receive the unreserved-room reduction. Keeper income retains its full base capacity. |
| Local source-to-dropoff distance estimates were cached indefinitely, and replacement dropoffs could accumulate entries. | Estimates expire after 500 ticks, refresh sooner when the dropoff position or visible structure count changes, and discard obsolete targets for the same source. Path searches remain bounded at 2,000 operations. |

The source-capacity distinctions and regeneration formula were checked against the official [Screeps Source documentation](https://docs.screeps.com/api/#Source): owned/reserved, unreserved and center rooms have different base capacities. Structure blocking rules follow the official [API reference](https://docs.screeps.com/api/#Constants).

## Ownership and refresh policy

| Intelligence | Owner and lifetime | Reason |
| --- | --- | --- |
| Source identity/position and adjacent terrain seats | Existing `Memory.rooms[room].sources`; versioned repair during room scans | Geometry is durable, tiny, and useful without vision. Existing operational fields remain in the same records. |
| Visible source/mineral objects and structures | `HiveMind.Index`; lazy source/mineral lists, rebuilt each tick | Live objects stay out of Memory. Participating consumers share observations without keeping stale object handles. |
| Currently usable source seats | `utility`; heap cache discarded each tick | Buildings and rampart access can change. Coordinate and planned-station changes also invalidate within the tick. Returned arrays are copies so callers cannot reorder or remove cached seats. |
| Source production and required WORK | Shared utility formula, computed from current source capacity | This is cheap arithmetic; caching it across ticks would risk stale reservation/capacity data. |
| Local source travel distance | Existing economy-distance records; bounded refresh | Pathfinding is substantially more expensive than arithmetic or eight adjacent-tile checks. Each source keeps one current target entry. |
| Controller ownership/reservation, remote access ceilings and route validity | Existing `Remote.Intel` / `Planner.Remote` | Unseen evidence remains explicitly limited by observation. No claim of current structure knowledge is made without vision. |
| Economic decisions and spawn lifecycle | Existing Economy / Harvest / Spawn modules | Intelligence does not acquire a second queue controller or issue creep actions. |

The shared utility accepts either a live source position or the existing source-memory position. Local harvesting and remotes already use it; future expansion assessments can consume the same geometry without copying seat logic. Expansion scoring remains an existing strategic heuristic rather than a new profitability framework.

## Validation

`test/room-intelligence.js` adds 23 scenarios and is included in `npm test`, `npm run validate`, and `npm run test:room-intelligence`.

- Zero, one, two and three sources; 1,500 / 3,000 / 4,000 / zero energy capacity; room boundaries; plain/swamp/wall terrain.
- Legacy record repair, valid zero seats, duplicate/malformed/wrong-room coordinates, natural obstacles, structures, public/private ramparts and covered container stations.
- Remembered-seat invalidation; admission of a third weak container miner when WORK and seats allow it; source-targeted recovery without duplicate requests.
- One-source and three-source Scout floors, duplicate assignments, and a physically sealed source.
- Visible remote access loss, regained access, loss/reacquisition of vision, retained blocked observations, and keeper versus normal unreserved income.
- Cache refresh, same-tick plan repairs, global resets, bounded distance refresh and obsolete dropoff cleanup.
- Operation-count checks: 100 queries for an eight-seat source perform eight structure-tile inspections in one tick; source and mineral lists are enumerated once by participating consumers. Static zero-seat geometry is not rescanned on the next normal scan.

Existing fixtures that supplied counts without corresponding live sources or path results were updated to supply the actual room data being tested. Their behavior assertions remain in place. The remote seat-limit fixture now removes the physical seat as well as changing the old count field.

`npm run validate` passed all 40 validation commands with 571 reported PASS entries, including all 23 new room-intelligence scenarios. The complete result is recorded in `validation/room-intelligence-final.log`.

This includes 27 harvesting-capacity scenarios, 22 spawning-intelligence scenarios, remote route scan-count checks, economic recovery, and the existing 900-cycle combined miner/hauler-loss simulation. That controlled simulation recovered at cycle 878, made 26 spawns, peaked at four queued requests, and completed two handoffs. The dependency audit resolved all 107 modules with zero cycles; all 14 movement/pathfinding call sites met the movement ownership contract. Changed JavaScript files also passed syntax checks, and `git diff --check` passed. Automated game mocks do not establish live CPU use or resolved game-engine movement.

## Remaining limits and future considerations

- A valid adjacent tile is a physical seat, not proof that a miner can reach it from the base. Full room connectivity, mutually shared seats between unusually close sources, and route throughput are not solved by this small local geometry cache. Existing routing/movement owns travel. A connectivity solver should be justified by observed failures before adding its CPU and cache-invalidating complexity.
- Local hauling remains an estimate based on route distance, load/unload allowance, source income and transport mode. It does not yet calibrate local swamp/traffic travel per hauler body as remote routing does. A failed/budget-limited local path search retains a range estimate; it does not declare the source permanently inaccessible.
- The distance cache detects structure-count changes immediately at the next sample. A same-count topology replacement can wait until the 500-tick expiry. Simultaneous structural changes can refresh multiple source paths; live profiling is still needed to establish their CPU cost.
- Source production uses ordinary unboosted harvesting and natural regeneration. Power effects, boosted WORK throughput, hostile competition and intermittent source disruption are not modeled as extra sustainable production capacity here.
- Without vision, terrain seats are an upper bound. Remote access uses the last observed ceiling and retains known blocked access until refreshed, but cannot discover new obstacles in an unseen room.
- One-time geometry repair still runs through the existing room scanner. Source-only records can use validated fallback geometry before that scan, but correcting an incomplete explicit legacy seat list requires a room scan.
- Expansion candidate ranking still weighs source count, distance, spacing and strategic resources rather than running full harvest/haul profitability analysis. Reusing the shared geometry there is a suitable later extension if candidate selection evidence warrants it.
- Remote room classification still conservatively groups the sector-center region with keeper rooms. This review corrects the capacity reduction for that existing group; it does not introduce a separate center-room eligibility policy.
- Live harvesting handoffs, traffic, delivered income and the actual 20 CPU/tick budget remain unverified. No upload, deployment or live server action was performed.
