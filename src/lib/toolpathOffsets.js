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

export function unionContours(contours) {
  if (contours.length === 0) return []
  if (contours.length === 1) return [contours[0]]

  const clipper = new ClipperLib.Clipper()
  for (const contour of contours) {
    clipper.AddPath(toClipper(contour), ClipperLib.PolyType.ptSubject, true)
  }
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  )
  return solution.map(fromClipper)
}

export function clipContours(subject, clip) {
  if (subject.length === 0 || clip.length === 0) return subject

  const clipper = new ClipperLib.Clipper()
  for (const c of subject) clipper.AddPath(toClipper(c), ClipperLib.PolyType.ptSubject, true)
  for (const c of clip) clipper.AddPath(toClipper(c), ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  )
  return solution.map(fromClipper)
}
