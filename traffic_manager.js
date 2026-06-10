/**
 * This version does not ensure optimal solution but more cpu efficient
 */
/*
 * traffic_manager.js
 *
 * Cooperative movement resolver.
 *
 * Most Screeps movement code asks each creep to move independently, which makes
 * traffic jams common. This manager lets creeps register intended one-step
 * moves during role logic, then resolves all intents together at the end of the
 * tick. The result is not mathematically perfect, but it is cheap and good
 * enough for common creep swaps and movement chains.
 */

// Room-local movement matching state. These variables are rebuilt for each room
// run so the DFS can quickly see which creep currently owns each tile.
let movementMap
let visitedCreeps

// Cooperative traffic manager.
// Role code registers movement intents during the tick. This module then assigns
// final destination tiles so creeps can swap or chain-move instead of blocking
// each other with independent Creep.move calls.
const trafficManager = {
  init(visual = false) {
    // registerMove stores intent only. Actual Creep.move calls are delayed until
    // trafficManager.run has resolved collisions for the whole room.
    Creep.prototype.registerMove = function (target) {
      let targetPosition

      if (Number.isInteger(target)) {
        // Screeps move directions are accepted for compatibility with direct
        // movement code. Convert them into target coordinates for matching.
        const deltaCoords = directionDelta[target]
        if (!deltaCoords) {
          return ERR_INVALID_ARGS
        }

        targetPosition = {
          x: this.pos.x + deltaCoords.x,
          y: this.pos.y + deltaCoords.y,
        }
      } else {
        targetPosition = target
      }

      if (
        !targetPosition ||
        !Number.isInteger(targetPosition.x) ||
        !Number.isInteger(targetPosition.y)
      ) {
        return ERR_INVALID_ARGS
      }

      if (visual) {
        new RoomVisual(this.room.name).arrow(this.pos, targetPosition)
      }

      const packedCoord = packCoordinates(targetPosition)
      this._intendedPackedCoord = packedCoord
      return OK
    }

    /**
     * @memberof Creep
     * @param {RoomPosition} pos
     * @param {number} range
     */
    Creep.prototype.setWorkingArea = function (pos, range) {
      // Working areas let stationary roles, such as upgraders or builders, tell
      // traffic where they are allowed to shuffle without leaving useful range.
      this._workingPos = pos
      this._workingRange = range
      return OK
    }
  },

  run(room, costs, threshold) {
    /*
     * The algorithm is a bipartite-style matching:
     * - creeps are one side
     * - coordinates are the other side
     * - movementMap records which creep currently owns each coordinate
     *
     * depthFirstSearch tries to find an augmenting move chain that satisfies at
     * least one requested movement without leaving two creeps assigned to the
     * same tile.
     */
    // Start with every creep matched to its current tile. DFS then tries to move
    // intentful creeps into better assignments without losing tile ownership.
    movementMap = new Map()
    const creepsInRoom = room.find(FIND_MY_CREEPS)
    const creepsWithMovementIntent = []

    for (const creep of creepsInRoom) {
      assignCreepToCoordinate(creep, creep.pos)
      if (creep._intendedPackedCoord) {
        creepsWithMovementIntent.push(creep)
      }
    }

    for (const creep of creepsWithMovementIntent) {
      // If the creep already owns the tile it wants, no collision work is needed.
      if (creep._matchedPackedCoord === creep._intendedPackedCoord) {
        continue
      }

      // Temporarily free the creep's old tile, then search for a positive-score
      // chain of moves. If no chain exists, put it back where it started.
      visitedCreeps = {}

      movementMap.delete(creep._matchedPackedCoord)
      creep._matchedPackedCoord = undefined

      if (depthFirstSearch(creep, 0, costs, threshold) > 0) {
        continue
      }

      assignCreepToCoordinate(creep, creep.pos)
    }

    // Once matching is final, convert assigned coordinates into real Screeps
    // move directions.
    for (const creep of creepsInRoom) {
      const matchedPosition = unpackCoordinates(creep._matchedPackedCoord)

      if (creep.pos.isEqualTo(matchedPosition.x, matchedPosition.y)) {
        continue
      }

      const direction = creep.pos.getDirectionTo(matchedPosition.x, matchedPosition.y)
      creep.move(direction)
    }
  },
}

function getPossibleMoves(creep, costs, threshold = 255) {
  // Cache per creep because DFS may ask about the same creep multiple times
  // while exploring movement chains.
  if (creep._cachedMoveOptions) {
    return creep._cachedMoveOptions
  }

  const possibleMoves = []

  creep._cachedMoveOptions = possibleMoves

  if (creep.fatigue > 0) {
    // Fatigued creeps cannot move, so they cannot contribute alternate tiles to
    // the matching search.
    return possibleMoves
  }

  if (creep._intendedPackedCoord) {
    // Intentful creeps first try exactly the tile requested by pathing logic.
    possibleMoves.unshift(unpackCoordinates(creep._intendedPackedCoord))
    return possibleMoves
  }

  // Creeps without explicit intent may be displaced to neighboring legal tiles
  // to unblock higher-priority movement chains.
  const adjacentCoords = Object.values(directionDelta).map((delta) => {
    return { x: creep.pos.x + delta.x, y: creep.pos.y + delta.y }
  })

  const roomTerrain = Game.map.getRoomTerrain(creep.room.name)

  const outOfWorkingArea = []

  for (const adjacentCoord of _.shuffle(adjacentCoords)) {
    if (adjacentCoord.x <= 0 || adjacentCoord.x >= 49 || adjacentCoord.y <= 0 || adjacentCoord.y >= 49) {
      continue
    }

    if (roomTerrain.get(adjacentCoord.x, adjacentCoord.y) === TERRAIN_MASK_WALL) {
      continue
    }

    if (costs && costs.get(adjacentCoord.x, adjacentCoord.y) >= threshold) {
      continue
    }

    if (creep._workingPos && creep._workingPos.getRangeTo(adjacentCoord.x, adjacentCoord.y) > creep._workingRange) {
      // Leaving the working area is allowed only after in-area options, so a
      // worker remains useful when there is any local shuffle available.
      outOfWorkingArea.push(adjacentCoord)
      continue
    } else {
      possibleMoves.push(adjacentCoord)
    }
  }

  return [..._.shuffle(possibleMoves), ..._.shuffle(outOfWorkingArea)]
}

/**
 *
 * @param {Creep} creep
 * @param {number} currentScore
 * @param {number} costs
 * @param {number} threshold
 * @returns
 */
function depthFirstSearch(creep, currentScore = 0, costs, threshold) {
  // DFS searches for an augmenting path in the movement assignment graph. A
  // positive score means at least one creep gets its intended tile.
  visitedCreeps[creep.name] = true

  if (!creep.my) {
    // Hostile or neutral creeps cannot be commanded to move, so paths through
    // them are dead ends.
    return -Infinity
  }

  const possibleMoves = getPossibleMoves(creep, costs, threshold)

  const emptyTiles = []

  const occupiedTiles = []

  for (const coord of possibleMoves) {
    // Split empty tiles before occupied tiles so the search prefers simple moves
    // and only recurses through swaps/chains when needed.
    const packedCoord = packCoordinates(coord)
    if (movementMap.get(packedCoord)) {
      occupiedTiles.push(coord)
    } else {
      emptyTiles.push(coord)
    }
  }

  for (const coord of [...emptyTiles, ...occupiedTiles]) {
    let score = currentScore
    const packedCoord = packCoordinates(coord)

    if (creep._intendedPackedCoord === packedCoord) {
      // Reward satisfying this creep's original intent.
      score++
    }

    const occupyingCreep = movementMap.get(packedCoord)

    if (!occupyingCreep) {
      // Empty tile ends the chain. Accept it only when the chain has positive
      // value, otherwise the creep would move without helping any requested move.
      if (score > 0) {
        assignCreepToCoordinate(creep, coord)
      }
      return score
    }

    if (!visitedCreeps[occupyingCreep.name]) {
      // If the occupant already wanted to stay on this tile, moving it away is a
      // penalty. DFS can still accept that if the total chain is beneficial.
      if (occupyingCreep._intendedPackedCoord === packedCoord) {
        score--
      }

      const result = depthFirstSearch(occupyingCreep, score, costs, threshold)

      if (result > 0) {
        assignCreepToCoordinate(creep, coord)
        return result
      }
    }
  }

  return -Infinity
}

const directionDelta = {
  // Screeps direction constants mapped to single-tile coordinate deltas.
  [TOP]: { x: 0, y: -1 },
  [TOP_RIGHT]: { x: 1, y: -1 },
  [RIGHT]: { x: 1, y: 0 },
  [BOTTOM_RIGHT]: { x: 1, y: 1 },
  [BOTTOM]: { x: 0, y: 1 },
  [BOTTOM_LEFT]: { x: -1, y: 1 },
  [LEFT]: { x: -1, y: 0 },
  [TOP_LEFT]: { x: -1, y: -1 },
}

function assignCreepToCoordinate(creep, coord) {
  // Record both sides of the matching: the creep's assigned packed coordinate
  // and the creep occupying that coordinate.
  const packedCoord = packCoordinates(coord)
  creep._matchedPackedCoord = packedCoord
  movementMap.set(packedCoord, creep)
}

function packCoordinates(coord) {
  // String keys support normal room coordinates plus one-step exit intents
  // such as x = -1 or x = 50, which lets room-edge creeps leave the room.
  return coord.x + ":" + coord.y
}

function unpackCoordinates(packedCoord) {
  // Reverse of packCoordinates.
  const parts = packedCoord.split(":")
  const x = parseInt(parts[0], 10)
  const y = parseInt(parts[1], 10)
  return { x, y }
}

module.exports = trafficManager
