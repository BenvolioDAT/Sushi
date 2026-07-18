/* Shared normalization for the score shapes returned by Screeps APIs. */

function unwrapScoreEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    if (entry.pos) {
        return entry;
    }

    if (entry.score && entry.score.pos) {
        return entry.score;
    }

    if (
        typeof LOOK_SCORE !== 'undefined' &&
        entry[LOOK_SCORE] &&
        entry[LOOK_SCORE].pos
    ) {
        return entry[LOOK_SCORE];
    }

    return null;
}

module.exports = {
    unwrapScoreEntry: unwrapScoreEntry
};
