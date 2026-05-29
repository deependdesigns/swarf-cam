// Polygon offsetting via clipper-lib
// offsetDist > 0: expand (profile outside), < 0: shrink (pocket inside)

import ClipperLib from 'clipper-lib'

const SCALE = 1000 // clipper uses integer coordinates

function toClipper(poly) {
  return poly.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))
}

function fromClipper(path) {
  return path.map(({ X, Y }) => [X / SCALE, Y / SCALE])
}

export function offsetContours(contours, offsetMm) {
  if (contours.length === 0) return []

  const co = new ClipperLib.ClipperOffset()

  for (const contour of contours) {
    const path = toClipper(contour)
    co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  }

  const solution = new ClipperLib.Paths()
  co.Execute(solution, offsetMm * SCALE)

  return solution.map(fromClipper)
}
