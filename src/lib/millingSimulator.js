// G-code parser and heightmap-based stock simulation for milling preview

const TOOL_DIA_RE = /;\s*tool diameter:\s*([0-9.]+)/i

// Squared distance from point (px,py) to segment (ax,ay)-(bx,by)
function distToSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) {
    return (px - ax) ** 2 + (py - ay) ** 2
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const nx = ax + t * dx - px
  const ny = ay + t * dy - py
  return nx * nx + ny * ny
}

// Parse G-code string into a flat array of moves.
// Tracks tool diameter from "; Tool diameter: X mm" comments in the header.
// Returns array of { type:'rapid'|'feed', fromX, fromY, fromZ, x, y, z, toolDiameter }
export function parseGcode(gcodeString) {
  if (!gcodeString) return []
  const moves = []
  let cx = 0, cy = 0, cz = 0
  let isRapid = true
  let toolDiameter = 3.175

  for (const rawLine of gcodeString.split('\n')) {
    const tdm = rawLine.match(TOOL_DIA_RE)
    if (tdm) toolDiameter = parseFloat(tdm[1])

    const line = rawLine.replace(/;.*/, '').trim()
    if (!line) continue

    let nextX = cx, nextY = cy, nextZ = cz
    let hasCoords = false
    let hasG0 = false, hasG1 = false

    for (const word of (line.toUpperCase().match(/[A-Z][+-]?[0-9.]+/g) ?? [])) {
      const letter = word[0]
      const val = parseFloat(word.slice(1))
      if      (letter === 'G' && val === 0) hasG0 = true
      else if (letter === 'G' && val === 1) hasG1 = true
      else if (letter === 'X') { nextX = val; hasCoords = true }
      else if (letter === 'Y') { nextY = val; hasCoords = true }
      else if (letter === 'Z') { nextZ = val; hasCoords = true }
    }

    if (hasG0) isRapid = true
    if (hasG1) isRapid = false

    if (hasCoords && (nextX !== cx || nextY !== cy || nextZ !== cz)) {
      moves.push({ type: isRapid ? 'rapid' : 'feed', fromX: cx, fromY: cy, fromZ: cz, x: nextX, y: nextY, z: nextZ, toolDiameter })
      cx = nextX; cy = nextY; cz = nextZ
    }
  }

  return moves
}

// Simulate material removal from parsed moves.
// Returns a Float32Array[gridRes*gridRes] of heights from the stock bottom (0 = fully removed,
// materialThickness = untouched). Grid origin is CNC (0,0); cell (i,j) is at
// x = i*stockX/(gridRes-1), y = j*stockY/(gridRes-1).
export function simulateMilling(moves, stockX, stockY, materialThickness, zZeroMode, gridRes = 256) {
  const heightmap = new Float32Array(gridRes * gridRes).fill(materialThickness)
  if (!moves.length || !stockX || !stockY || !materialThickness) return heightmap

  const cellW = stockX / (gridRes - 1)
  const cellH = stockY / (gridRes - 1)

  for (const move of moves) {
    if (move.type !== 'feed') continue

    // Use the deepest Z reached by this segment for material removal
    const cutZ = Math.min(move.fromZ, move.z)

    // Remaining stock height from the bottom at this cut depth
    const remaining = zZeroMode === 'spoilboard' ? cutZ : materialThickness + cutZ
    if (remaining >= materialThickness - 0.001) continue  // above or at surface — no cut

    const newH = Math.max(0, remaining)
    const toolRadius = (move.toolDiameter ?? 3.175) / 2
    const r2 = toolRadius * toolRadius

    const x0 = move.fromX, y0 = move.fromY, x1 = move.x, y1 = move.y

    // Bounding box of the swept capsule
    const iMin = Math.max(0, Math.floor((Math.min(x0, x1) - toolRadius) / cellW))
    const iMax = Math.min(gridRes - 1, Math.ceil((Math.max(x0, x1) + toolRadius) / cellW))
    const jMin = Math.max(0, Math.floor((Math.min(y0, y1) - toolRadius) / cellH))
    const jMax = Math.min(gridRes - 1, Math.ceil((Math.max(y0, y1) + toolRadius) / cellH))

    for (let j = jMin; j <= jMax; j++) {
      const py = j * cellH
      for (let i = iMin; i <= iMax; i++) {
        if (distToSegSq(i * cellW, py, x0, y0, x1, y1) <= r2) {
          const idx = i + j * gridRes
          if (heightmap[idx] > newH) heightmap[idx] = newH
        }
      }
    }
  }

  return heightmap
}
