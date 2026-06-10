/**
 * utility.Visual.js
 *
 * Very simple map visual helper for Sushi.
 *
 * What it does:
 * - Looks at a visible room.
 * - Finds the room's energy sources.
 * - Draws a small flag marker on the world map over each source.
 *
 * Important:
 * Game.map.visual drawings only last for the current tick,
 * so this function must be called every tick if you want the markers to stay visible.
 */

function drawSourceFlags(roomName) {
    /*
     * Make sure a room name was given. Visual helpers should quietly exit on bad
     * input because they are optional debugging aids, not core game behavior.
     */
    if (!roomName) {
        return;
    }

    /*
     * Optional safety check.
     * getRoomStatus does NOT draw anything.
     * It only tells us if the room is normal, closed, novice, or respawn.
     */
    var roomStatus = Game.map.getRoomStatus(roomName);

    if (!roomStatus || roomStatus.status === "closed") {
        return;
    }

    /*
     * Game.rooms only contains rooms you currently have vision in. That means
     * you need a creep, spawn, or owned structure giving vision before source
     * positions can be drawn.
     */
    var room = Game.rooms[roomName];

    if (!room) {
        return;
    }

    // Find all sources in the visible room.
    /*
     * room.find(FIND_SOURCES) asks Screeps for Source objects in this visible
     * room. It returns an array, even if there is only one source.
     */
    var sources = room.find(FIND_SOURCES);

    // Draw one map flag over each source.
    /*
     * This loop visits each source object and draws text at source.pos. The text
     * is only a visual overlay; it does not create a real in-game Flag object.
     */
    for (var i = 0; i < sources.length; i++) {
        var source = sources[i];

        Game.map.visual.text("⚑", source.pos, {
            color: "#ffaa00",
            fontSize: 12,
            stroke: "#000000",
            strokeWidth: 0.8,
            opacity: 0.9,
            align: "center"
        });
    }
}
// ============================================================================
// Exports
// ============================================================================
module.exports = {
    drawSourceFlags,
};
