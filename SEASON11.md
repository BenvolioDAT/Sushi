# Sushi Season 11: Thorium and Reactors

Sushi now has a guarded Season 11 subsystem built around `Logic.Season11.js`,
`Season11.Adapter.js`, and `Season11.Operations.js`.
It discovers Thorium minerals and Reactors, keeps bounded intelligence, ranks
targets, stages mined Thorium, claims one selected Reactor, and maintains a
dedicated hauling pipeline. The subsystem loads safely when seasonal globals do
not exist and does not restore any Season 10 ScoreRunner behavior.

## Automatic detection and safety

The narrow adapter is the only module that invokes seasonal object methods.
The seasonal API is considered available only when both `RESOURCE_THORIUM` and
`FIND_REACTORS` exist at runtime. Claiming is checked separately through
`Creep.prototype.claimReactor` or a live creep. Seasonal constants are never
evaluated at module load without a `typeof` guard.

The default mode is `auto`. On an ordinary MMO shard or private server without
the API this is an inert mode: it records the failed detection in diagnostics,
does not scan for seasonal objects, and cannot request seasonal creeps.

Modes:

- `disabled`: no Season 11 scanning, planning, spawning, or role work.
- `observe`: Scout and visible-room intelligence only; no mining, claiming, or
  hauling creeps are requested.
- `auto`: operate only when the API and all safety prerequisites are present.
- `active`: explicitly enables the same complete pipeline. It still respects
  colony, CPU, route, extractor, reserve, and spawn-governor safety gates.

Set a mode from the console:

```js
require('Logic.Season11').setMode('observe')
require('Logic.Season11').setMode('auto')
require('Logic.Season11').setMode('active')
require('Logic.Season11').setMode('disabled')
```

## Memory schema

Season configuration and mode live under `Memory.config.season11`. Durable
Season runtime state lives under `Memory.hive.season.season11`:

```js
{
  mode: 'auto',
  // ...operator configuration
}

{
  schemaVersion: 2,
  rooms: {},
  reactors: {},
  assignments: {
    mining: {},
    selectedReactorId: null,
    selectedReactorRoom: null,
    plannedAt: 0
  },
  routes: {},
  alerts: {},
  stats: { events: [] }
}
```

The HiveMind schema-7-to-8 migration separates the former combined Season root.
Room intel, Reactor records, event history, operator configuration, and unknown
custom fields are preserved. Bounded delivery events, active seasonal operation
IDs, dashboard state, and occasional operation CPU summaries remain under
`Memory.hive.season`.

## HiveMind operation adapter

The operation adapter mirrors the proven seasonal assignments into durable,
stable `Memory.hive.operations` records. It does not introduce a second spawn
queue. Existing miner, hauler, and claimant plans continue to emit through the
shared demand board using matching operation IDs:

```text
season11:mine:<source room>
season11:haul:<source room>:<reactor id>
season11:reactor:<reactor id>
season11:discover
```

Seasonal operations use explicit guarded states: `DISCOVERING`, `SELECTING`,
`MUSTERING`, `CLAIMING`, `HARVESTING`, `HAULING`, `SUPPLYING`, `HOLDING`,
`CONTESTING`, `RECOVERING`, `DEPLETED`, `COMPLETE`, and `ABORTED`. State,
utility components, route/aging/maintenance estimates, finite supply, projected
score value, assigned creep names, and the current debug reason are plain data.

Utility favors finite accessible supply and continuity at an already-running
Reactor, while subtracting travel, estimated aging/replacement pressure, route
maintenance, threat risk, and opportunity cost. An ownership loss becomes
`RECOVERING` by default. It becomes `CONTESTING` only when `recapture: true` is
an explicit operator directive and the shared diplomacy policy does not classify
the owner as an ally. Threatened owned Reactors and explicitly permitted
contests request coordinated ranged/healing squads through the normal squad
demand flow. Normal threats use a duo; heavy threats can select a ranged quad.

Only strings, ids, room names, coordinates, numbers, booleans, arrays, and plain
objects are stored. Live Screeps objects are never written to Memory. Intel,
routes, alerts, and event history are aged or bounded by configuration.

## Defaults and prerequisites

Important defaults:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `scoutRadius` | 8 | Seasonal Scout radius; normal shards retain radius 3 |
| `maxMiningRooms` | 2 | Maximum simultaneous Thorium source assignments |
| `startupReserve` | 500 | Reserve required before claiming/starting delivery |
| `reactorSafetyStock` | 150 | Desired Reactor buffer for diagnostics/planning |
| `starvationWarningTicks` | 200 | Emergency hauling and `STARVING` threshold |
| `haulerSafetyMargin` | 1.25 | Throughput headroom |
| `agingFallbackThorium` | 1,000 | Conservative tile total when route tiles are unobservable |
| `maxHaulersPerRoute` | 4 | Per-route seasonal hauler cap |
| `claimCooldown` | 500 | Minimum delay between claimant request cycles |
| `recapture` | `false` | Do not automatically steal back a captured Reactor |
| `minimumCpuBucket` | 2500 | Pause optional seasonal spawning below this bucket |
| `minimumStorageEnergy` | 30000 | Mature-room economy reserve required to spawn roles |
| `intelMaxAge` | 50000 | Normal intel retention |
| `depletedIntelMaxAge` | 500000 | Compact depleted-room retention |

Change only supported keys with:

```js
require('Logic.Season11').configure({
  startupReserve: 800,
  starvationWarningTicks: 300,
  recapture: true
})
```

Seasonal spawning additionally requires an owned spawn room with storage, at
least 30,000 energy, and living Foreman, Extractor, and Freighter roles. The
spawn governor's normal queue length, new-request, role, per-RCL creep, CPU, and
replacement rules remain authoritative. Seasonal emergency hauling has priority
72, below the critical Foreman and source-miner priorities; it receives no
starvation-bypass exemption.

## Scouting and target ranking

The existing Scout keeps its normal room scan and travel behavior. When the API
is available, its bounded plan radius expands to 8 and each visible room is also
reported to the Season 11 orchestrator. Main-loop scans are CPU/bucket scaled,
staggered by last-seen age, and cached.

Room intel records Thorium id, remaining amount, density, permanent depletion,
controller ownership/reservation, route distance, hostile creeps/structures,
threat parts, and last-seen tick. Reactor intel records id, room, owner, store,
capacity, `continuousWork`, hostiles, and last-seen tick.

Mining rank order is:

1. fresh safety/ownership intel and legal route accessibility;
2. hostile and competition risk;
3. observed finite Thorium remaining weighted by observed density;
4. route/hauling distance;
5. the northern room coordinate as a final tie-breaker.

Equal-distance Scout and Observer candidates also use northern position as a
secondary preference while Season 11 is detectable. Distance, room status,
unreachable cooldowns, stale-intel urgency, and hostile/accessibility gates stay
authoritative, so geographic preference cannot by itself launch an unsafe trip.

Only a visible player-owned room with an active extractor and a safe staging
store becomes `READY`. Large unowned deposits remain intelligence, but they do
not suppress a smaller mineable owned deposit and do not cause illegal miner
spawns. Sushi's existing expansion system remains responsible for acquiring and
developing additional rooms.

## Mining and hauling pipeline

The implemented path is:

```text
owned Thorium mineral + active extractor
    -> owned storage (preferred), terminal, or nearby container
    -> dedicated ThoriumHauler route
    -> selected owned Reactor
```

`ThoriumMiner` uses `creep.harvest(mineral)`, which is the official Mineral API.
It never replaces or repurposes the energy `Extractor` role. Empty minerals are
marked permanently depleted and never receive another miner. A depleted source
assignment is retained only while its staging structure still contains cargo,
so the last Thorium is drained instead of stranded.

`ThoriumHauler` withdraws only the seasonal resource and transfers only to a
Reactor whose live object reports `my === true`. If the Reactor is unclaimed or
stolen, cargo is returned to staging instead of starting or feeding another
player's Reactor. No season code uses `Game.market`, portals, or direct
`creep.move`/`moveTo`; all three roles use `utility.Travel.Creep`, leaving final
movement ownership to the traffic manager.

Hauler demand uses route length, hauling throughput, the one-Thorium-per-tick
Reactor consumption, a safety margin, and effective loaded lifetime. Aging uses
`Math.floor(Math.log10(totalThoriumOnTile))`: live haulers inspect and record the
total Thorium on their current tile. Future route tiles cannot be observed, so
planning uses the conservative `agingFallbackThorium` setting (1,000 by
default), never creep carry capacity. This is only a safety/replacement model;
the AI does not attempt to control the engine's aging mechanic. Routes whose
loaded travel estimate cannot fit inside that lifetime are rejected with `NO
ROUTE`. Replacement requests include spawn time, aging-adjusted route lead, and
safety margin.

Terminals can serve as owned staging stores, but this subsystem does not call
`terminal.send`; therefore it cannot accidentally send to another player.

## Reactor selection, claiming, and continuity

Known Reactors prefer our current Reactor, then unowned safe Reactors, then
short safe routes. Discovery always uses `FIND_REACTORS`; sector coordinates are
not hardcoded.

Choose a known Reactor by id or choose the first known Reactor in a room:

```js
require('Logic.Season11').selectReactor('reactorObjectId')
require('Logic.Season11').selectReactor('W5N5')
```

Clear the explicit choice and allow automatic ranking again:

```js
require('Logic.Season11').clearReactorSelection()
require('Logic.Season11').plan(true)
```

Sushi does not request a claimant until Thorium in a routed staging store plus
in-transit Thorium reaches `startupReserve` and the hauling model confirms a
continuous route. `ReactorClaimer` travels to range one, verifies adjacency,
then calls `creep.claimReactor(reactor)`. Ownership is not assumed from the
intent result; the next visible Reactor observation must confirm `my`.

If another player captures a previously owned Reactor, Sushi raises `STOLEN`,
stops deliveries, and returns carried Thorium. Automatic recapture is off by
default. Set `recapture: true` only when the route and defense situation justify
it. Reactor hostile intel is visible to the existing WarRoom workflow; Sushi
does not automatically turn a contested Reactor into an uncontrolled offensive.

## Dashboard and diagnostics

Every owned-room dashboard has a compact `SEASON 11` panel showing:

- mode and API availability;
- known, stored, and in-transit Thorium;
- miner, hauler, and claimant counts;
- selected Reactor room and owner;
- Reactor Thorium/capacity and `continuousWork`;
- current logarithmic score rate, ticks until empty, and next delivery ETA;
- operation state and active harvest/haul operation counts;
- measured delivery throughput, contest threat, and operation CPU;
- `STARVING`, `STOLEN`, `NO ROUTE`, `NO CLAIM`, and `DEPLETED` alerts.

The panel follows the configured visual cadence (five ticks by default). Its
summary is cached once per tick; route and planning work is not repeated by the
visual layer.

Console-friendly plain diagnostics:

```js
require('Logic.Season11').getDiagnostics()
JSON.stringify(require('Logic.Season11').getDiagnostics())
Memory.hive.season.season11.assignments.rankedMiningTargets
Memory.hive.season.season11.assignments.rankedReactors
Memory.hive.season.season11.stats.events
require('Season11.Operations').getDashboard()
Memory.hive.operations['season11:reactor:reactorObjectId']
```

## Live-world checks still required

The current Season API documentation confirms that `RESOURCE_THORIUM` is `T`,
`FIND_REACTORS` is `10051`, Thorium is a Mineral,
Mineral harvesting requires an extractor and `WORK`, hostile ownership or
reservation rejects harvesting, claiming requires an adjacent `CLAIM` part,
and the Reactor has a 1,000 Thorium store. It also documents Reactor fields
`continuousWork`, `store`, `my`, and `owner`, and the score formula
`1 + Math.floor(Math.log10(continuousWork))`. The Season 11 announcement confirms
finite lower-volume deposits, northern density, one-per-tick Reactor use, no
market, own-terminal-only transfers, and no portals.

These details should still be verified from live Season 11 objects after the
world starts:

- whether an exhausted Thorium Mineral reports `ticksToRegeneration` as absent,
  zero, or another sentinel (Sushi uses confirmed `mineralAmount === 0`);
- the exact reduced Season 11 density/amount distribution;
- the tick ordering of claim confirmation, transfer, consumption, and
  `continuousWork` updates;
- actual path lengths and loaded-aging behavior on the generated world, so
  route and reserve settings can be tuned;
- whether defended Reactor rooms need explicit WarRoom orders for the chosen
  sector.

The local test harness is `test.Season11.js`.

## Official references

- Season API: <https://docs-season.screeps.com/api/#Reactor>
- Claim intent: <https://docs-season.screeps.com/api/#Creep.claimReactor>
- Season 5 Thorium rules reused by Season 11:
  <https://screeps.com/forum/topic/3277/season-5-is-open>
- Season 11 announcement:
  <https://steamcommunity.com/games/464350/announcements/detail/698774255287927062>
