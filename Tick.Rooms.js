const utilityVisual = require('utility.Visual');
const scoreSeason = require('Season.Score');

function run() {
    for (const roomName in Game.rooms) {
        utilityVisual.drawSourceFlags(roomName);
        scoreSeason.reportVisibleRoom(Game.rooms[roomName], 'main', false);
    }
}

module.exports = {
    run: run
};
