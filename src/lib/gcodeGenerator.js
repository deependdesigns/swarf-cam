import { getPostProcessor } from './postProcessors/index'
import {
  extractSliceContours, getStlTopZ, getFeatureDepths,
  getFloorZLevels, getRegionFloorDepth,
  polygonArea, polygonCentroid, pointInPolygon,
  classifyContours, buildContourHierarchy, sliceAllLayers, getStlBounds,
} from './stlSlicer'
import { offsetContours, unionContours, clipContours } from './toolpathOffsets'

const OP_COLORS = [0x00e5ff, 0xffab40, 0x69f0ae, 0xff4081, 0xea80fc, 0xffd740, 0x40c4ff, 0xe040fb]

// ── Effective operation (merges per-op overrides on top of global tool settings) ─

export function effectiveOp(op, globalTool) {
  return {
    ...op,
    depth: op.detectedDepth ?? 0,
    toolDiameter: op.overrides?.toolDiameter ?? globalTool.toolDiameter,
    feedrate:     op.overrides?.feedrate     ?? globalTool.feedrate,
    spindleSpeed: op.overrides?.spindleSpeed ?? globalTool.spindleSpeed,
    stepdown:     op.overrides?.stepdown     ?? globalTool.stepdown,
    stepover:     op.overrides?.stepover     ?? globalTool.stepover,
    direction:    op.overrides?.direction    ?? globalTool.direction,
  }
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function circleFromContour(polygon) {
  const [cx, cy] = polygonCentroid(polygon)
  let r = 0
  for (const [x, y] of polygon) r += Math.hypot(x - cx, y - cy)
  r /= polygon.length
  return { cx, cy, r }
}

function getBbox(polygon) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
  for (const [x, y] of polygon) {
    if (x < xMin) xMin = x; if (x > xMax) xMax = x
    if (y < yMin) yMin = y; if (y > yMax) yMax = y
  }
  return { xMin, xMax, yMin, yMax }
}

// 3×3 Gaussian elimination for circle fitting
function solve3x3(M, b) {
  const a = M.map((row, i) => [...row, b[i]])
  for (let col = 0; col < 3; col++) {
    let maxRow = col
    for (let row = col + 1; row < 3; row++)
      if (Math.abs(a[row][col]) > Math.abs(a[maxRow][col])) maxRow = row
    ;[a[col], a[maxRow]] = [a[maxRow], a[col]]
    if (Math.abs(a[col][col]) < 1e-10) return null
    for (let row = col + 1; row < 3; row++) {
      const f = a[row][col] / a[col][col]
      for (let k = col; k <= 3; k++) a[row][k] -= f * a[col][k]
    }
  }
  const x = new Array(3)
  for (let i = 2; i >= 0; i--) {
    x[i] = a[i][3]
    for (let j = i + 1; j < 3; j++) x[i] -= a[i][j] * x[j]
    x[i] /= a[i][i]
  }
  return x
}

// Algebraic least-squares circle fit. Returns { cx, cy, r } or null.
// Solves: Ax + By + D = x²+y² where A=2cx, B=2cy, D=r²-cx²-cy²
function fitCircle(points) {
  if (points.length < 3) return null
  let sX=0, sY=0, sX2=0, sY2=0, sXY=0, sXR=0, sYR=0, sR=0
  for (const [x, y] of points) {
    const r2 = x*x + y*y
    sX += x; sY += y; sX2 += x*x; sY2 += y*y; sXY += x*y
    sXR += x*r2; sYR += y*r2; sR += r2
  }
  const n = points.length
  const sol = solve3x3(
    [[sX2, sXY, sX], [sXY, sY2, sY], [sX, sY, n]],
    [sXR, sYR, sR]
  )
  if (!sol) return null
  const [A, B, D] = sol
  const cx = A / 2, cy = B / 2
  const r2val = cx*cx + cy*cy + D
  if (r2val <= 0) return null
  return { cx, cy, r: Math.sqrt(r2val) }
}

// Generate a closed circular polygon for use as a virtual pocket contour
function makeCircleContour(cx, cy, r, segments = 32) {
  return Array.from({ length: segments }, (_, i) => {
    const angle = (2 * Math.PI * i) / segments
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  })
}

// Detect cylindrical pockets open at a workpiece face (edge pockets).
// These appear as concave circular arcs in the outer contour. Each face is
// checked independently; a valid arc must fit a circle whose center is near
// the face edge and whose floor is confirmed by a real upward-facing surface.
function detectEdgePocketsFromContour(contour, stlArrayBuffer, topZ, sliceZ, toolDiameter) {
  if (contour.length < 10) return []
  const bbox = getBbox(contour)
  const n = contour.length
  const FACE_TOL = 1.0    // mm: point is "on face" within this tolerance
  const MIN_DIP  = toolDiameter  // arc must dip at least 1 tool diameter inward

  const faces = [
    { axis: 0, edgeVal: bbox.xMax, invert: false },
    { axis: 0, edgeVal: bbox.xMin, invert: true  },
    { axis: 1, edgeVal: bbox.yMax, invert: false },
    { axis: 1, edgeVal: bbox.yMin, invert: true  },
  ]

  const results = []

  for (const face of faces) {
    const mainOf  = ([x, y]) => face.axis === 0 ? x : y
    const inward  = (pt) => {
      const v = mainOf(pt)
      return face.invert ? v - face.edgeVal : face.edgeVal - v
    }
    const onFace = contour.map(pt => Math.abs(mainOf(pt) - face.edgeVal) < FACE_TOL)

    // Collect each off-face run (starts when we leave the face, ends on return)
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n
      if (onFace[i] || !onFace[prev]) continue  // looking for face→off transition

      const arcPts = []
      for (let step = 0; step < n; step++) {
        const idx = (i + step) % n
        if (onFace[idx]) break
        arcPts.push(contour[idx])
      }

      if (arcPts.length < 5) continue

      // Must dip inward meaningfully (eliminates opposite-face runs with near-zero inward dist)
      const maxDip = Math.max(...arcPts.map(inward))
      if (maxDip < MIN_DIP) continue

      // Fit circle
      const circle = fitCircle(arcPts)
      if (!circle || circle.r < toolDiameter * 0.9) continue

      // Circle center must be near this face
      const distFromFace = Math.abs(mainOf([circle.cx, circle.cy]) - face.edgeVal)
      if (distFromFace > circle.r * 0.4) continue

      // Fit quality: average distance residual must be small
      const avgResid = arcPts.reduce((s, pt) =>
        s + Math.abs(Math.hypot(pt[0] - circle.cx, pt[1] - circle.cy) - circle.r), 0) / arcPts.length
      if (avgResid > circle.r * 0.2) continue

      // Confirm a real floor exists within the cylinder's inner region
      const dr = circle.r * 0.4
      const depth = getRegionFloorDepth(stlArrayBuffer, topZ,
        circle.cx - dr, circle.cx + dr,
        circle.cy - dr, circle.cy + dr)
      if (depth >= topZ - 0.5) continue

      results.push({ cx: circle.cx, cy: circle.cy, r: circle.r, depth })
    }
  }

  return results
}

// targetRadius: when set, concentric contours (same centroid) are disambiguated by
// how closely their average radius matches the expected feature size.
// isOuterArr/wantOuter: when both given, candidates are filtered to isOuterArr[ci] === wantOuter
// BEFORE distance-scoring. Without this, a pocket with a concentric central island has a void
// centroid that nearly coincides with the island's centroid, and pure distance-scoring can pick
// the island contour instead — the caller's later `if (isOuter[ci]) continue` then silently
// drops the entire op instance instead of producing a toolpath. Falls back to unfiltered search
// if no candidate matches the wanted parity (defensive — keeps old behavior over crashing).
function findContourForCentroid(contours, [tx, ty], targetRadius = null, isOuterArr = null, wantOuter = null) {
  const candidates = isOuterArr && wantOuter !== null
    ? contours.map((_, i) => i).filter(ci => isOuterArr[ci] === wantOuter)
    : contours.map((_, i) => i)
  const pool = candidates.length > 0 ? candidates : contours.map((_, i) => i)

  let bestCi = pool[0] ?? 0, bestScore = Infinity
  for (const ci of pool) {
    const [cx, cy] = polygonCentroid(contours[ci])
    const centDist = Math.hypot(cx - tx, cy - ty)
    let score = centDist
    if (targetRadius !== null) {
      const { r } = circleFromContour(contours[ci])
      score += Math.abs(r - targetRadius)
    }
    if (score < bestScore) { bestScore = score; bestCi = ci }
  }
  return bestCi
}

function findContoursForOp(contours, isOuter, op) {
  const wantOuter = op.type === 'profile'
  if (op.centroids) {
    const seen = new Set()
    const targetRadius = op.detectedDiameter != null ? op.detectedDiameter / 2 : null
    return op.centroids
      .map(c => findContourForCentroid(contours, c, targetRadius, isOuter, wantOuter))
      .filter(ci => { if (seen.has(ci)) return false; seen.add(ci); return true })
  }
  if (op.centroid) return [findContourForCentroid(contours, op.centroid, null, isOuter, wantOuter)]
  return contours.map((_, i) => i).filter(ci =>
    op.type === 'profile' ? isOuter[ci] : !isOuter[ci]
  )
}

// ── Toolpath generators ───────────────────────────────────────────────────────

// Contours j whose immediate parent (tightest enclosing contour) is contour ci and which
// are themselves solid ("outer") — i.e. islands/bosses standing up inside pocket ci.
export function findIslandsForContour(hierarchy, contours, ci) {
  return contours.filter((_, j) => hierarchy.parent[j] === ci && hierarchy.isOuter[j])
}

// mask: optional polygon array — only machine the contour area NOT already cleared.
// If mask fully covers contour, returns [] so callers skip the operation entirely.
// islands: optional polygon array — solid bosses inside the pocket the tool must avoid.
// Each inward ring is clipped against a fixed toolRadius keepout around the islands so every
// pass keeps the same standoff, rather than re-offsetting the islands themselves on every
// pass (which would grow the keepout by `dist` each iteration and under-clear the pocket).
export function generatePocketPasses(contour, toolRadius, stepoverPct, mask = null, islands = null) {
  const stepover = Math.max(toolRadius * (stepoverPct / 100), 0.01)
  const toMachine = mask?.length > 0 ? clipContours([contour], mask) : [contour]
  if (toMachine.length === 0) return []
  const expandedIslands = islands?.length > 0 ? offsetContours(islands, toolRadius) : null
  const inward = []
  for (let dist = toolRadius; ; dist += stepover) {
    let ocs = offsetContours(toMachine, -dist)
    if (ocs.length === 0) break
    if (ocs.reduce((s, c) => s + polygonArea(c), 0) < 0.5) break
    if (expandedIslands?.length > 0) ocs = clipContours(ocs, expandedIslands)
    if (ocs.length > 0) inward.push(ocs)
  }
  inward.reverse()
  return inward.flat()
}

// Reverse polygon winding for conventional milling (default winding = climb).
// Keeps the start vertex fixed so the rapid-to point doesn't change.
function applyDirection(paths, direction) {
  if (direction !== 'conventional') return paths
  return paths.map(p => p.length > 1 ? [p[0], ...p.slice(1).reverse()] : p)
}


// Build a closed virtual polygon for a slot. Extended by toolR in the open direction(s)
// so that the first inward pocket offset (at toolR) lands exactly at the wall/opening boundary.
function buildSlotVirtualContour(s, toolR) {
  if (s.direction === 'x') {
    return [
      [s.wallXMin, s.openYMin - toolR],
      [s.wallXMax, s.openYMin - toolR],
      [s.wallXMax, s.openYMax + toolR],
      [s.wallXMin, s.openYMax + toolR],
    ]
  }
  if (s.direction === 'y') {
    return [
      [s.openXMin - toolR, s.wallYMin],
      [s.openXMax + toolR, s.wallYMin],
      [s.openXMax + toolR, s.wallYMax],
      [s.openXMin - toolR, s.wallYMax],
    ]
  }
  // Cross: 12-point polygon, open ends extended by toolR
  return [
    [s.wallXMin, s.openYMax + toolR],
    [s.wallXMax, s.openYMax + toolR],
    [s.wallXMax, s.wallYMax],
    [s.openXMax + toolR, s.wallYMax],
    [s.openXMax + toolR, s.wallYMin],
    [s.wallXMax, s.wallYMin],
    [s.wallXMax, s.openYMin - toolR],
    [s.wallXMin, s.openYMin - toolR],
    [s.wallXMin, s.wallYMin],
    [s.openXMin - toolR, s.wallYMin],
    [s.openXMin - toolR, s.wallYMax],
    [s.wallXMin, s.wallYMax],
  ]
}

function detectOpenSlots(outerContours, stlArrayBuffer, topZ) {
  const bboxes = outerContours.map(getBbox)
  const xGaps = []
  const yGaps = []

  for (let a = 0; a < outerContours.length; a++) {
    for (let b = a + 1; b < outerContours.length; b++) {
      const ba = bboxes[a], bb = bboxes[b]

      // ── X-gap (walls in X, open in Y) ────────────────────────────────────
      const yOverlap = Math.min(ba.yMax, bb.yMax) - Math.max(ba.yMin, bb.yMin)
      const minYExtent = Math.min(ba.yMax - ba.yMin, bb.yMax - bb.yMin)
      if (yOverlap >= minYExtent * 0.75) {
        let leftBox, rightBox
        if (ba.xMax < bb.xMin - 0.5) { leftBox = ba; rightBox = bb }
        else if (bb.xMax < ba.xMin - 0.5) { leftBox = bb; rightBox = ba }

        if (leftBox) {
          const gapXMin = leftBox.xMax, gapXMax = rightBox.xMin
          const slotWidth = gapXMax - gapXMin
          if (slotWidth >= 1.0) {
            const hasIntermediate = bboxes.some((bx, i) => {
              if (i === a || i === b) return false
              return bx.xMax > gapXMin + 0.5 && bx.xMin < gapXMax - 0.5
            })
            if (!hasIntermediate) {
              const openYMin = Math.max(ba.yMin, bb.yMin)
              const openYMax = Math.min(ba.yMax, bb.yMax)
              const depth = getRegionFloorDepth(stlArrayBuffer, topZ, gapXMin, gapXMax, openYMin, openYMax)
              // depth = topZ when no floor found (through-slot) — still valid, accept all gaps
              xGaps.push({ direction: 'x', wallXMin: gapXMin, wallXMax: gapXMax, openYMin, openYMax, depth })
            }
          }
        }
      }

      // ── Y-gap (walls in Y, open in X) ────────────────────────────────────
      const xOverlap = Math.min(ba.xMax, bb.xMax) - Math.max(ba.xMin, bb.xMin)
      const minXExtent = Math.min(ba.xMax - ba.xMin, bb.xMax - bb.xMin)
      if (xOverlap >= minXExtent * 0.75) {
        let topBox, botBox
        if (ba.yMax < bb.yMin - 0.5) { topBox = ba; botBox = bb }
        else if (bb.yMax < ba.yMin - 0.5) { topBox = bb; botBox = ba }

        if (topBox) {
          const gapYMin = topBox.yMax, gapYMax = botBox.yMin
          const slotWidth = gapYMax - gapYMin
          if (slotWidth >= 1.0) {
            const hasIntermediate = bboxes.some((bx, i) => {
              if (i === a || i === b) return false
              return bx.yMax > gapYMin + 0.5 && bx.yMin < gapYMax - 0.5
            })
            if (!hasIntermediate) {
              const openXMin = Math.max(ba.xMin, bb.xMin)
              const openXMax = Math.min(ba.xMax, bb.xMax)
              const depth = getRegionFloorDepth(stlArrayBuffer, topZ, openXMin, openXMax, gapYMin, gapYMax)
              // depth = topZ when no floor found (through-slot) — still valid, accept all gaps
              yGaps.push({ direction: 'y', wallYMin: gapYMin, wallYMax: gapYMax, openXMin, openXMax, depth })
            }
          }
        }
      }
    }
  }

  // ── Merge coincident X-gaps (same wall X, different open-Y extents) ───────
  const mergedX = []
  for (const g of xGaps) {
    const existing = mergedX.find(m =>
      Math.abs(m.wallXMin - g.wallXMin) < 1.0 && Math.abs(m.wallXMax - g.wallXMax) < 1.0)
    if (existing) {
      existing.openYMin = Math.min(existing.openYMin, g.openYMin)
      existing.openYMax = Math.max(existing.openYMax, g.openYMax)
      existing.depth = Math.max(existing.depth, g.depth)
    } else {
      mergedX.push({ ...g })
    }
  }

  // ── Merge coincident Y-gaps ───────────────────────────────────────────────
  const mergedY = []
  for (const g of yGaps) {
    const existing = mergedY.find(m =>
      Math.abs(m.wallYMin - g.wallYMin) < 1.0 && Math.abs(m.wallYMax - g.wallYMax) < 1.0)
    if (existing) {
      existing.openXMin = Math.min(existing.openXMin, g.openXMin)
      existing.openXMax = Math.max(existing.openXMax, g.openXMax)
      existing.depth = Math.max(existing.depth, g.depth)
    } else {
      mergedY.push({ ...g })
    }
  }

  // ── Detect cross: overlapping X-gap + Y-gap → single cross slot ──────────
  const slots = []
  const usedX = new Set(), usedY = new Set()

  for (let xi = 0; xi < mergedX.length; xi++) {
    const xg = mergedX[xi]
    for (let yi = 0; yi < mergedY.length; yi++) {
      const yg = mergedY[yi]
      // Cross if the X-gap walls fit inside the Y-gap open X range AND vice versa
      const xOverlap = xg.wallXMin < yg.openXMax - 0.5 && xg.wallXMax > yg.openXMin + 0.5
      const yOverlap = yg.wallYMin < xg.openYMax - 0.5 && yg.wallYMax > xg.openYMin + 0.5
      if (xOverlap && yOverlap) {
        slots.push({
          direction: 'cross',
          wallXMin: xg.wallXMin, wallXMax: xg.wallXMax,
          wallYMin: yg.wallYMin, wallYMax: yg.wallYMax,
          openXMin: yg.openXMin, openXMax: yg.openXMax,
          openYMin: xg.openYMin, openYMax: xg.openYMax,
          depth: Math.max(xg.depth, yg.depth),
        })
        usedX.add(xi); usedY.add(yi)
      }
    }
  }

  for (let xi = 0; xi < mergedX.length; xi++) {
    if (!usedX.has(xi)) slots.push(mergedX[xi])
  }
  for (let yi = 0; yi < mergedY.length; yi++) {
    if (!usedY.has(yi)) slots.push(mergedY[yi])
  }

  return slots
}

// ── Feature detection ─────────────────────────────────────────────────────────

export function detectFeatures(stlArrayBuffer, toolDiameter = 3.175) {
  if (!stlArrayBuffer) return []
  const topZ = getStlTopZ(stlArrayBuffer)
  const ops = []
  let colorIdx = 0

  // ── Profile: bottom slice, outer contours ─────────────────────────────────
  const bottomContours = extractSliceContours(stlArrayBuffer, 0.01)
  if (bottomContours.length > 0) {
    const bottomIsOuter = classifyContours(bottomContours)
    const bottomAreas = bottomContours.map(polygonArea)
    bottomContours
      .map((_, i) => i)
      .filter(i => bottomIsOuter[i])
      .sort((a, b) => bottomAreas[b] - bottomAreas[a])
      .forEach(ci => {
        const [cx, cy] = polygonCentroid(bottomContours[ci])
        ops.push({
          id: ops.length + 1,
          type: 'profile',
          label: `Profile Cut ${ops.filter(o => o.type === 'profile').length + 1}`,
          centroid: [cx, cy],
          detectedDepth: topZ,
          detectedCount: 1,
          color: OP_COLORS[colorIdx++ % OP_COLORS.length],
          enabled: true,
          overrides: {},
        })
      })
  }

  // ── Open slot: top surface, X-gaps between Y-aligned outer contours ───────
  const topContours = extractSliceContours(stlArrayBuffer, topZ - 0.01)
  if (topContours.length > 0) {
    const topIsOuter = classifyContours(topContours)
    const topOuters = topContours.filter((_, i) => topIsOuter[i])
    for (const slot of detectOpenSlots(topOuters, stlArrayBuffer, topZ)) {
      let label
      if (slot.direction === 'cross') label = 'Cross Slot'
      else if (slot.direction === 'x') label = `Slot ${(slot.wallXMax - slot.wallXMin).toFixed(1)}mm`
      else label = `Slot ${(slot.wallYMax - slot.wallYMin).toFixed(1)}mm`
      ops.push({
        id: ops.length + 1,
        type: 'slot',
        label,
        slotBounds: slot,
        detectedDepth: slot.depth,
        detectedCount: 1,
        color: OP_COLORS[colorIdx++ % OP_COLORS.length],
        enabled: true,
        overrides: {},
      })
    }
  }

  // ── Pocket / Drill ────────────────────────────────────────────────────────
  const floorZs = getFloorZLevels(stlArrayBuffer, topZ)
  const scanZSet = new Set([Math.round((topZ - 0.01) * 100) / 100])
  for (const fz of floorZs) scanZSet.add(Math.round((fz - 0.05) * 100) / 100)

  const knownFeatures = []
  const edgePocketKnown = []
  const groups = new Map()

  const sortedScanZ = [...scanZSet].filter(z => z > 0 && z < topZ).sort((a, b) => b - a)

  for (const sliceZ of sortedScanZ) {
    const contours = extractSliceContours(stlArrayBuffer, sliceZ)
    if (contours.length === 0) continue
    const isOuter = classifyContours(contours)
    const featureDepths = getFeatureDepths(stlArrayBuffer, topZ, contours, sliceZ)

    // Edge pocket detection: concave circular arcs in outer contours
    for (let ci = 0; ci < contours.length; ci++) {
      if (!isOuter[ci]) continue
      for (const ep of detectEdgePocketsFromContour(contours[ci], stlArrayBuffer, topZ, sliceZ, toolDiameter)) {
        if (edgePocketKnown.some(k => Math.hypot(k.cx - ep.cx, k.cy - ep.cy) < 2 && Math.abs(k.r - ep.r) < 1)) continue
        edgePocketKnown.push(ep)
        ops.push({
          id: ops.length + 1,
          type: 'edge-pocket',
          label: `Edge Pocket ⌀${(ep.r * 2).toFixed(1)}mm`,
          edgeCenter: [ep.cx, ep.cy],
          edgeRadius: ep.r,
          detectedDepth: ep.depth,
          detectionSliceZ: sliceZ,
          detectedCount: 1,
          color: OP_COLORS[colorIdx++ % OP_COLORS.length],
          enabled: true,
          overrides: {},
        })
      }
    }

    for (let ci = 0; ci < contours.length; ci++) {
      if (isOuter[ci]) continue
      const { cx, cy, r } = circleFromContour(contours[ci])

      if (knownFeatures.some(([kx, ky, kr]) =>
        Math.hypot(kx - cx, ky - cy) < 1.5 && Math.abs(kr - r) < 1.0)) continue
      knownFeatures.push([cx, cy, r])

      const area = polygonArea(contours[ci])
      const roundness = area / (Math.PI * r * r)
      const depth = featureDepths[ci]
      const diameter = r * 2
      const isThrough = depth >= topZ - 0.5

      let type, key, label
      if (roundness > 0.7) {
        // Classify as drill only when hole fits the bit; larger holes need pocket (XY clearing)
        const needsPocket = diameter > toolDiameter * 1.05
        type = needsPocket ? 'pocket' : 'drill'
        const roundDia = Math.round(diameter * 4) / 4
        key = `${type}|d${roundDia}|${isThrough ? 'through' : Math.round(depth * 2) / 2}`
        label = type === 'drill' ? `Drill ⌀${diameter.toFixed(1)}mm` : `Pocket ⌀${diameter.toFixed(1)}mm`
      } else {
        type = 'pocket'
        const roundArea = Math.round(area / 50) * 50
        key = `pocket|a${roundArea}|z${Math.round(depth * 2) / 2}`
        label = `Pocket ${area.toFixed(0)}mm²`
      }

      if (!groups.has(key)) {
        groups.set(key, { type, label, depth, diameter: r * 2, centroids: [], centroidSliceZs: [], colorIdx: colorIdx++, sliceZ })
      }
      groups.get(key).centroids.push([cx, cy])
      groups.get(key).centroidSliceZs.push(sliceZ)
    }
  }

  for (const g of groups.values()) {
    const count = g.centroids.length
    ops.push({
      id: ops.length + 1,
      type: g.type,
      label: count > 1 ? `${g.label} ×${count}` : g.label,
      centroids: g.centroids,
      detectedDepth: g.depth,
      detectedCount: count,
      color: OP_COLORS[g.colorIdx % OP_COLORS.length],
      enabled: true,
      overrides: {},
      detectedDiameter: g.diameter,
      centroidSliceZs: g.centroidSliceZs,  // per-centroid slice Z — each centroid may be visible at a different depth
      detectionSliceZ: g.sliceZ,
    })
  }

  return ops
}

// ── Volumetric feature tracking (per-feature Z-continuity) ──────────────────

const CENTROID_TOL = 2.0     // mm: max centroid drift to consider the same feature
const AREA_DIFF_RATIO = 0.05 // 5%: max relative area change within one tier of a feature

// Track each physical void feature independently through the Z-stack via nearest-centroid
// matching, instead of comparing whole layers as one atomic unit. This is what lets an
// unrelated feature's shape change (e.g. a hex bolt head transitioning to a round thread hole)
// avoid corrupting a completely different, unchanged hole's depth elsewhere in the model.
//
// Per layer, handles:
//  - continuation: same feature, area within tolerance → track extends
//  - tier split: same XY, area beyond tolerance (counterbore → thread hole) → close this tier,
//    open a new one
//  - merge: a track's (pre-merge) centroid gets swallowed by a larger contour (e.g. a slot
//    crossing a pocket) → track stays open against the merged blob, but keeps tracking its
//    pre-merge centroid/area as its true identity. Plain nearest-centroid matching on the next
//    layer then naturally re-finds it the moment the blob demerges — no separate "resume" path
//    needed.
//  - one-layer grace gap: a track with zero match for exactly one layer (slicing noise near a
//    floor) is not immediately closed.
//
// Known residual limitation: if ONE track's own void splits into two-or-more separate voids in
// a single step (e.g. a wide pocket floor revealing two disconnected deeper features), only the
// nearest child inherits the parent's history; sibling children start fresh tracks. This
// under-states their startDepth (skips less material, never more) rather than risking a gouge.
//
// Returns a flat array of { zTop, zBottom, contour, centroid, area }, one per contiguous
// single-tier run of one physical feature.
export function trackFeaturesAcrossLayers(layerStack) {
  const closed = []
  let open = []

  const closeTrack = (t, zBottom) => {
    const clean = t.run.filter(r => !r.merged)
    const pick = clean.length > 0 ? clean : t.run
    const mid = pick[Math.floor(pick.length / 2)]
    closed.push({ zTop: t.zTop, zBottom, contour: mid.contour, centroid: t.centroid, area: t.area })
  }

  for (const layer of layerStack) {
    const info = layer.voidContours.map(c => ({ c, centroid: polygonCentroid(c), area: polygonArea(c) }))

    // Globally-sorted greedy matching: candidate (track, contour) pairs within centroid
    // tolerance, assigned nearest-first across the whole layer — not per-track in array order,
    // which can mis-pair closely spaced duplicate features (e.g. 3 identical bolt holes) when
    // Clipper doesn't return contours in a stable order between independent layer slices.
    const pairs = []
    for (let ti = 0; ti < open.length; ti++) {
      for (let ci = 0; ci < info.length; ci++) {
        const d = Math.hypot(open[ti].centroid[0] - info[ci].centroid[0], open[ti].centroid[1] - info[ci].centroid[1])
        if (d <= CENTROID_TOL) pairs.push({ ti, ci, d })
      }
    }
    pairs.sort((a, b) => a.d - b.d)

    const matchedTrack = new Set()
    const claimedContour = new Set()
    const nextOpen = new Array(open.length).fill(null)

    for (const { ti, ci } of pairs) {
      if (matchedTrack.has(ti) || claimedContour.has(ci)) continue
      matchedTrack.add(ti); claimedContour.add(ci)
      const t = open[ti]
      const { c, centroid, area } = info[ci]
      const avg = (area + t.area) / 2
      const areaOk = avg === 0 || Math.abs(area - t.area) / avg <= AREA_DIFF_RATIO
      if (areaOk) {
        t.run.push({ z: layer.z, contour: c, merged: false })
        nextOpen[ti] = { zTop: t.zTop, centroid, area, run: t.run, lastZ: layer.z, missed: 0 }
      } else {
        // Tier split: same feature, real diameter/shape change (e.g. counterbore → thread hole)
        closeTrack(t, t.lastZ)
        nextOpen[ti] = { zTop: layer.z, centroid, area, run: [{ z: layer.z, contour: c, merged: false }], lastZ: layer.z, missed: 0 }
      }
    }

    // Merge fallback: unmatched open tracks whose (pre-merge) centroid now lies inside a
    // MEANINGFULLY LARGER contour (e.g. a slot crossing this pocket). Multiple tracks may
    // share one host. The size requirement matters: polygonCentroid is a plain vertex average,
    // not area-weighted, so two differently-tessellated contours at the same true location can
    // drift past CENTROID_TOL on tessellation noise alone — plain containment would then treat
    // an unrelated same-or-smaller feature nearby as a false "merge" instead of correctly
    // closing this track and letting the other feature start its own.
    for (let ti = 0; ti < open.length; ti++) {
      if (matchedTrack.has(ti)) continue
      const t = open[ti]
      const hostIdx = info.findIndex(x =>
        x.area > t.area * (1 + AREA_DIFF_RATIO) && pointInPolygon(t.centroid[0], t.centroid[1], x.c)
      )
      if (hostIdx !== -1) {
        claimedContour.add(hostIdx)
        t.run.push({ z: layer.z, contour: info[hostIdx].c, merged: true })
        // lastZ advances through the merge (this XY position is still void and needs
        // clearing) even though centroid/area stay frozen at pre-merge values for
        // re-matching. Otherwise a merge that never demerges before the stack ends would
        // silently drop machining coverage for the rest of that feature's depth.
        nextOpen[ti] = { zTop: t.zTop, centroid: t.centroid, area: t.area, run: t.run, lastZ: layer.z, missed: 0 }
      } else if (t.missed < 1) {
        nextOpen[ti] = { ...t, missed: t.missed + 1 }
      } else {
        closeTrack(t, t.lastZ)
        nextOpen[ti] = null
      }
    }

    // Genuinely new contours (unclaimed by continuation, tier split, or merge) start new tracks.
    for (let ci = 0; ci < info.length; ci++) {
      if (claimedContour.has(ci)) continue
      nextOpen.push({
        zTop: layer.z, centroid: info[ci].centroid, area: info[ci].area,
        run: [{ z: layer.z, contour: info[ci].c, merged: false }], lastZ: layer.z, missed: 0,
      })
    }

    open = nextOpen.filter(Boolean)
  }

  for (const t of open) closeTrack(t, t.lastZ)

  return closed
}

// ── Prior-material mask computation (Step 4) ─────────────────────────────────

// Returns a representative 2-D polygon for op (for coverage / containment tests).
function getOpRepresentativeContour(op, stlArrayBuffer, topZ) {
  if (op.detectedDiameter != null) {
    const [cx, cy] = op.centroids?.[0] ?? op.centroid ?? [0, 0]
    return makeCircleContour(cx, cy, op.detectedDiameter / 2)
  }
  if ((op.type === 'pocket' || op.type === 'drill') && op.centroids?.length) {
    const sz = op.detectionSliceZ ?? topZ - 0.01
    const sc = extractSliceContours(stlArrayBuffer, sz)
    if (sc.length === 0) return null
    const ci = findContourForCentroid(sc, op.centroids[0])
    return sc[ci] ?? null
  }
  if (op.type === 'edge-pocket' && op.edgeCenter) {
    return makeCircleContour(op.edgeCenter[0], op.edgeCenter[1], op.edgeRadius)
  }
  if (op.type === 'slot' && op.slotBounds) {
    const s = op.slotBounds
    if (s.direction === 'cross') {
      // Build the actual 12-vertex cross polygon so containment tests don't
      // treat the entire stock face as "cleared" by the slot.
      const { wallXMin: wxl, wallXMax: wxr, wallYMin: wyl, wallYMax: wyr,
              openXMin: oxl, openXMax: oxr, openYMin: oyl, openYMax: oyr } = s
      return [
        [oxl, wyr], [wxl, wyr], [wxl, oyr], [wxr, oyr],
        [wxr, wyr], [oxr, wyr], [oxr, wyl], [wxr, wyl],
        [wxr, oyl], [wxl, oyl], [wxl, wyl], [oxl, wyl],
      ]
    }
    const x1 = s.openXMin ?? s.wallXMin, x2 = s.openXMax ?? s.wallXMax
    const y1 = s.openYMin ?? s.wallYMin, y2 = s.openYMax ?? s.wallYMax
    return [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
  }
  return null
}

// For each pocket/drill in sorted order, compute:
//   priorClearDepth: max depth of any prior op that covers this op's centroid AND
//                   is SHALLOWER than this op.  Used as startDepth to skip Z passes
//                   that prior ops already cleared.
//   priorMaterialMask: clipper union of prior op contours that cover this op's centroid
//                      AND are the SAME OR DEEPER depth.  Used to clip the XY toolpath
//                      so passes don't re-cut already-cleared area at the same depth tier.
function computePriorMasks(ops, stlArrayBuffer, topZ) {
  const contourCache = ops.map(op => getOpRepresentativeContour(op, stlArrayBuffer, topZ))

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.type !== 'pocket' && op.type !== 'drill') continue

    const [cx, cy] = op.centroids?.[0] ?? op.centroid ?? [null, null]
    if (cx == null) continue

    let priorClearDepth = 0
    const sameDepthMaskContours = []

    for (let j = 0; j < i; j++) {
      const prior = ops[j]
      // Slots and open-contours are open shapes — their footprint may only
      // partially cover a pocket's area, so they must not trigger a full Z-skip.
      if (prior.type === 'profile' || prior.type === 'slot' || prior.type === 'open-contour') continue
      const priorContour = contourCache[j]
      if (!priorContour) continue
      if (!pointInPolygon(cx, cy, priorContour)) continue

      if (prior.detectedDepth < op.detectedDepth - 0.1) {
        // Prior is shallower: it cleared this centroid's area from depth 0 → prior.detectedDepth.
        priorClearDepth = Math.max(priorClearDepth, prior.detectedDepth)
      } else {
        // Prior is same depth or deeper: its XY footprint is already fully cleared.
        sameDepthMaskContours.push(priorContour)
      }
    }

    if (priorClearDepth > 0) op.priorClearDepth = priorClearDepth
    if (sameDepthMaskContours.length > 0) {
      op.priorMaterialMask = sameDepthMaskContours.length === 1
        ? sameDepthMaskContours
        : unionContours(sameDepthMaskContours)
    }
  }
}

// ── analyzeVolume: volume-aware feature detection ─────────────────────────────

export function analyzeVolume(stlArrayBuffer, toolDiameter = 3.175, stockBoundsOverride = null) {
  if (!stlArrayBuffer) return []

  const topZ = getStlTopZ(stlArrayBuffer)
  const bounds = stockBoundsOverride ?? getStlBounds(stlArrayBuffer)
  const ops = []
  let colorIdx = 0

  // ── 1. Outer profiles from bottom-slice outer contours ──────────────────────
  const bottomContours = extractSliceContours(stlArrayBuffer, 0.01)
  if (bottomContours.length > 0) {
    const bottomIsOuter = classifyContours(bottomContours)
    const bottomAreas = bottomContours.map(polygonArea)
    bottomContours
      .map((_, i) => i)
      .filter(i => bottomIsOuter[i])
      .sort((a, b) => bottomAreas[b] - bottomAreas[a])
      .forEach(ci => {
        const [cx, cy] = polygonCentroid(bottomContours[ci])
        ops.push({
          type: 'profile',
          label: `Profile Cut ${ops.filter(o => o.type === 'profile').length + 1}`,
          centroid: [cx, cy],
          detectedDepth: topZ,
          detectedCount: 1,
          color: OP_COLORS[colorIdx++ % OP_COLORS.length],
          enabled: true,
          overrides: {},
        })
      })
  }

  // ── 2. Edge-pockets + open slots from top-surface outer contours ─────────────
  const sliceZTop = topZ - 0.01
  const topContours = extractSliceContours(stlArrayBuffer, sliceZTop)
  if (topContours.length > 0) {
    const topIsOuter = classifyContours(topContours)
    const topOuters = topContours.filter((_, i) => topIsOuter[i])

    // Edge pockets (concave arcs on outer perimeter)
    const edgePocketKnown = []
    for (let ci = 0; ci < topContours.length; ci++) {
      if (!topIsOuter[ci]) continue
      for (const ep of detectEdgePocketsFromContour(topContours[ci], stlArrayBuffer, topZ, sliceZTop, toolDiameter)) {
        if (edgePocketKnown.some(k => Math.hypot(k.cx-ep.cx, k.cy-ep.cy) < 2 && Math.abs(k.r-ep.r) < 1)) continue
        edgePocketKnown.push(ep)
        ops.push({
          type: 'edge-pocket',
          label: `Edge Pocket ⌀${(ep.r*2).toFixed(1)}mm`,
          edgeCenter: [ep.cx, ep.cy],
          edgeRadius: ep.r,
          detectedDepth: ep.depth,
          detectionSliceZ: sliceZTop,
          detectedCount: 1,
          color: OP_COLORS[colorIdx++ % OP_COLORS.length],
          enabled: true,
          overrides: {},
        })
      }
    }

    // Open slots (gaps between outer contour pieces — handles through-slots that produce
    // no inner void contours because they are open on two or more sides)
    for (const slot of detectOpenSlots(topOuters, stlArrayBuffer, topZ)) {
      let label
      if (slot.direction === 'cross') label = 'Cross Slot'
      else if (slot.direction === 'x') label = `Slot ${(slot.wallXMax - slot.wallXMin).toFixed(1)}mm`
      else label = `Slot ${(slot.wallYMax - slot.wallYMin).toFixed(1)}mm`
      ops.push({
        type: 'slot',
        label,
        slotBounds: slot,
        detectedDepth: slot.depth,
        detectedArea: (slot.wallXMax - slot.wallXMin) * (slot.wallYMax - slot.wallYMin),
        detectedCount: 1,
        color: OP_COLORS[colorIdx++ % OP_COLORS.length],
        enabled: true,
        overrides: {},
      })
    }
  }

  // ── 3. Region-based void detection ─────────────────────────────────────────────
  // Slice the STL and track each physical void feature independently through Z
  // (see trackFeaturesAcrossLayers) so one feature's depth is never corrupted by an
  // unrelated feature elsewhere in the model changing shape at a nearby Z.
  const zStep = 0.5
  const layerStack = sliceAllLayers(stlArrayBuffer, zStep)
  const tracks = trackFeaturesAcrossLayers(layerStack)

  // Coarse key (type + diameter/area) → candidate cluster list. startDepth/depth are NOT
  // baked into the key directly: two independently-tracked duplicate features (e.g. 3
  // identical bolt holes) can have their zTop/zBottom land on layer indices that differ by a
  // fraction of zStep, which would round to different buckets and wrongly split one duplicate
  // group into two op cards. Instead cluster within tolerance below.
  const coarseGroups = new Map()

  for (const track of tracks) {
    const area = polygonArea(track.contour)
    if (area < 0.5) continue
    const { cx, cy, r } = circleFromContour(track.contour)
    const diameter = r * 2
    const roundness = area / (Math.PI * r * r)
    const bbox = getBbox(track.contour)

    const depth = topZ - track.zBottom
    // startDepth: depth already cleared before this track's own tier opens. 0 for features
    // accessible from the top surface; nonzero only for a genuinely nested/stepped tier
    // (e.g. the narrow bore beneath a counterbore starts at counterbore depth) — the track's
    // own zTop already reflects that directly, no cross-checking against neighbors needed.
    const startDepth = Math.max(0, topZ - track.zTop - zStep / 2)
    const detectionSliceZ = Math.max((track.zTop + track.zBottom) / 2, 0.01)

    const EPS = 1.5
    const touchesBoundary =
      bbox.xMin <= bounds.xMin + EPS || bbox.xMax >= bounds.xMax - EPS ||
      bbox.yMin <= bounds.yMin + EPS || bbox.yMax >= bounds.yMax - EPS

    // Too small for safe open-contour profiling — risk of leaving loose material
    const minDim = Math.min(bbox.xMax - bbox.xMin, bbox.yMax - bbox.yMin)
    const tooSmallForOpenContour = minDim < toolDiameter * 3

    let type, label, coarseKey

    if (roundness > 0.7 && diameter <= toolDiameter * 1.05) {
      type = 'drill'
      const roundDia = Math.round(diameter * 4) / 4
      label = `Drill ⌀${diameter.toFixed(1)}mm`
      coarseKey = `drill|d${roundDia}`
    } else if (touchesBoundary && !tooSmallForOpenContour) {
      type = 'open-contour'
      label = `Open Contour ${area.toFixed(0)}mm²`
      coarseKey = `open|a${Math.round(area / 50) * 50}|${Math.round(cx)}|${Math.round(cy)}`
    } else {
      type = 'pocket'
      label = roundness > 0.7
        ? `Pocket ⌀${diameter.toFixed(1)}mm`
        : `Pocket ${area.toFixed(0)}mm²`
      const roundDia = Math.round(diameter * 4) / 4
      coarseKey = roundness > 0.7 ? `pocket|d${roundDia}` : `pocket|a${Math.round(area / 50) * 50}`
    }

    if (!coarseGroups.has(coarseKey)) coarseGroups.set(coarseKey, [])
    coarseGroups.get(coarseKey).push({
      type, label, depth, startDepth, cx, cy, detectionSliceZ,
      diameter: roundness > 0.7 ? diameter : 0, area,
    })
  }

  // Within each coarse group, cluster by (depth, startDepth) within one zStep of tolerance so
  // duplicate features with independently-tracked but functionally-identical Z ranges still
  // collapse into one editable op card instead of fragmenting on sub-zStep jitter.
  const groups = new Map()
  let clusterSeq = 0
  for (const entries of coarseGroups.values()) {
    const clusters = [] // { depth, startDepth, members: [entry] }
    for (const e of entries) {
      const cluster = clusters.find(c =>
        Math.abs(c.depth - e.depth) <= zStep && Math.abs(c.startDepth - e.startDepth) <= zStep
      )
      if (cluster) cluster.members.push(e)
      else clusters.push({ depth: e.depth, startDepth: e.startDepth, members: [e] })
    }
    for (const cluster of clusters) {
      const key = `cluster${clusterSeq++}`
      const first = cluster.members[0]
      groups.set(key, {
        type: first.type, label: first.label,
        depth: cluster.depth, startDepth: cluster.startDepth,
        area: first.area, diameter: first.diameter,
        centroids: [], centroidSliceZs: [],
        detectionSliceZ: first.detectionSliceZ,
        colorIdx: colorIdx++,
      })
      const g = groups.get(key)
      for (const m of cluster.members) {
        g.centroids.push([m.cx, m.cy])
        g.centroidSliceZs.push(m.detectionSliceZ)
      }
    }
  }

  for (const g of groups.values()) {
    const count = g.centroids.length
    ops.push({
      type: g.type,
      label: count > 1 ? `${g.label} ×${count}` : g.label,
      centroids: g.centroids,
      centroidSliceZs: g.centroidSliceZs,
      detectionSliceZ: g.detectionSliceZ,
      detectedDepth: g.depth,
      startDepth: g.startDepth > 0.1 ? g.startDepth : undefined,
      detectedArea: g.area,
      detectedCount: count,
      detectedDiameter: g.diameter > 0 ? g.diameter : undefined,
      color: OP_COLORS[g.colorIdx % OP_COLORS.length],
      enabled: true,
      overrides: {},
    })
  }

  // ── Step 5: Sort — profiles last, drills before profiles, shallower first,
  //            larger area first within the same depth tier. ──────────────────
  ops.sort((a, b) => {
    if (a.type === 'profile'      && b.type !== 'profile')      return 1
    if (b.type === 'profile'      && a.type !== 'profile')      return -1
    if (a.type === 'drill'        && b.type !== 'drill')        return 1
    if (b.type === 'drill'        && a.type !== 'drill')        return -1
    if (a.type === 'open-contour' && b.type !== 'open-contour') return 1
    if (b.type === 'open-contour' && a.type !== 'open-contour') return -1
    const dDiff = a.detectedDepth - b.detectedDepth
    if (Math.abs(dDiff) > 0.1) return dDiff
    const aA = a.detectedArea ?? (a.detectedDiameter ? Math.PI * (a.detectedDiameter/2)**2 : 0)
    const aB = b.detectedArea ?? (b.detectedDiameter ? Math.PI * (b.detectedDiameter/2)**2 : 0)
    return aB - aA
  })

  // ── Step 4: Prior-material masks — compute for each pocket/drill op ─────────
  computePriorMasks(ops, stlArrayBuffer, topZ)

  // ── Assign sequential IDs ───────────────────────────────────────────────────
  ops.forEach((op, i) => { op.id = i + 1 })

  return ops
}

// ── Toolpath visualization data ───────────────────────────────────────────────

export function computeToolpathData(stlArrayBuffer, operations, globalToolSettings) {
  const result = []

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]
    if (op.enabled === false) continue

    const eop = effectiveOp(op, globalToolSettings)
    const color = eop.color ?? OP_COLORS[i % OP_COLORS.length]
    const paths = []
    const stepdown = Math.max(eop.stepdown, 0.001)
    const toolRadius = eop.toolDiameter / 2

    if (eop.type === 'drill') {
      const centroids = eop.centroids ?? (eop.centroid ? [eop.centroid] : [])
      for (const [cx, cy] of centroids) {
        paths.push([[cx, cy, 0], [cx, cy, -eop.depth]])
      }
      result.push({ label: eop.label, color, paths, operationId: eop.id, feedrate: eop.feedrate })
      continue
    }

    if (eop.type === 'slot' && eop.slotBounds) {
      const effectiveDepth = Math.min(eop.depth, eop.slotBounds.depth)
      const zPasses = Math.ceil(effectiveDepth / stepdown)
      const virtualContour = buildSlotVirtualContour(eop.slotBounds, toolRadius)
      const toolpaths = applyDirection(generatePocketPasses(virtualContour, toolRadius, eop.stepover), eop.direction)
      for (let pass = 1; pass <= zPasses; pass++) {
        const z = -Math.min(pass * stepdown, effectiveDepth)
        for (const path of toolpaths) {
          if (path.length < 2) continue
          const polyline = path.map(([x, y]) => [x, y, z])
          polyline.push([path[0][0], path[0][1], z])
          paths.push(polyline)
        }
      }
      result.push({ label: eop.label, color, paths, operationId: eop.id, feedrate: eop.feedrate })
      continue
    }

    const topZ = getStlTopZ(stlArrayBuffer)
    const targetRadius = eop.detectedDiameter != null ? eop.detectedDiameter / 2 : null

    if (eop.type === 'edge-pocket' && eop.edgeCenter && eop.edgeRadius) {
      const [ecx, ecy] = eop.edgeCenter
      const er = eop.edgeRadius
      const startDepth = eop.detectionSliceZ != null ? topZ - eop.detectionSliceZ : 0
      const effectiveDepth = eop.depth
      if (effectiveDepth > 0) {
        const zPasses = Math.ceil(effectiveDepth / stepdown)
        const virtualContour = makeCircleContour(ecx, ecy, er)
        const toolpaths = applyDirection(generatePocketPasses(virtualContour, toolRadius, eop.stepover), eop.direction)
        for (let pass = 1; pass <= zPasses; pass++) {
          const z = -Math.min(pass * stepdown, effectiveDepth)
          if (pass * stepdown < startDepth - 0.001) continue
          for (const path of toolpaths) {
            if (path.length < 2) continue
            const polyline = path.map(([x, y]) => [x, y, z])
            polyline.push([path[0][0], path[0][1], z])
            paths.push(polyline)
          }
        }
      }
      result.push({ label: eop.label, color, paths, operationId: eop.id, feedrate: eop.feedrate })
      continue
    }

    if (eop.type === 'open-contour' && eop.centroids?.length) {
      const sz = eop.detectionSliceZ ?? topZ - 0.01
      const sc = extractSliceContours(stlArrayBuffer, sz)
      if (sc.length > 0) {
        const sOuter = classifyContours(sc)
        const opStartDepth = eop.startDepth ?? 0
        for (const centroid of eop.centroids) {
          const ci = findContourForCentroid(sc, centroid, null, sOuter, false)
          if (sOuter[ci]) continue
          // Expand contour outward by tool radius so the outermost pass exits the stock boundary
          const expanded = offsetContours([sc[ci]], toolRadius)
          if (expanded.length === 0) continue
          const effectiveDepth = eop.depth
          if (effectiveDepth <= 0) continue
          const zPasses = Math.ceil(effectiveDepth / stepdown)
          const toolpaths = applyDirection(
            generatePocketPasses(expanded[0], toolRadius, eop.stepover),
            eop.direction
          )
          for (let pass = 1; pass <= zPasses; pass++) {
            const z = -Math.min(pass * stepdown, effectiveDepth)
            if (pass * stepdown < opStartDepth - 0.001) continue
            for (const path of toolpaths) {
              if (path.length < 2) continue
              const polyline = path.map(([x, y]) => [x, y, z])
              polyline.push([path[0][0], path[0][1], z])
              paths.push(polyline)
            }
          }
        }
      }
      result.push({ label: eop.label, color, paths, operationId: eop.id, feedrate: eop.feedrate })
      continue
    }

    if (eop.type === 'pocket' && eop.centroids?.length) {
      // Each centroid may have been detected at a different sliceZ (e.g. miter bar thread holes
      // only have STL walls below their parent hex pocket, not at the top surface). Use each
      // centroid's own detection slice so the correct contour is always found.
      const czs = eop.centroidSliceZs ?? eop.centroids.map(() => eop.detectionSliceZ ?? topZ - 0.01)

      // Group centroids by sliceZ to minimise redundant STL slicing.
      const sliceGroups = new Map()
      for (let i = 0; i < eop.centroids.length; i++) {
        const sz = czs[i] ?? topZ - 0.01
        if (!sliceGroups.has(sz)) sliceGroups.set(sz, [])
        sliceGroups.get(sz).push(i)
      }

      for (const [sz, idxs] of sliceGroups) {
        const sc = extractSliceContours(stlArrayBuffer, sz)
        if (sc.length === 0) continue
        const sDepths = getFeatureDepths(stlArrayBuffer, topZ, sc, sz)
        const sHierarchy = buildContourHierarchy(sc)
        const sOuter = sHierarchy.isOuter

        for (const idx of idxs) {
          // startDepth (from trackFeaturesAcrossLayers) and priorClearDepth (from
          // computePriorMasks) are the two accurate sources for "material already cleared
          // above this op" — both correctly resolve to 0/undefined for a plain top-accessible
          // pocket, so that must be the final fallback, not a re-derived guess.
          const startDepth = eop.startDepth ?? eop.priorClearDepth ?? 0
          const ci = findContourForCentroid(sc, eop.centroids[idx], targetRadius, sOuter, false)
          if (sOuter[ci]) continue
          const effectiveDepth = Math.min(eop.depth, sDepths[ci])
          if (effectiveDepth <= 0) continue
          const zPasses = Math.ceil(effectiveDepth / stepdown)
          const toolpaths = applyDirection(
            generatePocketPasses(sc[ci], toolRadius, eop.stepover, eop.priorMaterialMask ?? null, findIslandsForContour(sHierarchy, sc, ci)),
            eop.direction
          )
          for (let pass = 1; pass <= zPasses; pass++) {
            const z = -Math.min(pass * stepdown, effectiveDepth)
            if (pass * stepdown < startDepth - 0.001) continue
            for (const path of toolpaths) {
              if (path.length < 2) continue
              const polyline = path.map(([x, y]) => [x, y, z])
              polyline.push([path[0][0], path[0][1], z])
              paths.push(polyline)
            }
          }
        }
      }
    } else {
      // Profile or non-centroid pocket: single slice covers all contours.
      const sliceZ = eop.type === 'profile' ? 0.01 : (eop.detectionSliceZ ?? topZ - 0.01)
      const contours = extractSliceContours(stlArrayBuffer, sliceZ)
      if (contours.length === 0) { result.push({ label: eop.label, color, paths, operationId: eop.id }); continue }
      const featureDepths = eop.type === 'profile' ? contours.map(() => topZ) : getFeatureDepths(stlArrayBuffer, topZ, contours, sliceZ)
      const hierarchy = buildContourHierarchy(contours)
      const isOuter = hierarchy.isOuter
      const startDepth = eop.startDepth ?? eop.priorClearDepth
        ?? (eop.type === 'pocket' && eop.detectionSliceZ != null ? topZ - eop.detectionSliceZ : 0)

      for (const ci of findContoursForOp(contours, isOuter, eop)) {
        if (eop.type === 'profile' && !isOuter[ci]) continue
        if (eop.type === 'pocket' && isOuter[ci]) continue
        const effectiveDepth = Math.min(eop.depth, featureDepths[ci])
        if (effectiveDepth <= 0) continue
        const zPasses = Math.ceil(effectiveDepth / stepdown)
        const toolpaths = applyDirection(
          eop.type === 'pocket'
            ? generatePocketPasses(contours[ci], toolRadius, eop.stepover, eop.priorMaterialMask ?? null, findIslandsForContour(hierarchy, contours, ci))
            : offsetContours([contours[ci]], toolRadius),
          eop.direction
        )
        for (let pass = 1; pass <= zPasses; pass++) {
          const z = -Math.min(pass * stepdown, effectiveDepth)
          if (pass * stepdown < startDepth - 0.001) continue
          for (const path of toolpaths) {
            if (path.length < 2) continue
            const polyline = path.map(([x, y]) => [x, y, z])
            polyline.push([path[0][0], path[0][1], z])
            paths.push(polyline)
          }
        }
      }
    }

    result.push({ label: eop.label, color, paths, operationId: eop.id, feedrate: eop.feedrate })
  }

  return result
}

// ── Rapid move visualization ──────────────────────────────────────────────────

// Returns polylines for non-cutting (rapid/traverse) moves between cutting paths.
// Each polyline is [[x,y,z], ...] in toolpath coords (z=0 at surface, negative = depth).
export function computeRapidPaths(toolpathData, safeZ = 5) {
  const paths = []
  let lastPt = null

  for (const op of toolpathData) {
    for (const path of op.paths) {
      if (!path?.length) continue
      const first = path[0]
      const last = path[path.length - 1]

      if (lastPt) {
        const [lx, ly, lz] = lastPt
        const [sx, sy, sz] = first
        paths.push([
          [lx, ly, lz],
          [lx, ly, safeZ],
          [sx, sy, safeZ],
          [sx, sy, sz],
        ])
      }

      lastPt = last
    }
  }
  return paths
}

// ── Full move sequence for timeline simulation ────────────────────────────────

// Simulated rapid feedrate (mm/min) — G0 moves use machine max speed, approximate here.
const RAPID_FEEDRATE = 5000

// Returns { moves, totalLength, totalTime, opRanges } where each move has { type, points, feedrate, startDist, dist }
// opRanges: [{ operationId, startDist, endDist }] — distance range for each operation in the sequence.
// totalTime is in seconds at actual feedrates, used to drive the timeline simulation at true speed.
export function computeMoveSequence(toolpathData, safeZ = 5) {
  const moves = []
  let lastX = 0, lastY = 0, lastZ = safeZ
  const opMoveStarts = []

  for (const op of toolpathData) {
    const feedrate = op.feedrate ?? 1000
    opMoveStarts.push({ operationId: op.operationId, startIdx: moves.length })

    for (const path of op.paths) {
      if (!path?.length) continue
      const [sx, sy, sz] = path[0]

      if (lastZ < safeZ - 0.01) {
        moves.push({ type: 'rapid', points: [[lastX, lastY, lastZ], [lastX, lastY, safeZ]], feedrate: RAPID_FEEDRATE })
      }
      if (Math.hypot(sx - lastX, sy - lastY) > 0.01 || Math.abs(lastZ - safeZ) > 0.01) {
        moves.push({ type: 'rapid', points: [[lastX, lastY, safeZ], [sx, sy, safeZ]], feedrate: RAPID_FEEDRATE })
      }
      if (sz < safeZ - 0.01) {
        moves.push({ type: 'plunge', points: [[sx, sy, safeZ], [sx, sy, sz]], feedrate: feedrate * 0.3 })
      }
      moves.push({ type: 'feed', points: path.slice(), feedrate })

      const lastPt = path[path.length - 1]
      lastX = lastPt[0]; lastY = lastPt[1]; lastZ = lastPt[2]
    }
  }

  if (lastZ < safeZ - 0.01) {
    moves.push({ type: 'rapid', points: [[lastX, lastY, lastZ], [lastX, lastY, safeZ]], feedrate: RAPID_FEEDRATE })
  }

  let cumDist = 0
  let totalTime = 0
  for (const move of moves) {
    let d = 0
    const pts = move.points
    for (let i = 1; i < pts.length; i++) {
      d += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1], pts[i][2] - pts[i-1][2])
    }
    move.startDist = cumDist
    move.dist = Math.max(d, 1e-6)
    cumDist += move.dist
    // feedrate is mm/min → convert to mm/s for time calculation
    totalTime += move.dist / ((move.feedrate ?? RAPID_FEEDRATE) / 60)
  }

  const opRanges = opMoveStarts.map((r, i) => {
    const nextIdx = opMoveStarts[i + 1]?.startIdx ?? moves.length
    const startDist = r.startIdx < moves.length ? moves[r.startIdx].startDist : cumDist
    const endDist   = nextIdx   < moves.length ? moves[nextIdx].startDist   : cumDist
    return { operationId: r.operationId, startDist, endDist }
  })

  return { moves, totalLength: cumDist, totalTime, opRanges }
}

// Maps G-code line indices to progress values from moveSeq using XY coordinate matching.
//
// The G-code and computeMoveSequence walk the same toolpaths in the same order, so their
// XY positions align — but their total distances differ because:
//   - G-code adds origin-return moves (G0 X0 Y0) and origin-safe-Z raises per operation
//   - computeMoveSequence lifts/plunges between every adjacent path; G-code connects paths
//     within the same pass with feed moves at depth (no intermediate lift)
//
// Using distance-based progress from the G-code string therefore drifts from simProgress.
// Instead, we build a flat list of (x, y, progress) from moveSeq and sequentially match
// each G-code motion line to the nearest forward XY point in that list.
// Z-only G-code lines (origin height raises) and return-to-origin lines (X0 Y0) are skipped
// because they have no corresponding point in moveSeq.
//
// Returns { progressToLine: [{lineIndex, progress}], linesToProgress: Map<lineIndex, progress> } or null.
export function buildGcodeLineMap(gcode, moveSeq) {
  if (!gcode || !moveSeq?.moves?.length || !moveSeq.totalLength) return null

  // Flatten all move points to (x, y, progress) in sequence order
  const seqPoints = []
  for (const move of moveSeq.moves) {
    let localDist = 0
    const pts = move.points
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) localDist += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1], pts[i][2]-pts[i-1][2])
      seqPoints.push({ x: pts[i][0], y: pts[i][1], progress: (move.startDist + localDist) / moveSeq.totalLength })
    }
  }

  // Parse G-code — only collect lines that explicitly move X or Y (skip Z-only raises)
  const lines = gcode.split('\n')
  let cx = 0, cy = 0, cz = 0
  const gcodeMotions = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/;.*/, '').trim()
    if (!line) continue
    let nx = cx, ny = cy, nz = cz
    let hasX = false, hasY = false
    for (const word of (line.toUpperCase().match(/[A-Z][+-]?[0-9.]+/g) ?? [])) {
      const letter = word[0], val = parseFloat(word.slice(1))
      if      (letter === 'X') { nx = val; hasX = true }
      else if (letter === 'Y') { ny = val; hasY = true }
      else if (letter === 'Z') { nz = val }
    }

    if ((hasX || hasY) && (nx !== cx || ny !== cy || nz !== cz)) {
      gcodeMotions.push({ lineIndex: i, x: nx, y: ny })
    }
    if (nx !== cx || ny !== cy || nz !== cz) { cx = nx; cy = ny; cz = nz }
  }

  // Sequential forward walk: match each G-code XY motion to the nearest seqPoint
  const MATCH_TOL = 0.02  // mm — G-code is toFixed(4), seqPoints are full-precision
  const progressToLine = []
  const linesToProgress = new Map()
  let seqIdx = 0

  for (const gcm of gcodeMotions) {
    // Skip return-to-origin (footer G0 X0 Y0) — not in seqPoints
    if (Math.abs(gcm.x) < MATCH_TOL && Math.abs(gcm.y) < MATCH_TOL) continue

    let bestIdx = -1, bestDist = Infinity
    const searchEnd = Math.min(seqIdx + 500, seqPoints.length)
    for (let j = seqIdx; j < searchEnd; j++) {
      const d = Math.hypot(gcm.x - seqPoints[j].x, gcm.y - seqPoints[j].y)
      if (d < MATCH_TOL && d < bestDist) { bestDist = d; bestIdx = j }
    }

    if (bestIdx >= 0) {
      const progress = seqPoints[bestIdx].progress
      progressToLine.push({ lineIndex: gcm.lineIndex, progress })
      linesToProgress.set(gcm.lineIndex, progress)
      seqIdx = bestIdx + 1
    }
  }

  if (!progressToLine.length) return null
  return { progressToLine, linesToProgress }
}

// ── Timeline helpers ──────────────────────────────────────────────────────────

function _interpolateAlongPoints(points, t) {
  if (points.length === 1) return [...points[0]]
  let totalLen = 0
  const segLens = []
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0]-points[i-1][0], points[i][1]-points[i-1][1], points[i][2]-points[i-1][2])
    segLens.push(d); totalLen += d
  }
  if (totalLen < 1e-10) return [...points[0]]
  const target = Math.max(0, Math.min(1, t)) * totalLen
  let cum = 0
  for (let i = 0; i < segLens.length; i++) {
    if (cum + segLens[i] >= target || i === segLens.length - 1) {
      const segT = segLens[i] > 1e-10 ? Math.max(0, Math.min(1, (target - cum) / segLens[i])) : 0
      const p0 = points[i], p1 = points[i + 1] ?? points[i]
      return [p0[0]+(p1[0]-p0[0])*segT, p0[1]+(p1[1]-p0[1])*segT, p0[2]+(p1[2]-p0[2])*segT]
    }
    cum += segLens[i]
  }
  return [...points[points.length - 1]]
}

export function getPositionAtProgress(moveSeq, progress) {
  if (!moveSeq?.moves?.length) return null
  const { moves, totalLength } = moveSeq
  if (totalLength < 1e-10) return moves[0]?.points[0] ? [...moves[0].points[0]] : null
  const targetDist = Math.max(0, Math.min(1, progress)) * totalLength
  for (const move of moves) {
    if (targetDist <= move.startDist + move.dist) {
      const localT = (targetDist - move.startDist) / move.dist
      return _interpolateAlongPoints(move.points, localT)
    }
  }
  const last = moves[moves.length - 1]
  return [...last.points[last.points.length - 1]]
}

export function getMoveAtProgress(moveSeq, progress) {
  if (!moveSeq?.moves?.length) return null
  const { moves, totalLength } = moveSeq
  const targetDist = Math.max(0, Math.min(1, progress)) * totalLength
  for (const move of moves) {
    if (targetDist <= move.startDist + move.dist) return move
  }
  return moves[moves.length - 1]
}

// ── G-code generation ─────────────────────────────────────────────────────────

export function generateGcode(stlArrayBuffer, operations, postProcessorId, globalToolSettings, machineSettings) {
  const pp = getPostProcessor(postProcessorId)
  const zBase = machineSettings.zZeroMode === 'spoilboard' ? machineSettings.materialThickness : 0
  const safeZ = zBase + machineSettings.safetyHeight
  const originSafeZ = zBase + machineSettings.originSafetyHeight
  const lines = []

  const enabledOps = operations.filter(op => op.enabled !== false)

  for (const op of enabledOps) {
    const eop = effectiveOp(op, globalToolSettings)
    lines.push(pp.header(eop))
    lines.push('')
    lines.push(pp.comment(`=== ${eop.label} ===`))

    const opLines =
      eop.type === 'drill' ? generateDrill(eop, pp, safeZ, originSafeZ, machineSettings, zBase) :
      eop.type === 'slot'  ? generateSlot(eop, pp, safeZ, originSafeZ, machineSettings, zBase) :
      generateMillingOp(stlArrayBuffer, eop, pp, safeZ, originSafeZ, machineSettings, zBase)

    for (const line of opLines) lines.push(line)
    lines.push(pp.footer(originSafeZ))
    lines.push('')
  }

  return lines.join('\n')
}

function generateMillingOp(stlArrayBuffer, eop, pp, safeZ, originSafeZ, ms, zBase) {
  const lines = []
  const stepdown = Math.max(eop.stepdown, 0.001)
  const topZ = getStlTopZ(stlArrayBuffer)
  const toolRadius = eop.toolDiameter / 2
  const targetRadius = eop.detectedDiameter != null ? eop.detectedDiameter / 2 : null

  lines.push(pp.rapidTo(undefined, undefined, originSafeZ))

  if (eop.type === 'edge-pocket' && eop.edgeCenter && eop.edgeRadius) {
    const [ecx, ecy] = eop.edgeCenter
    const er = eop.edgeRadius
    const startDepth = eop.detectionSliceZ != null ? topZ - eop.detectionSliceZ : 0
    const effectiveDepth = eop.depth
    if (effectiveDepth > 0) {
      const zPasses = Math.ceil(effectiveDepth / stepdown)
      const virtualContour = makeCircleContour(ecx, ecy, er)
      const validPaths = applyDirection(generatePocketPasses(virtualContour, toolRadius, eop.stepover).filter(p => p.length >= 2), eop.direction)
      if (validPaths.length > 0) {
        for (let pass = 1; pass <= zPasses; pass++) {
          const cutZ = zBase - Math.min(pass * stepdown, effectiveDepth)
          if (pass * stepdown < startDepth - 0.001) continue
          lines.push(pp.comment(`Edge pocket pass ${pass}/${zPasses} — depth ${(zBase - cutZ).toFixed(3)} mm`))
          const [startX, startY] = validPaths[0][0]
          lines.push(pp.rapidTo(startX, startY, safeZ))
          lines.push(pp.linearTo(undefined, undefined, cutZ, eop.feedrate * 0.3))
          for (let pi = 0; pi < validPaths.length; pi++) {
            const path = validPaths[pi]
            const [rx, ry] = path[0]
            if (pi > 0) lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
            for (let k = 1; k < path.length; k++)
              lines.push(pp.linearTo(path[k][0], path[k][1], undefined, eop.feedrate))
            lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
          }
          lines.push(pp.rapidTo(undefined, undefined, safeZ))
        }
      }
    }
    return lines
  }

  if (eop.type === 'open-contour' && eop.centroids?.length) {
    const sz = eop.detectionSliceZ ?? topZ - 0.01
    const sc = extractSliceContours(stlArrayBuffer, sz)
    if (sc.length === 0) { lines.push(pp.comment('No contours found')); return lines }
    const sOuter = classifyContours(sc)
    const opStartDepth = eop.startDepth ?? 0
    const effectiveDepth = eop.depth

    for (const [cx, cy] of eop.centroids) {
      const ci = findContourForCentroid(sc, [cx, cy], null, sOuter, false)
      if (sOuter[ci]) continue
      const expanded = offsetContours([sc[ci]], toolRadius)
      if (expanded.length === 0) continue
      if (effectiveDepth <= 0) continue
      const zPasses = Math.ceil(effectiveDepth / stepdown)
      const validPaths = applyDirection(
        generatePocketPasses(expanded[0], toolRadius, eop.stepover).filter(p => p.length >= 2),
        eop.direction
      )
      if (validPaths.length === 0) continue

      for (let pass = 1; pass <= zPasses; pass++) {
        const cutZ = zBase - Math.min(pass * stepdown, effectiveDepth)
        if (pass * stepdown < opStartDepth - 0.001) continue
        lines.push(pp.comment(`Open contour pass ${pass}/${zPasses} — depth ${(zBase - cutZ).toFixed(3)} mm`))
        const [startX, startY] = validPaths[0][0]
        lines.push(pp.rapidTo(startX, startY, safeZ))
        lines.push(pp.linearTo(undefined, undefined, cutZ, eop.feedrate * 0.3))
        for (let pi = 0; pi < validPaths.length; pi++) {
          const path = validPaths[pi]
          const [rx, ry] = path[0]
          if (pi > 0) lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
          for (let k = 1; k < path.length; k++)
            lines.push(pp.linearTo(path[k][0], path[k][1], undefined, eop.feedrate))
          lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
        }
        lines.push(pp.rapidTo(undefined, undefined, safeZ))
      }
    }
    return lines
  }

  if (eop.type === 'pocket' && eop.centroids?.length) {
    // Each centroid may have been detected at a different sliceZ. Use per-centroid slices so
    // features only visible below a parent pocket (e.g. thread holes under hex heads) get
    // the right contour even when grouped with features visible from the top.
    const czs = eop.centroidSliceZs ?? eop.centroids.map(() => eop.detectionSliceZ ?? topZ - 0.01)

    const sliceGroups = new Map()
    for (let i = 0; i < eop.centroids.length; i++) {
      const sz = czs[i] ?? topZ - 0.01
      if (!sliceGroups.has(sz)) sliceGroups.set(sz, [])
      sliceGroups.get(sz).push(i)
    }

    for (const [sz, idxs] of sliceGroups) {
      const sc = extractSliceContours(stlArrayBuffer, sz)
      if (sc.length === 0) continue
      const sDepths = getFeatureDepths(stlArrayBuffer, topZ, sc, sz)
      const sHierarchy = buildContourHierarchy(sc)
      const sOuter = sHierarchy.isOuter

      for (const idx of idxs) {
        // startDepth (from trackFeaturesAcrossLayers) and priorClearDepth (from
        // computePriorMasks) are the two accurate sources for "material already cleared
        // above this op" — both correctly resolve to 0/undefined for a plain top-accessible
        // pocket, so that must be the final fallback, not a re-derived guess.
        const startDepth = eop.startDepth ?? eop.priorClearDepth ?? 0
        const ci = findContourForCentroid(sc, eop.centroids[idx], targetRadius, sOuter, false)
        if (sOuter[ci]) continue
        const effectiveDepth = Math.min(eop.depth, sDepths[ci])
        if (effectiveDepth <= 0) continue
        const zPasses = Math.ceil(effectiveDepth / stepdown)
        const validPaths = applyDirection(
          generatePocketPasses(sc[ci], toolRadius, eop.stepover, eop.priorMaterialMask ?? null, findIslandsForContour(sHierarchy, sc, ci)).filter(p => p.length >= 2),
          eop.direction
        )
        if (validPaths.length === 0) continue

        for (let pass = 1; pass <= zPasses; pass++) {
          const cutZ = zBase - Math.min(pass * stepdown, effectiveDepth)
          if (pass * stepdown < startDepth - 0.001) continue
          lines.push(pp.comment(`Pass ${pass}/${zPasses} — depth ${(zBase - cutZ).toFixed(3)} mm`))
          const [startX, startY] = validPaths[0][0]
          lines.push(pp.rapidTo(startX, startY, safeZ))
          lines.push(pp.linearTo(undefined, undefined, cutZ, eop.feedrate * 0.3))
          for (let pi = 0; pi < validPaths.length; pi++) {
            const path = validPaths[pi]
            const [rx, ry] = path[0]
            if (pi > 0) lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
            for (let k = 1; k < path.length; k++) {
              lines.push(pp.linearTo(path[k][0], path[k][1], undefined, eop.feedrate))
            }
            lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
          }
          lines.push(pp.rapidTo(undefined, undefined, safeZ))
        }
      }
    }
  } else {
    // Profile or non-centroid pocket: single slice covers all contours.
    const sliceZ = eop.type === 'profile' ? 0.01 : (eop.detectionSliceZ ?? topZ - 0.01)
    const contours = extractSliceContours(stlArrayBuffer, sliceZ)
    if (contours.length === 0) { lines.push(pp.comment('No contours found')); return lines }

    const featureDepths = eop.type === 'profile' ? contours.map(() => topZ) : getFeatureDepths(stlArrayBuffer, topZ, contours, sliceZ)
    const hierarchy = buildContourHierarchy(contours)
    const isOuter = hierarchy.isOuter
    // startDepth (from trackFeaturesAcrossLayers) and priorClearDepth (from computePriorMasks)
    // are the two accurate sources for "material already cleared above this op" — both
    // correctly resolve to 0/undefined for a plain top-accessible pocket.
    const startDepth = eop.startDepth ?? eop.priorClearDepth ?? 0

    for (const ci of findContoursForOp(contours, isOuter, eop)) {
      if (eop.type === 'profile' && !isOuter[ci]) continue
      if (eop.type === 'pocket' && isOuter[ci]) continue
      const effectiveDepth = Math.min(eop.depth, featureDepths[ci])
      if (effectiveDepth <= 0) continue
      const zPasses = Math.ceil(effectiveDepth / stepdown)
      const toolpaths = applyDirection(
        eop.type === 'pocket'
          ? generatePocketPasses(contours[ci], toolRadius, eop.stepover, eop.priorMaterialMask ?? null, findIslandsForContour(hierarchy, contours, ci))
          : offsetContours([contours[ci]], toolRadius),
        eop.direction
      )

      if (eop.type === 'pocket') {
        const validPaths = toolpaths.filter(p => p.length >= 2)
        if (validPaths.length === 0) continue
        for (let pass = 1; pass <= zPasses; pass++) {
          const cutZ = zBase - Math.min(pass * stepdown, effectiveDepth)
          if (pass * stepdown < startDepth - 0.001) continue
          lines.push(pp.comment(`Pass ${pass}/${zPasses} — depth ${(zBase - cutZ).toFixed(3)} mm`))
          const [startX, startY] = validPaths[0][0]
          lines.push(pp.rapidTo(startX, startY, safeZ))
          lines.push(pp.linearTo(undefined, undefined, cutZ, eop.feedrate * 0.3))
          for (let pi = 0; pi < validPaths.length; pi++) {
            const path = validPaths[pi]
            const [rx, ry] = path[0]
            if (pi > 0) lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
            for (let k = 1; k < path.length; k++) {
              lines.push(pp.linearTo(path[k][0], path[k][1], undefined, eop.feedrate))
            }
            lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
          }
          lines.push(pp.rapidTo(undefined, undefined, safeZ))
        }
      } else {
        for (let pass = 1; pass <= zPasses; pass++) {
          const cutZ = zBase - Math.min(pass * stepdown, effectiveDepth)
          lines.push(pp.comment(`Feature ${ci + 1} pass ${pass}/${zPasses} — depth ${(zBase - cutZ).toFixed(3)} mm`))
          for (const path of toolpaths) {
            if (path.length < 2) continue
            const [startX, startY] = path[0]
            lines.push(pp.rapidTo(startX, startY, safeZ))
            lines.push(pp.linearTo(undefined, undefined, cutZ, eop.feedrate * 0.3))
            for (let k = 1; k < path.length; k++) {
              lines.push(pp.linearTo(path[k][0], path[k][1], undefined, eop.feedrate))
            }
            lines.push(pp.linearTo(startX, startY, undefined, eop.feedrate))
            lines.push(pp.rapidTo(undefined, undefined, safeZ))
          }
        }
      }
    }
  }

  return lines
}

function generateDrill(eop, pp, safeZ, originSafeZ, ms, zBase) {
  const lines = []
  const centroids = eop.centroids ?? (eop.centroid ? [eop.centroid] : [])

  if (centroids.length === 0) {
    lines.push(pp.comment('No drill locations'))
    return lines
  }

  lines.push(pp.rapidTo(undefined, undefined, originSafeZ))
  for (const [cx, cy] of centroids) {
    const cutZ = zBase - eop.depth
    lines.push(pp.comment(`Drill X${cx.toFixed(3)} Y${cy.toFixed(3)} depth ${eop.depth.toFixed(3)}`))
    lines.push(pp.rapidTo(cx, cy, safeZ))
    lines.push(pp.linearTo(undefined, undefined, cutZ, eop.feedrate * 0.5))
    lines.push(pp.rapidTo(undefined, undefined, safeZ))
  }

  return lines
}

function generateSlot(eop, pp, safeZ, originSafeZ, ms, zBase) {
  const lines = []
  const { slotBounds } = eop
  if (!slotBounds) { lines.push(pp.comment('No slot bounds')); return lines }

  const stepdown = Math.max(eop.stepdown, 0.001)
  const toolRadius = eop.toolDiameter / 2
  const effectiveDepth = Math.min(eop.depth, slotBounds.depth)
  const zPasses = Math.ceil(effectiveDepth / stepdown)
  const virtualContour = buildSlotVirtualContour(slotBounds, toolRadius)
  const validPaths = applyDirection(generatePocketPasses(virtualContour, toolRadius, eop.stepover).filter(p => p.length >= 2), eop.direction)

  if (validPaths.length === 0) {
    lines.push(pp.comment('No slot paths'))
    return lines
  }

  lines.push(pp.rapidTo(undefined, undefined, originSafeZ))

  for (let pass = 1; pass <= zPasses; pass++) {
    const cutZ = zBase - Math.min(pass * stepdown, effectiveDepth)
    lines.push(pp.comment(`Slot pass ${pass}/${zPasses} — depth ${(zBase - cutZ).toFixed(3)} mm`))

    const [startX, startY] = validPaths[0][0]
    lines.push(pp.rapidTo(startX, startY, safeZ))
    lines.push(pp.linearTo(undefined, undefined, cutZ, eop.feedrate * 0.3))

    for (let pi = 0; pi < validPaths.length; pi++) {
      const path = validPaths[pi]
      const [rx, ry] = path[0]
      if (pi > 0) lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
      for (let k = 1; k < path.length; k++) {
        lines.push(pp.linearTo(path[k][0], path[k][1], undefined, eop.feedrate))
      }
      lines.push(pp.linearTo(rx, ry, undefined, eop.feedrate))
    }

    lines.push(pp.rapidTo(undefined, undefined, safeZ))
  }

  return lines
}
