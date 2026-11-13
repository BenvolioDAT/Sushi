# Controller positioning audit — November 12, 2026

## Scope and baseline

Observed the native Screeps client, room W4N3, using console `Game.time`, visuals and existing Sushi diagnostics. The executed baseline was the 116-module `2871b12c1eceab25dc150e4b7c96c220195dabee7622c8a581e80cf5d7956044` build. Observation began at **2,218,417** and the last pre-deployment position snapshot was **2,220,670**: **2,253 ticks**. The user had respawned in W4N3; the previous W1N7 audit is historical.

The controller is at (6,34). Range three is sufficient to upgrade; moving every productive Tech closer would waste movement and displace useful stations. However, this queue included genuinely blocked workers:

- At 2,218,609, Tech_003 at (10,31) and Tech_002 at (10,32) each held 50 energy with upgrading=true, outside range. Tech_001 at (9,32) held 48 and was within range. Tech_004 (8,34) and Tech_005 (9,33) were empty.
- Existing diagnostic records at 2,218,867–869 reported 506–534 stuck ticks for those empty Techs trying to refill at container (9,31), and 546–547 for Tech_002. A successful move intent did not imply actual displacement.
- At 2,219,696, a later Tech_003 generation was at (10,32), loaded with 100 energy and outside range; Tech_002 at (8,31) could upgrade. Controller progress was 20,822.
- At 2,220,670, Tech_004 at (10,32) and Tech_005 at (10,31) remained outside range with 50/100 energy. Tech_003 (8,32) and Tech_001 (9,32) were inside range. Progress was 25,059.

Root cause: identical range goals and creep-ignoring cached approaches converged on occupied boundary/refill tiles. Productive station locking was intentional, but arriving/refilling creeps did not select alternative reachable work tiles. Container (9,31), on the edge of upgrade range, has fewer tiles satisfying both refill and upgrade reach than the full controller area.

## Implemented behavior

`role.Tech.moveToControllerStation` selects a reachable unoccupied range-three tile near the controller, or a tile satisfying both range-three upgrading and range-one withdrawal when refilling. It excludes terrain walls, controller/resources, blocking structures, sites, hostiles, ordinary/power creep occupancy and destinations already reserved that tick. Owned/public ramparts, roads and containers remain walkable. Tick-index reservations expire naturally; no persistent Memory fields or new scheduler are added.

Only approaches within six tiles enumerate the maximum 49 work positions. Selection uses bounded room-local pathfinding with current creeps; movement still goes through Traveler and traffic, with the shared range-goal route cache disabled for these approaches. Distant approaches and inaccessible/full station sets retain bounded range-goal fallbacks. Productive in-range workers keep their stations and the existing off-road refill optimization. Resource occupancy uses the index's lazy getters so it does not depend on another manager having scanned first.

Artificer controller fallback already depended on role.Tech for energy collection. It now reuses Tech's controller action/positioning too, replacing its previous default range-one approach. Home-room and economic policy gates remain with Artificer. Reviewed Extractor/MineralMiner stationary protections and Pioneer upgrading: miners use resource seats; Pioneer already requests range three and had no live instance demonstrating this bug. No speculative Pioneer or global traffic rewrite was made.

## Deployment and checks

The guarded local release changed only `role.Tech.js`, `role.Artificer.js` and generated `Runtime.Build.js`. It verified the destination as the requested `192_168_0_217___21025/Sushi` folder, checked baseline drift, retained rollback files and verified deployed bytes. Public-server folders were not targeted.

Executed build **59f4701b7b83691828b9caeeb5fd6e46dee6b0759ee87677a71af649c2b2de3e**, 116 modules, was confirmed by the game console at **2,220,842**. Staged suite: **299 PASS checks**. Five additional scenarios cover loaded arrivals, same-tick distinct reservations and expiry, joint refill/upgrade reach, occupancy/obstacles and unreachable fallback. Existing 120-tick stationary tests, policy gates, source protection, movement ownership and cycle checks remain in the suite. All 116 modules parsed.

Baseline retained probe samples (2,219,360–2,220,360) had late-tick CPU 41.69–77.91 and rolling CPU 46.93–67.86, with zero probe exceptions and three optional CPU-pressure skips. At 2,219,696 the full CPU report showed 66.84 rolling CPU, full 10,000 bucket, and Scout EMA 11.38 CPU including an incomplete 10,012-op path search. These are whole-colony measurements, not an isolated benchmark of station selection.

## Final live verification

The final console history check was at **2,222,584**, giving **1,742 ticks after the executed-build receipt** and **4,167 total observed ticks** from the initial baseline. Multiple intermediate snapshots and screenshots were collected throughout both windows. The final deployed-directory suite also passed **299 checks**; runtime identity and whitespace checks passed.

- At **2,221,418**, all five Techs occupied distinct upgrading-range positions: (9,31), (8,31), (9,32), (8,32), (9,33). Four were loaded/upgrading; the fifth was empty/refilling. The visuals also showed several simultaneous upgrade beams shortly after deployment and during later cycles.
- At **2,221,623**, controller progress reached 31,141. Local hauling had 18 living + 5 spawning CARRY for 22 required, with zero local no-progress workers. RECOVERY still deliberately reduced upgrade spending during replacements.
- At **2,222,411**, progress was **35,004**. One Tech continued upgrading at (9,32); three loaded Techs had upgrading=false and were away from the controller during economic-policy cycles. This is consistent with the pre-existing paused-Tech core-delivery behavior, not a renewed approach queue. These observations do not establish a controlled throughput improvement.
- At **2,222,584**, the retained post-release Tech incidents contained four spawn records and one five-tick movement warning for Tech_006 at **(24,23)** targeting **(31,24)**, away from the controller. No controller-position Tech block appeared in that retained query. History is bounded, so this is not a claim of zero traffic stalls throughout the colony.
- The post-release probe was enabled at **2,221,028**, until **2,222,228**, and confirmed **OFF/EXPIRED** at 2,222,411. Its cumulative sample count increased **54 → 65**, with **zero recorded exceptions** and one additional optional CPU-pressure skip. Eight final retained samples cover 2,221,429–2,222,129; the earlier query retained the first post-release samples too. Across those post-release observations, late CPU was **43.31–78.31**, rolling CPU **45.09–67.93**. CPU remained in the same broad range as baseline; workload and recovery changed, and no isolated CPU speedup is claimed.

Remaining constraints: the edge-positioned container has limited simultaneous sustainable refill tiles; additional loaded workers can upgrade elsewhere but must later travel for energy. Replacement/hauling recovery still interrupts spending, ordinary traffic can briefly stall, and Scout pathfinding remains a substantial CPU cost. No global congestion rewrite, container relocation, planner/body consolidation or Pioneer behavior change was justified by this scoped test. Diagnostic history was preserved; unresolved warnings were not manually erased.

Checkpoints, staged/final test logs, observations and release rollback data are in `validation/tech-positioning-20261113/`.
