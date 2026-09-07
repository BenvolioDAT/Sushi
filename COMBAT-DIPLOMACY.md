# NPC-first combat diplomacy

Baseline: main at `84e781c977328eb01b21619fa2c617c229766699`.

Defaults are `Memory.config.combat.diplomacy.playerResponseMode = 'observe'`
and `npcAutoDefense = true`. Invalid player modes fail closed to observe.

- **observe:** human danger triggers economic safety, never automatic targeting.
- **defend:** established hostile humans or confirmed recent aggressors are eligible
  in owned rooms and active/established planner remotes and their routes.
- **war:** defense remains eligible; existing offense policy may consider hostile
  humans. Existing operation/directive and viability checks still apply.
- Explicit manual, approved operations can override observation; allies remain protected.
- Invader and Source Keeper always classify as NPC. Keeper-room selection remains unchanged.

Threat snapshots retain `harmful`/`harmfulHostileCount` as safety signals for
remote routing, economy, capacity, colony alerts, and safe mode. Combat consumers
use `autoEngage`/`actionableHostileCount` and separate actionable capability totals.
`Defense.Demand.harmfulHostileCount` remains its legacy spawn-manager field, now
explicitly containing the actionable count. HUD D/A means dangerous/actionable.
Per-target diagnostics include owner, classification, dangerous, autoEngage, reason.

NPC defense uses planner relevance, a spawn-capable responding colony (preferring
one whose economy permits combat), dynamic capabilities, and the existing duo/quad
and spawn-governor paths. A non-damaging NPC gets a single ranged-clearance demand.
Remote defense does not receive the owned-room emergency economy bypass.
Live clearance completes defense immediately. Lost vision retains threats for up
to 1500 ticks, requests intel, and then expires the operation. Permission changes
also update unseen operations. Completed operations stop squad replacement demands.

Extractor/Freighter/Annex retain canonical unsafe-route retreat and revalidation.
Artificer also returns home from a dangerous remote. No permanent invasion blacklist
is added. Source Keeper selection restrictions are unchanged.

Incidents require a resolved attacker and a confirmed owned target or planner-known
remote container. Tower attackers are explicitly excluded before incident recording.
Repeated observation in one tick does not duplicate incidents. Scores, half-life,
and manual classifications retain the existing model; learned classification is
persisted for inspection. Unresolvable destroyed attackers/targets cannot safely be
attributed by this event-log path. Structure presence is never an incident.

## Changed files

- Combat.Policy.js, Combat.ThreatLedger.js, HiveMind.Memory.js
- Defense.Demand.js, Logic.Tower.js, Logic.WarRoom.js
- Squad.Controller.js, Squad.Quad.js
- Planner.Remote.js, role.Artificer.js, role.Volley.js
- Visual.Dashboard.js
- test/combat-diplomacy.js, test/phase3.js, test/phase5.js, test.Season11.js
- package.json, COMBAT-DIPLOMACY.md

The Volley change gates the existing Reactor guard's target selection; Reactor
portfolio strategy and tower danger calculations are unchanged. Existing PvP
recapture fixtures explicitly opt into war.

## Validation

`npm run test:combat`: focused diplomacy, owned-defense, duo, and resource suites.
Eight diplomacy groups cover the requested NPC/human matrix, incidents, tower
exclusion, mode changes, stale intel, manual targets, and area-attack protection.
`node test/phase8.js`: manual quad regression passes.

`npm run validate` was invoked once. It stopped at a manual-quad targeting
regression, which was fixed and rechecked. Remaining validation commands were run
from phase9 onward; the Season 11 fixtures needed explicit war mode. All commands
in the validation chain subsequently passed, including all 55 Season 11 tests,
capacity/body suites, module graph, movement audit, and the new diplomacy suite.
`git diff --check` and changed-JavaScript syntax checks passed.

Evidence is synthetic Node execution, not live Screeps gameplay. Remote GitHub
freshness could not be checked because the configured network proxy was unavailable.
