# Gameplay findings

All observations refer to private shard Benvolio-DAT. Source-code explanations below are distinguished from actual runtime observations.

## Harvesting and spawning

Initial dashboard 435497: five Extractors, seven of ten target WORK, planner seats five for source 1 and one for source 2, estimated income 14/20 energy per tick. Source 2 has two WORK and SPAWN_CAPACITY constraint with 300 maximum room energy. Spawn idle and queue zero: this alone is not indefinite energy waiting; the capacity cannot be raised merely by waiting for refill.

Direct runtime at 452496:

| Source ID | Location | Energy | Assigned stationed miners |
|---|---|---:|---|
| c44207728e621fc | W7N4 (12,31) | 890 | Extractor_003 (13,31), 1 WORK, TTL67; Extractor_004 (13,30), 2 WORK, TTL98; Extractor_005 (12,30), 2 WORK, TTL940 |
| 80d207728e6597b | W7N4 (41,46) | 1216 | Extractor_001 (40,45), 4 WORK, 2 MOVE, 1 CARRY, TTL124 |

This establishes that miners are not universally stuck at one WORK. The first source has five active WORK spread among three miners; the one-seat source has four. BodyProfiles uses one CARRY and ceil(WORK/2) MOVE for ordinary local Extractors. Four WORK costs 550; five WORK costs 700. At final tick 453204 the room has exactly five extensions and capacity 550, so the current preferred five-WORK body cannot fit. Harvest.Planning.describe calculates per-seat capability against active spawn/extension capacity and can recommend replacements rather than exceeding seat count. No independent all-eight-neighbor seat enumeration or measured per-regeneration harvest yield was captured.

Later console history includes 550-energy Extractors, plus occasional 200-energy downgrades. These logs have wall times but no game ticks; they cannot establish affordability at the moment of spawn. Repeated small miners despite sufficient current energy is not confirmed. Emergency recovery, busy-spawn arbitration and full body replacement timing need matched admission snapshots to evaluate fully.

## Hauling and energy distribution

At 452696: 16 Freighters, fourteen with one CARRY and two with two CARRY (18 total active body CARRY across that raw snapshot). At 452818: planner classifies 15 local Freighters, living local CARRY17, required17, missing0; no queued/spawning local CARRY, five idle, no no-progress workers. These are different ticks; do not treat 18 versus17 as a mismatch. Remote CARRY demand and workers are zero. Assessment: CAPACITY_COVERED_IDLE_WORKERS.

Existing surviving-worker counters at 452818: 10489 observed creep-ticks, 6522 work, 2150 parking, picked11170 and delivered10920. They are cumulative across currently surviving workers, not a matched observation-window throughput measurement. Deaths/replacements can change totals. This supports useful hauling and some idleness, but not a quantified delivery rate or a confirmed excessive target.

Freighter body fragmentation is a supported efficiency concern. Source explanation: ordinary affordable-body downgrade logs show many 100-energy births; carry-based planning can meet demand using many small bodies. Current renewal logic is conditional and no renewal was queued at 452818. Recommend tracing why minimum bodies persist through funded replacement opportunities, with matched full-trip delivery evidence before changing waits or caps.

At 452496 dropped piles were (33,31)=8103, (33,30)=3785, (32,27)=220, (35,31)=22, (34,29)=15. Large piles are near the spawn region rather than the source tiles. role.Freighter.js explicitly creates spawn-side controlled overflow for Foreman/Artificer/Tech and excludes it from ordinary collection. Therefore these drops are not sufficient evidence of failed source hauling or an empty travel loop. Exact stockpile tile configuration and decay/waste over time were not measured.

## Containers and construction

At 436958, sites included a container at 4045/5000 and a second at zero, another later container site at zero, extensions (one 1985/3000 and four zero), plus numerous roads. At 452496 built containers were (13,31)=200 energy, (40,45)=80, and (37,15)=2000. The first two are next to the two sources. The third is the apparent controller-side container, but controller coordinates were not independently recorded. No duplicate source container was found in this built-container inventory; no duplicate controller purpose is established.

At 452696 only 82 road sites remained. Final query 453204 independently confirms five built extensions. Thus containers/extensions finished during the endpoint interval; roads remain a substantial queue. No abandoned-job-after-death defect, duplicate site defect, repair waste, or never-finishing task was proven. With no Artificer in the 452696 role snapshot, road completion deserves follow-up, but worker assignment priorities may intentionally delay roads during recovery.

## Movement

Creeps visibly travel and change roles/positions across snapshots. No current repeated-tile failure is proven without sequential same-creep traces. Earlier console history shows Scout_001 alternating W8N2 (1,20)/(1,21) while targeting W9N2 (25,25), with accumulated Traveler CPU warnings. Game ticks and that history's build identity are unavailable, so this is an older-history investigation lead. See CPU_ANALYSIS.md for why those CPU labels are cumulative.

## Remotes and defense

Early W7N4 console reports remotes blocked during SURVIVAL/local-harvest recovery, consistent with colony priority gates. Later dashboard labels W6N3 and W8N3 active, two sources each; retained planner messages select W6N3/7cf80773019b1f1 (distance69) and W8N3/71ac0772347ffe6 (distance75). These are planner estimates, not measured haul trips.

At 452818 there is no remote hauling demand or capacity; 453204 query of common remote worker flags returns an empty list. That filter is not a complete proof of every assignment mode, but together with zero remote CARRY it provides no evidence of productive remote hauling. Display 'active' appears to describe selected plans, which can mislead users into assuming mining is staffed. Economic usefulness, retreat and post-hostile recovery remain unverified.

Safe mode was visible, and its remaining counter changed substantially between early and late observation windows. The audit did not activate safe mode; no inference about the cause of that change is made. No deliberate enemies were introduced and no combat encounter was verified. Tower targeting, defensive spawning, invader/core response and civilian retreat are unverified.

## Dashboard

Panels are readable at full size, but cover much of the colony; long spawn/alert explanations are truncated. At RCL2, five extensions and 550/550 energy, the repeated instruction to 'build and fill active extensions' cannot solve the remaining one-seat five-WORK requirement at this RCL. Source: Harvest.Planning.describe maps SPAWN_CAPACITY to this generic recommendation, and Diagnostics.View also emits infrastructure recovery advice. Recommend reporting current/maximum extensions and the next controller/capacity milestone; do not suppress safe minimum upgrading needed to reach it.

The display correctly shows changing RCL, energy capacity, miner WORK and repeated exception events. Exact-tick dashboard/runtime parity for all values was not tested. Room counts in retained health samples count visible Game.rooms, while the dashboard counts owned rooms; the values 2 and1 are not evidence of a bug.

## Continuation correction and matched-worker evidence

Ticks 456913–457224: all 14 surviving matched Freighters recorded positive unloaded-energy deltas, including the three that initially had zero lifetime pickup/delivery counters. Ticks 456913–457703: 13 surviving matched generations unloaded 12138 energy in 790 ticks. Names were matched with equal tick+TTL to exclude reused names; expired workers and newborns are excluded. The full per-worker deltas are in hauling_matched_790.csv. These observations show activity after initial idleness, while preserving the fragmented-body concern. They do not measure complete fleet throughput.

Freighter_009 unloaded 150 over 790 ticks and accumulated333 parking ticks, while Freighter_011 unloaded1968. That establishes uneven observed workload; it does not determine an optimal population. Controller progress rose 383. At tick 457539 the retrieved construction-site list contains only roads, all at zero progress; identities were not captured, so identical sites continuously stuck since the first pass cannot be proven. Recovery priorities may intentionally delay road building.

Metric caveat confirmed in role.Freighter.js:1422–1432: `jobMovement` uses truthiness of `freighterJob`, so the literal string `idle` is sufficient for moving creeps to count toward `workTicks`. `delivered` counts negative cargo deltas, including controlled overflow drops. Therefore movement-based utilization is not a pure productive-work metric, and unloading is not final consumer use.
