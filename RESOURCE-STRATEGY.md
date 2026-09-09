# Resource economy strategy

Implemented against local and GitHub `main` at `7b920875a066c22794d73b6899488fd281677ff5` (verified before editing).

## Architecture and changed files

The existing Resource.Manager, Minerals, Terminals, Labs, DemandBoard, TickIndex, Economy, Season 11 portfolio, and dedicated Thorium roles remain in place.

New modules:

- `Resource.Policy.js`: empire inventory, stock hysteresis, demand accounting, hub selection, reaction planning, extraction decisions, and diversity bonus.
- `Resource.Storage.js`: shared configuration and live capacity checks; separate from the planner to keep the dependency graph acyclic.
- `Season11.ResourcePolicy.js`: finite extraction safety, predictive reserve hauling, safe owned Storage selection, and Reactor runway diagnostics.

Integrations:

- `Resource.Manager.js`: synchronizes squad boost requests, refreshes policy on its planning interval, submits reaction/transfer work through existing modules, and exposes terminal staging jobs to ResourceCouriers.
- `Resource.Minerals.js`, `role.MineralMiner.js`: gate ordinary extraction, cancel replacement demands and associated queued requests, deposit existing cargo, and retain idle miners without suicide/recycle loops.
- `Resource.Labs.js`: capacity guard and Storage-first unloading; existing reaction/boost state machines remain authoritative.
- `Resource.Terminals.js`: replace symmetry balancing with concrete shortages and pressure consolidation, stage outbound inventory, drain unused terminal stock, preserve capacity/send energy, and prevent rapid reverse sends.
- `Logic.Season11.js`, `role.ThoriumHauler.js`: continue finite acquisition within existing mining/CPU/spawn/route limits; prefer adjacent container staging and owned Storage; preserve startup fuel while adding Storage reserve delivery through the existing portfolio ledger.
- `role.ResourceCourier.js`, `Power.Operations.js`: Storage vault preference, working-stock-limited Power Spawn delivery, and completion only after the expected Power recovery total is delivered.
- `role.Scout.js`, `Logic.Expansion.js`: remember mineral type and add a small diversity bonus after economic eligibility checks.
- `Visual.Dashboard.js`: cached Resource Economy panel; no visual-only world scan.
- `HiveMind.Memory.js`, `package.json`: configuration entry and resource test commands.
- `test/resource-policy.js`: 36 deterministic resource strategy tests.
- `test/phase6.js`: existing lifecycle/logistics checks retained with capacity-safe fixtures and the new Storage destination expectation.
- `test/season11-power-pipeline.js`: existing miner-demand fixture now supplies the container free-capacity API.

## Defaults and configuration

Set overrides at `Memory.config.resources.policy`. All amounts are resource units.

| Resource | Resume below | Desired | Pause at/above |
| --- | ---: | ---: | ---: |
| H | 10,000 | 20,000 | 30,000 |
| O | 10,000 | 20,000 | 30,000 |
| U | 8,000 | 15,000 | 25,000 |
| L | 8,000 | 15,000 | 25,000 |
| K | 8,000 | 15,000 | 25,000 |
| Z | 8,000 | 15,000 | 25,000 |
| X | 15,000 | 25,000 | 40,000 |
| G | 5,000 | 10,000 | 10,000 |

G uses reactions, never mineral-miner demand. Its reserve target is not added to itself.

Other defaults:

| Setting | Default |
| --- | ---: |
| interval | 11 ticks |
| minimumStorageFreeCapacity | 100,000 |
| desiredStorageFreeCapacity | 150,000 |
| minimumTerminalFreeCapacity | 50,000 |
| terminalEnergyReserve | 20,000 after transaction costs |
| transferCooldown | 100 ticks per unordered room pair/resource |
| boostSafetyMargin | 0.25 |
| diversityBonus | 8 points, bounded to 10 |
| desiredReactorThorium | 900, capped at 1,000 |
| thoriumStagingDesired | 200 |
| thoriumStagingUrgent | 450 |

Terminals stage 5,000 extra Energy above the protected send reserve. Automatic resource sends are at most 1,000 units each, with a 100-unit minimum batch. The existing Power processing working target remains 25 Power; the existing processing energy target remains 2,500.

Example override:

```js
Memory.config.resources.policy = {
    stockTargets: { U: { resumeBelow: 8000, desired: 15000, pauseAbove: 25000 } },
    boostSafetyMargin: 0.25,
    minimumStorageFreeCapacity: 100000,
    minimumTerminalFreeCapacity: 50000,
    hubs: ['W1N1'],
    colonyNeeds: { W2N2: { X: 2000 } },
    compoundReserves: { XUH2O: 500 }
};
```

`hubs` prioritizes configured names among suitable owned colonies; it does not force an unsafe/incomplete room to become a hub. Compound reserves and colony needs are empty by default. No all-compound stockpile or Deposit harvesting operation is added. Season 11 manual extraction pause is `Memory.config.season11.pauseMining = true`.

## Inventory, hysteresis, and active demand

A plain snapshot lives at `Memory.hive.resources.policy`. It uses TickIndex owned rooms and structure lists once per interval. Inventory includes Storage, Terminal, Labs, Factory, Power Spawn, owned Reactors, and known adjacent mineral staging containers. Structures are counted once. Creep cargo is excluded from long-term inventory; Reactor continuity retains its separate in-transit accounting. Unseen owned Reactor fuel is aged from its last observation.

Each raw resource persists `MINING` or `PAUSED_TARGET_REACHED`, plus `stateSince`. Mining continues through the desired target until the high threshold. Once paused, it remains paused until inventory is strictly below the low threshold. Active miners unload cargo and stop harvesting; cancellation removes unstarted replacement demand/queue entries. Economy and live capacity checks can block mining independently of the inventory latch.

Boost demand is required parts times 30 mineral, plus a 25% configurable margin. Existing squad boost requirements feed the existing boost request registry. Matching reaction and boost goals use the maximum target rather than reserving the same goal twice. A shared inventory budget accounts for existing compounds and intermediates before recursively calculating missing ingredients through the existing `REACTIONS` data. Raw targets gain the resulting ingredient demand; compound targets follow current requests. Production uses `Resource.Labs.configureReaction`, selecting missing intermediates before products. A colony without suitable labs routes production to a suitable hub while retaining its final compound delivery need. Missing ingredients are exposed in lab and policy diagnostics.

G production starts below 5,000 and continues toward 10,000, with operational requirements able to raise that target. Existing G and intermediates reduce production needs. No automatic goal is created for every possible compound.

## Capacity, transfers, and hubs

Ordinary extraction stops if Storage is missing/inactive, free Storage is below 100,000, or an active Terminal has less than 50,000 free. Economy SURVIVAL/RECOVERY gates remain in force. Unnecessary reactions pause and their labs can unload into Storage. No resource dropping, disposal, or market selling is added.

Raw minerals remain in producer Storage until needed. Terminal sends require a concrete reaction, boost, configured colony shortage, or Storage pressure consolidation. Donors retain their own needs; transfer staging loads from Storage and unused Terminal inventory returns to Storage. Pressure consolidation requires another owned terminal colony with more than the desired Storage headroom plus a useful receiving buffer. Generic terminal jobs and sends exclude Thorium. Power is not distributed for symmetry.

Transfers validate ownership, economy, Terminal cooldown, incoming free-capacity reserve, and Energy remaining after transaction cost. Successful sends establish a 100-tick pair/resource cooldown in both directions. Transaction cost estimation is the only market API involved; there are no market orders, deals, or sales.

Hub ranking requires active owned Storage and Terminal, a compatible lab cluster, capacity headroom, and an economy permitting resource work. RCL and useful output lab count determine the score. Donors are chosen by transaction cost; raw stock is not centralized just because a hub exists.

## Expansion

Scout intel records mineral type. A missing renewable mineral adds 8 points to an otherwise eligible economic candidate; a duplicate adds zero. Existing ownership, threat, source, spacing, and route checks still run first. The bonus is smaller than the 12-point penalty for one route room. Valid Season 11 nominations still take precedence over economic candidate scores; manual and committed targets retain their existing priority.

## Thorium and Reactor continuity

Thorium ignores renewable stock thresholds, including when Storage already holds 25,000 or more. Existing operating mode, owned RCL6 infrastructure, mining-room limits, home readiness, CPU, spawn admission, route lifetime, and combat safeguards remain. Mining can pause for SURVIVAL at the source or home, manual pause, hostile combatants, unavailable safe delivery, depleted deposits, or container pressure. A Storage staging reserve is never subjected to the container pile limit.

Adjacent containers are transient staging, with Storage as the fallback staging/destination. Prediction is `currentStaging + miningRate * haulerETA`. Rate uses live active miner WORK and extractor cooldown, or a supplied observed harvest-rate estimate. Reserve hauling is requested from the existing spawn plan when the predicted staging stock reaches 200; prediction at 450 is urgent. Desired carrying capacity reflects forecast stock and round-trip production, bounded by existing route hauler limits and affordable bodies. Mining pauses at the 450 container guard until hauling creates room. This is an estimate, not measured live-shard throughput.

Dedicated haulers deliver to owned Reactors below the working target. Otherwise they preserve cargo in safe owned Storage. They never feed a visible unowned Reactor. Startup reservations may move from a small container into Storage, avoiding a startup-reserve/container-cap deadlock; immediate owned Reactor allocations remain protected. The existing shared fuel ledger can reserve Storage stock when staging is insufficient, and the same Reactor haulers withdraw it. Delivery telemetry records the requested amount that fits the Reactor target rather than all carried cargo.

Supply runway is observed Reactor Thorium minus elapsed ticks since observation, at one unit/tick. Required runway is delivery ETA plus replacement spawn delay plus 150 safety ticks. Telemetry exposes both, in-transit cargo, and a desired Reactor inventory bounded by its 1,000 capacity. The existing startup feasibility gate remains authoritative when requirements exceed capacity. Emergency hauler priority increases with `continuousWork`; the existing portfolio retains its continuity ordering and ownership protections.

## Power and Deposits

Power has no renewable stock cap. Existing Power Bank safety/profitability, economy, combat, spawn, timing, and haul feasibility remain unchanged. Recovered Power goes to the owned Power Spawn only up to its configured working need, then to owned Storage. No new Deposit or commodity acquisition planner is enabled without an explicit production plan.

## Manual traces

- **A — 28,000 U, no active demand:** above the 25,000 high threshold. Policy latches PAUSED_TARGET_REACHED; replacement demand is canceled; an existing miner deposits its cargo and stops harvesting.
- **B — 7,000 U after a pause:** below 8,000, so mining resumes. It continues through 15,000 toward 25,000 rather than toggling around the low threshold.
- **C — 4,000 X plus a combat boost request:** X is already below its 15,000 low threshold. Missing X-based production increases its effective target; eligible X miners run. Inputs move to the reaction colony/hub when its concrete need exceeds its inventory, and the resulting boost moves to the requesting colony.
- **D — 25,000 stored Thorium plus 12,000 unmined:** safe owned RCL6 extraction continues within existing operational limits. Stored quantity does not pause mining; a temporary container-pressure stop resumes after dedicated hauling drains the container.
- **E — 250 staging, 5/tick, ETA 60:** forecast is `250 + 5 * 60 = 550`. Request reserve hauling now; the forecast exceeds both the desired staging stock and urgent threshold.
- **F — Reactor stolen:** a visible enemy Reactor is never a delivery target. Carried Thorium goes to safe owned Storage. Dedicated reserve hauling can continue to drain safe staging while the existing Reactor strategy reevaluates ownership.

## Validation

The focused suite covers stock targets, state hysteresis, replacement cancellation/cargo deposit, demand de-duplication, existing intermediate stock, configurable X targets, Storage/Terminal pressure, no disposal, finite Thorium and SURVIVAL, generic Thorium exclusion, predictive dispatch, stolen/missing Reactor diversion, terminal shortages and cooldowns, send cost/headroom, hub selection, functional expansion ranking and Thorium precedence, finite Power storage, non-season safety, cached inventory accounting, G reaction planning, startup reservation movement, Storage-to-Reactor pickup, and Reactor runway/continuity priority.

Run `npm run test:resources`, `npm run test:season11`, and `npm run validate`. These are deterministic Node/mock checks, not live Screeps simulation or CPU measurements. Live extraction throughput, haul ETA/aging, terminal transaction success, and visual layout still require observation on the actual shard.

### Recorded results

- `npm run validate`: PASS, including the new 36-test resource strategy suite, 55 Season 11 tests, 18 Season 11/Power pipeline tests, and all pre-existing validation suites.
- Module graph: 106 reachable modules, no missing modules or cycles.
- Syntax checks (`node --check`) on every changed/new JavaScript file: PASS.
- `git diff --check`: PASS.
- Live shard execution and live visual/CPU measurements: not performed.
