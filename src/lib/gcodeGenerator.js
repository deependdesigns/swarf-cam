import { getPostProcessor } from './postProcessors/index'
import {
  extractSliceContours, getStlTopZ, getFeatureDepths,
  getFloorZLevels, getRegionFloorDepth,
  polygonArea, polygonCentroid,
} from './stlSlicer'
import { offsetContours } from './toolpathOffsets'

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

function classifyContours(contours) {
  const areas = contours.map(polygonArea)
  const byArea = contours.map((_, i) => i).sort((a, b) => areas[b] - areas[a])
  const isOuter = new Array(contours.length).fill(true)
  for (let i = 1; i < byArea.length; i++) {
    const ci = byArea[i]
    const [px, py] = contours[ci][0]
    for (let j = 0; j < i; j++) {
      const cj = byArea[j]
      let inside = false
      const poly = contours[cj]
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xi, yi] = poly[a], [xj, yj] = poly[b]
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
          inside = !inside
      }
      if (inside) { isOuter[ci] = false; break }
    }
  }
  return isOuter
}

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

// targetRadius: when set, concentric contours (same centroid) are disambiguated by
// how closely their average radius matches the expected feature size.
function findContourForCentroid(contours, [tx, ty], targetRadius = null) {
  let bestCi = 0, bestScore = Infinity
  for (let ci = 0; ci < contours.length; ci++) {
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
  if (op.centroids) {
    const seen = new Set()
    const targetRadius = op.detectedDiameter != null ? op.detectedDiameter / 2 : null
    return op.centroids
      .map(c => findContourForCentroid(contours, c, targetRadius))
      .filter(ci => { if (seen.has(ci)) return false; seen.add(ci); return true })
  }
  if (op.centroid) return [findContourForCentroid(contours, op.centroid)]
  return contours.map((_, i) => i).filter(ci =>
    op.type === 'profile' ? isOuter[ci] : !isOuter[ci]
  )
}

// ── Toolpath generators ───────────────────────────────────────────────────────

function generatePocketPasses(contour, toolRadius, stepoverPct) {
  const stepover = Math.max(toolRadius * (stepoverPct / 100), 0.01)
  const inward = []
  for (let dist = toolRadius; ; dist += stepover) {
    const ocs = offsetContours([contour], -dist)
    if (ocs.length === 0) break
    if (ocs.reduce((s, c) => s + polygonArea(c), 0) < 0.5) break
    inward.push(ocs)
  }
  inward.reverse()
  return inward.flat()
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
              if (depth < topZ - 0.5) {
                xGaps.push({ direction: 'x', wallXMin: gapXMin, wallXMax: gapXMax, openYMin, openYMax, depth })
              }
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
              if (depth < topZ - 0.5) {
                yGaps.push({ direction: 'y', wallYMin: gapYMin, wallYMax: gapYMax, openXMin, openXMax, depth })
              }
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
  const groups = new Map()

  const sortedScanZ = [...scanZSet].filter(z => z > 0 && z < topZ).sort((a, b) => b - a)

  for (const sliceZ of sortedScanZ) {
    const contours = extractSliceContours(stlArrayBuffer, sliceZ)
    if (contours.length === 0) continue
    const isOuter = classifyContours(contours)
    const featureDepths = getFeatureDepths(stlArrayBuffer, topZ, contours)

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
      const toolpaths = generatePocketPasses(virtualContour, toolRadius, eop.stepover)
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
        const sDepths = getFeatureDepths(stlArrayBuffer, topZ, sc)
        const sOuter = classifyContours(sc)
        const startDepth = topZ - sz

        for (const idx of idxs) {
          const ci = findContourForCentroid(sc, eop.centroids[idx], targetRadius)
          if (sOuter[ci]) continue
          const effectiveDepth = Math.min(eop.depth, sDepths[ci])
          if (effectiveDepth <= 0) continue
          const zPasses = Math.ceil(effectiveDepth / stepdown)
          const toolpaths = generatePocketPasses(sc[ci], toolRadius, eop.stepover)
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
      const featureDepths = eop.type === 'profile' ? contours.map(() => topZ) : getFeatureDepths(stlArrayBuffer, topZ, contours)
      const isOuter = classifyContours(contours)
      const startDepth = eop.type === 'pocket' && eop.detectionSliceZ != null ? topZ - eop.detectionSliceZ : 0

      for (const ci of findContoursForOp(contours, isOuter, eop)) {
        if (eop.type === 'profile' && !isOuter[ci]) continue
        if (eop.type === 'pocket' && isOuter[ci]) continue
        const effectiveDepth = Math.min(eop.depth, featureDepths[ci])
        if (effectiveDepth <= 0) continue
        const zPasses = Math.ceil(effectiveDepth / stepdown)
        const toolpaths = eop.type === 'pocket'
          ? generatePocketPasses(contours[ci], toolRadius, eop.stepover)
          : offsetContours([contours[ci]], toolRadius)
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

// Returns { moves, totalLength, totalTime } where each move has { type, points, feedrate, startDist, dist }
// totalTime is in seconds at actual feedrates, used to drive the timeline simulation at true speed.
export function computeMoveSequence(toolpathData, safeZ = 5) {
  const moves = []
  let lastX = 0, lastY = 0, lastZ = safeZ

  for (const op of toolpathData) {
    const feedrate = op.feedrate ?? 1000
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

  return { moves, totalLength: cumDist, totalTime }
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
      const sDepths = getFeatureDepths(stlArrayBuffer, topZ, sc)
      const sOuter = classifyContours(sc)
      const startDepth = topZ - sz

      for (const idx of idxs) {
        const ci = findContourForCentroid(sc, eop.centroids[idx], targetRadius)
        if (sOuter[ci]) continue
        const effectiveDepth = Math.min(eop.depth, sDepths[ci])
        if (effectiveDepth <= 0) continue
        const zPasses = Math.ceil(effectiveDepth / stepdown)
        const validPaths = generatePocketPasses(sc[ci], toolRadius, eop.stepover).filter(p => p.length >= 2)
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

    const featureDepths = eop.type === 'profile' ? contours.map(() => topZ) : getFeatureDepths(stlArrayBuffer, topZ, contours)
    const isOuter = classifyContours(contours)
    const startDepth = eop.type === 'pocket' && eop.detectionSliceZ != null ? topZ - eop.detectionSliceZ : 0

    for (const ci of findContoursForOp(contours, isOuter, eop)) {
      if (eop.type === 'profile' && !isOuter[ci]) continue
      if (eop.type === 'pocket' && isOuter[ci]) continue
      const effectiveDepth = Math.min(eop.depth, featureDepths[ci])
      if (effectiveDepth <= 0) continue
      const zPasses = Math.ceil(effectiveDepth / stepdown)
      const toolpaths = eop.type === 'pocket'
        ? generatePocketPasses(contours[ci], toolRadius, eop.stepover)
        : offsetContours([contours[ci]], toolRadius)

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
  const validPaths = generatePocketPasses(virtualContour, toolRadius, eop.stepover).filter(p => p.length >= 2)

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
