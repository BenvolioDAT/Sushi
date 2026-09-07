# Economic surplus investment

Starting point: main / origin/main `04151816cdec0de2d6f8381761c0ef2bcf388183`, verified after fetching origin/main.

## Audit

Growth previously spent sustainable income (aggressive utilization 0.7, adjusted for spawn pressure). The surplus allocator added at most 30 energy/tick from storage, Tech WORK stopped at 60 with an absolute five-creep request guard, and Artificer WORK stopped at 24. Other allocations mostly changed request priority. The EXPANSION/CLAIM matcher missed operations named EXPAND. An empty-backlog Artificer fallback also requested a worker to upgrade.

Capacity already treats RCL counts as baselines, retains a 0.75 spawn target with emergency headroom, and accounts for replacements, queue bursts, CPU and commitments. BodyProfiles already chooses capability-bounded bodies within 50 parts. These systems remain in place.

## Investment rule

Settings live in `Memory.hive.config.surplus` (through the existing HiveMemory config API). Defaults:

- Enter DRAWDOWN at 200,000 energy above the economy reserve; exit at 50,000.
- Extra operating allowance: `(storedEnergy - reserveTarget - exitAboveReserve) / drawdownHorizon`, floored at zero and bounded by maxSpendPerTick.
- Horizon: 20,000 ticks, matching a long infrastructure/investment timescale rather than immediate spending. Maximum combined allocator budget: 100 energy/tick.
- Controller maximum: 60 WORK, configurable; RCL8 remains limited to 15 normal WORK.
- Artificer maximum: 80 WORK, construction horizon 5,000 ticks, estimated working duty cycle 0.65.

Existing income funds a controller floor before other allocations; unused allowance returns to controller demand. Drawdown allows a deliberate negative energy trend while the protected band and local health remain intact. Recovery, unknown/reserve energy, CPU exhaustion, spawn exhaustion and defense emergencies disable investment. Capacity still revalidates each actual request, including queue costs, CPU utilization and replacement commitments. Allocations are estimates, not a second spawn queue or a guarantee of expenditure.

Artificer investment measures remaining local/remote construction and local repair work. Existing critical-work floors remain; additional local work is optional construction, so a massive critical backlog cannot use mandatory admission to bypass Capacity. Barrier repair volume uses the existing 10,000-hit goal, not hitsMax. Remote repair still uses the established count-based demand. No backlog produces no extra Artificer; existing workers retain their fallback behavior.

Remote hauling allocations can raise demand beyond the former 50-CARRY ceiling only to actual selected-route requirements. A fully funded profitable, safe, validated remote can add one slot to the existing healthy-room allowance. Planner.Remote retains ranking, rescoring, danger, logistics proof and one-source ramp gates. Its normal snapshot freshness window is 25 ticks. EXPAND support increases Pioneer body WORK through the existing demand board without increasing the fixed support count. Season candidates remain in the allocator; Season/combat planning is unchanged.

Tech consolidation also runs under spawn pressure. Artificer replacement matching is limited to the same work category. Both use expiring units and a spawn deadline; neither kills existing units nor bypasses spawn headroom. Planner.Brain already plans Spawns at RCL7/8 and attempts construction every 25 ticks with Spawns near the front of the priority order and controller limits enforced.

## Diagnostics and configuration

Inspect `Memory.rooms[room].surplus` for mode, protected surplus, extraSpendPerTick, total budget, sanitized settings, candidate estimates, allocations and capability targets. Inspect `Memory.hive.capacity.rooms[room]` for drawdownSpend and remaining resource headroom.

`Memory.rooms[room].spawn.governor.roleCaps` reports configured/effective values, source and reason. Persisted values retain unknown provenance; mergeMissing never overwrites them. Existing dynamic healthy-room caps now also consider how many bodies the capability target requires. Set `surplus.dynamicRoleCaps = false` to enforce configured role caps directly.

Existing Tech/Artificer desired/living WORK diagnostics remain. Request diagnostics add TECH_CAPABILITY_SATISFIED, ARTIFICER_BACKLOG_SATISFIED and NO_USEFUL_WORK. Surplus exposes STOCKPILE_DRAWDOWN, CPU_LIMIT, SPAWN_LIMIT and ENERGY_RESERVE; the governor retains its more detailed admission refusal codes.

## Evidence and limits

`npm run test:surplus` covers rich controller demand, CPU/spawn refusal, construction beyond 24 WORK, empty backlog, baseline counts, EXPAND, hysteresis, RCL8, recovery, safe remote candidates, config preservation, Artificer replacement matching and shared allocator budget. Existing capacity tests cover actual Tech admission above the RCL baseline and CPU-neutral consolidation.

Operating duty cycle, candidate CPU/spawn costs and completion horizons are estimates. Delivery congestion, active worker utilization, real server CPU and actual completion times need live observation. Allocation is advisory to existing safety-gated demand, and mandatory baseline spending elsewhere is not a centralized empire-wide expenditure ledger.

Validation completed: all 13 new surplus tests and the full npm run validate suite passed, including 55 Season 11 tests. JavaScript syntax checks and git diff --check passed. The first full run exposed an extra remote structure scan; consuming the existing surplus snapshot fixed it before the successful full rerun. Live Screeps behavior remains unverified.
