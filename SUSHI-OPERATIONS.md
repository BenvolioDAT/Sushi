# Sushi operation and troubleshooting

Updated November 5, 2026. The standard-game implementation is integrated into the
original working repository on local branch `main`:

`C:\Users\xbenv\AppData\Local\Screeps\scripts\192_168_0_217___21025\Sushi`

All three review commits were integrated through a Git fast-forward, preserving
history and removing retired files. No copying from the review checkout is
needed. See [INTEGRATION-2026-11-05.md](INTEGRATION-2026-11-05.md) for the recovery
point, integration checks and validation performed in this repository.

## Synchronization and verification

1. The directory above is watched by the Screeps client. Its files were updated
   with explicit user authorization and may already have synchronized.
2. Synchronization was not checked against the client or server. Confirm the
   intended local-server branch has received the complete update before relying
   on it. Check that `Diagnostics`, `Diagnostics.View`, `Visual.Layout` and
   `Season.Retirement` exist, and that `main` imports the recorder and view.
   A local Git commit alone does not prove server synchronization.
3. Re-run `npm run validate` and `git diff --check` from this original repository
   when validating subsequent changes. These checks use local mocks and do not
   connect to the game server or change live game Memory.
4. After synchronization and a completed game tick, inspect
   `Sushi.debug.status()` and `Sushi.debug.room('W3S47')` in your game console.
   The application's one-time seasonal retirement runs through its normal tick
   bootstrap; no manual live-Memory changes were made during integration.
5. Observe harvesting, spawning, movement and CPU/bucket for 300–500 ticks and
   obtain a current dashboard screenshot. The supplied preview is a mock.

The pre-integration recovery point is local branch
`codex/backup-before-review-integration-20261105` at `7b1ce32`. Switching the
watched files back to this branch would itself be another synchronization action;
it has not been done. Restoring code does not restore any game Memory already
migrated by running it.

## Diagnostic modes

NORMAL is the default. Run these in the Screeps console after bootstrap:

```javascript
Sushi.debug.mode('NORMAL')
Sushi.debug.mode('DEBUG')
Sushi.debug.mode('PROFILE', 100) // Automatically returns to NORMAL after 100 ticks.
Sushi.debug.mode('OFF')          // Stops recording; preserves readable history.
```

PROFILE accepts 1–1,000 ticks. DEBUG permits DEBUG-severity records. PROFILE uses
existing role CPU instrumentation every tick rather than its established
25-tick sampling cadence, and records a compact CPU sample every five ticks.
OFF disables the new recorder; established CPU telemetry and colony capacity
sampling remain available because standard policy already uses them.

Advanced settings live in one place, `Memory.config.diagnostics`:

```javascript
Memory.config.diagnostics.maxEvents = 1000
Memory.config.diagnostics.maxChars = 90000
Memory.config.diagnostics.snapshotInterval = 100
Memory.config.diagnostics.flushInterval = 25
Memory.config.diagnostics.retentionTicks = 50000
Memory.config.diagnostics.duplicateWindow = 50
Memory.config.diagnostics.level = 'WARN' // DEBUG, INFO, WARN or ERROR
Memory.config.diagnostics.useSegments = false // Bounded ordinary-Memory fallback.
```

Limits are clamped to safe hard maxima. Most configuration edits take effect on
the next tick; mode and severity changes also invalidate the settings cache in
the current tick. Mode commands set their matching default severity threshold.

## Display modes

```javascript
Memory.config.visuals.dashboardMode = 'OFF'
Memory.config.visuals.dashboardMode = 'COMPACT'
Memory.config.visuals.dashboardMode = 'NORMAL'
Memory.config.visuals.dashboardMode = 'DEBUG'
```

The existing `showDashboard = false` override still disables the dashboard.
To restore it or select a room:

```javascript
Memory.config.visuals.showDashboard = true
Memory.config.visuals.dashboardRoom = 'W3S47'
delete Memory.config.visuals.dashboardRoom // Draw all visible owned rooms.
Memory.config.visuals.showRemoteRoomDashboard = false
Memory.config.visuals.visualInterval = 1
```

COMPACT shows identity, RCL, economy, spawn energy, CPU and the highest-priority
alerts. NORMAL adds population, sources, spawn action, resources and diagnostics.
DEBUG adds incoming WORK, sample ages, confirmation counters and storage status.
Remote panels appear only for active operations; resource rows require positive
inventory. Overflow becomes a summary directing you to the console.

## Retrieve evidence

```javascript
Sushi.debug.status()
Sushi.debug.events(20)
Sushi.debug.errors(20)
Sushi.debug.room('W3S47')
Sushi.debug.cpu()
```

`room()` returns the current economy/colony view plus room events. It separates
active, spawning and queued WORK, shows each source's coverage and estimated
income, and includes the spawn's role, stage, reason, energy requirement and
sample tick. A stale spawn decision is explicitly marked `current: false`.
Income is estimated from active WORK stationed at a source; it is not a measured
accounting ledger of actual harvest intents.

`cpu()` returns current phase costs, existing rolling averages, growth telemetry
and sampled role CPU/utilization. Phase costs include nested measurements, so do
not add every phase together: `planning` contains its named subphases. Total is
sampled before telemetry's final housekeeping. The `diagnostics` phase measures
recorder begin, job observation and flush work; event hooks executing inside
other phases are included in those phases rather than separately charged.

The primary history uses segment 98 only after inspecting its contents and
claiming `Memory.hive.segmentOwners[98] = 'sushi.blackbox.v1'`. A pending,
unavailable or conflicting segment falls back safely. Check `storageReason` in
`status()`. No existing Sushi subsystem used RawMemory segments at inspection.
If adding another segment consumer, coordinate activation centrally: Screeps
activation calls replace earlier requests. Existing active ids are preserved by
the recorder, and a full ten-slot set is left alone. This contract follows the
[official RawMemory API](https://docs.screeps.com/api/#RawMemory).

The segment and heap retain at most 1,000 events **and** 90,000 ASCII-serialized
characters, whichever limit is reached first. The fallback retains at most 64
events and 16,000 serialized characters including string escaping and metadata
allowance. Events older than 50,000 ticks since their last occurrence expire.
Duplicate events aggregate for 50 ticks. Stored `tick` is their first occurrence;
`lastTick` and `count` describe recurrence. A heap reset before a pending segment
write can lose older unflushed records beyond the fallback. This is a deliberate
bounded-loss tradeoff, not guaranteed delivery of every event.

## Export and share

Freeze the export once, then print its parts individually:

```javascript
global.sushiDump = Sushi.debug.export(3000)
sushiDump.length
console.log(sushiDump[0])
console.log(sushiDump[1]) // Continue up to sushiDump.length - 1.
```

Each part is at most 3,000 characters by default. Concatenate the part contents
in index order, without console prefixes, quotation wrappers, or added newlines,
to recover one valid compact JSON document. Do not regenerate `export()` between
parts. The equivalent cached access is:

```javascript
Sushi.debug.export(3000)
console.log(Sushi.debug.exportChunk(0))
console.log(Sushi.debug.exportChunk(1))
```

Chunks stay frozen while later ticks produce new events. After a global reset,
start a new export instead of mixing parts from different exports.

Share the complete export, `JSON.stringify(Sushi.debug.room('W3S47'))`,
`JSON.stringify(Sushi.debug.cpu())`, the deployed commit identity, and a current
screenshot. For movement issues, include several ticks and the affected creep's
name. For intermittent problems, wait long enough to capture the transition and
its next action before exporting.

To clear only the recorder's history:

```javascript
Sushi.debug.clear()
```

The owned segment is cleared on the next available enabled flush. A persistent
clear marker prevents old segment events reappearing if globals reset first.
This does not clear colony, spawn, resource, power, movement or diplomacy state.
