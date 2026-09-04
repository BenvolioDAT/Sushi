# Phase 2.1 remote integration repair

This repair keeps the Phase 2 remote system and its two-room discovery range. An established profitable remote remains maintenance work when its plan is refreshed, including during healthy RECOVERY.

## State and route identity

`mergeReplannedSource` updates only derived planning fields on the existing source object. Ownership, lifecycle, establishment, construction knowledge and historical telemetry remain intact. Telemetry refresh also merges its current measurements. `lastParentChangeAt` is initialized once and subsequently changes only on an actual HOME reassignment; zero is a valid timestamp.

Each packed route has a compact geometry signature and monotonically increasing revision. The signature covers the destination room, endpoint and ordered segment coordinates. Identical geometry preserves EWMA values, deviations, sample counts and observation timestamps. Changed geometry advances the revision and starts fresh observations. Road-surface changes preserve observations but halve their confidence, as in Phase 2.

The packed schema stays at `PATH_VERSION = 1`: these are additive metadata fields. Legacy routes receive revision 1 and a signature. Legacy decoded heap entries lack the new cache keys and are rejected. Heap reuse requires matching path schema, revision and signature. Geometry changes and failed validation clear the decoded path and derived road plans, preventing cached road construction on a retired lane. Schema migration retains a revision counter when removing obsolete route data.

## Movement and measurement

Remote Extractors and Freighters join the saved route at its first HOME tile, regardless of target visibility, then follow successive ordered coordinates. A displaced creep rejoins the lane rather than switching to room-level outbound travel. Extractors finish at the endpoint tile; Freighters can stop within one tile of the pickup endpoint because its container may be occupied by a stationary miner. Ordinary local movement handles the final pickup interaction.

Returning Freighters traverse the lane in reverse through the HOME border and continue to the first saved HOME tile. Only then does local delivery begin. A completion marker prevents the delivery tail from sending a creep back to the route anchor. `destinationRoom` remains supported; an alternative destination is reached after the canonical return leg.

Outbound measurement starts at the first HOME route tile and ends in the pickup endpoint area. Cargo waiting is excluded. Return measurement starts when the creep begins leaving that area and ends at the HOME route tile, excluding the delivery tail. Trips carry both schema version and route revision; stale samples are ignored. Starting partway along a route does not create a misleading full outbound sample.

## Validation and failures

Every `Planner.Remote.run()` invocation rotates a persistent cursor and validates at most two due routes per HOME. The existing scheduler normally invokes this planner every five ticks. Due conditions include unvalidated revisions, dirty movement state, changed endpoints and the 251-tick validation interval. Budgeting spreads routes created together across planner invocations. Visible-room blocked tiles, road tiles and danger results are shared in a once-per-tick heap snapshot. Role path reads retain emergency checks for dirty routes and known danger.

Failed validation immediately sets `operational = false`, disables road eligibility and records a degradation or danger state. Spawn and pickup consumers filter invalid routes. Road plans derived from invalidated paths are discarded; Artificer remembered work and Annex reserve work check availability. Portfolio membership and history survive. Requested rebuilds have a bounded per-HOME attempt and per-source retry cooldown, and can restore established activity.

Danger makes travelers retreat using an explicitly checked path that excludes other known hostile rooms, while allowing escape from their current room. If no safe retreat exists, they hold and retain cargo. Permanent obstacles or missing geometry cause a hold pending repair; there is no generic outbound fallback. Temporary occupancy does not permanently invalidate a lane. Traveling pickup claims are renewed throughout the outbound leg.

## Explicit logistics and CPU

`Logistics.Jobs.assign` accepts positive integer amounts only and rejects busy or loaded Freighters without changing their work. Jobs retain requested, remaining and delivered amounts across loads. A pending delivery records the pre-intent cargo; reconciliation counts the cargo decrease after resolution, capped by the transfer amount. Failed intents do not reduce remaining demand. A 100-capacity Freighter therefore completes a 1000-energy request over ten successful loads. Explicit cancellation remains available through `clear`.

`Logistics.Index` scans creeps once per tick, then maintains source/target claims and HOME counts in heap. Claim changes update one row. Reservation reads use aggregate tables with an O(1) overlay excluding the caller, instead of repeated empire scans or copies of every claim. Source reservation synchronization reads an aggregate directly. Representative economic bodies come from assigned remote Freighters, chosen deterministically, or the existing planned body configuration; a small fallback remains available.

## Verification and live tuning

`test/remote-integration.js` covers acceptance cases A–L and additional failures: retained road caches, remembered Artificer work, danger retreat, obstacle rebuild, failed transfer resolution, same-tick claims, long-trip claim renewal and body selection independent of creep enumeration. Existing calibration tests now provide physical trip boundaries. Both `npm test` and `npm run validate` include the integration suite.

Live-shard checks remain useful for border congestion, pickup-area occupancy, observed versus modeled trip timing, validation/rebuild CPU under large portfolios, and the existing ROI/safety-margin settings. Tests establish behavior and scan bounds; they do not provide live-shard CPU measurements.
