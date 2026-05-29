import { getPostProcessor } from './postProcessors/index'
import {
  extractSliceContours, getStlTopZ, getFeatureDepths,
  getFloorZLevels, getRegionFloorDepth,
  polygonArea, polygonCentroid,
} from './stlSlicer'
import { offsetContours } from './toolpathOffsets'

const OP_COLORS = [0x00e5ff, 0xffab40, 0x69f0ae, 0xff4081, 0xea80fc, 0xffd740, 0x40c4ff, 0xe040fb]

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

function findContourForCentroid(contours, [tx, ty]) {
  let bestCi = 0, bestDist = Infinity
  for (let ci = 0; ci < contours.length; ci++) {
    const [cx, cy] = polygonCentroid(contours[ci])
    const d = Math.hypot(cx - tx, cy - ty)
    if (d < bestDist) { bestDist = d; bestCi = ci }
  }
  return bestCi
}

function findContoursForOp(contours, isOuter, op) {
  if (op.centroids) {
    const seen = new Set()
    return op.centroids
      .map(c => findContourForCentroid(contours, c))
      .filter(ci => { if (seen.has(ci)) return false; seen.add(ci); return true })
  }
  if (op.centroid) return [findContourForCentroid(contours, op.centroid)]
  return contours.map((_, i) => i).filter(ci =>
    op.type === 'profile' ? isOuter[ci] : !isOuter[ci]
  )
}

// ── Toolpath generators ───────────────────────────────────────────────────────

// Concentric pocket passes expanding from center outward.
function generatePocketPasses(contour, toolRadius) {
  const stepover = Math.max(toolRadius * 0.85, 0.01)
  const inward = []
  for (let dist = toolRadius; ; dist += stepover) {
    const ocs = offsetContours([contour], -dist)
    if (ocs.length === 0) break
    if (ocs.reduce((s, c) => s + polygonArea(c), 0) < 0.5) break
    inward.push(ocs)
  }
  inward.reverse()  // innermost (smallest) first → center outward
  return inward.flat()
}

// Open slot: serpentine Y passes across slot width, extending past each Y edge by toolRadius.
function generateSlotPasses(slotBounds, toolRadius) {
  const { xMin, xMax, yMin, yMax } = slotBounds
  const stepover = Math.max(toolRadius * 0.85, 0.01)
  const slotCenterX = (xMin + xMax) / 2
  const maxHalfWidth = (xMax - xMin) / 2 - toolRadius

  // Build X offsets from center outward: [0, -s, +s, -2s, +2s, ...]
  const offsets = [0]
  for (let off = stepover; off <= maxHalfWidth + 0.01; off += stepover) {
    offsets.push(-off)
    offsets.push(off)
  }

  const extYMin = yMin - toolRadius
  const extYMax = yMax + toolRadius

  return offsets.map((off, i) => {
    const x = Math.max(xMin + toolRadius, Math.min(xMax - toolRadius, slotCenterX + off))
    return i % 2 === 0 ? [[x, extYMin], [x, extYMax]] : [[x, extYMax], [x, extYMin]]
  })
}

// Detect open slots: pairs of outer contours at the top surface that share a Y range
// but have an X gap between them, with a detectable floor in the gap (not just air between pieces).
function detectOpenSlots(outerContours, stlArrayBuffer, topZ) {
  const slots = []
  const bboxes = outerContours.map(getBbox)

  for (let a = 0; a < outerContours.length; a++) {
    for (let b = a + 1; b < outerContours.length; b++) {
      const ba = bboxes[a], bb = bboxes[b]

      const yOverlap = Math.min(ba.yMax, bb.yMax) - Math.max(ba.yMin, bb.yMin)
      const minYExtent = Math.min(ba.yMax - ba.yMin, bb.yMax - bb.yMin)
      if (yOverlap < minYExtent * 0.75) continue

      let leftBox, rightBox
      if (ba.xMax < bb.xMin - 0.5) { leftBox = ba; rightBox = bb }
      else if (bb.xMax < ba.xMin - 0.5) { leftBox = bb; rightBox = ba }
      else continue

      const gapXMin = leftBox.xMax
      const gapXMax = rightBox.xMin
      const slotWidth = gapXMax - gapXMin
      if (slotWidth < 1.0) continue

      const yMin = Math.max(ba.yMin, bb.yMin)
      const yMax = Math.min(ba.yMax, bb.yMax)

      // Require a physical floor inside the gap — otherwise it's just a gap between separate pieces
      const depth = getRegionFloorDepth(stlArrayBuffer, topZ, gapXMin, gapXMax, yMin, yMax)
      if (depth >= topZ - 0.5) continue

      slots.push({ xMin: gapXMin, xMax: gapXMax, yMin, yMax, width: slotWidth, depth })
    }
  }
  return slots
}

// ── Feature detection ─────────────────────────────────────────────────────────

export function detectFeatures(stlArrayBuffer) {
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
          toolDiameter: 3.175,
          feedrate: 1000,
          spindleSpeed: 18000,
          stepdown: 1.0,
          depth: Math.ceil(topZ),
          passes: 1,
          direction: 'climb',
        })
      })
  }

  // ── Open slot: top surface, X-gaps between Y-aligned outer contours ───────
  const topContours = extractSliceContours(stlArrayBuffer, topZ - 0.01)
  if (topContours.length > 0) {
    const topIsOuter = classifyContours(topContours)
    const topOuters = topContours.filter((_, i) => topIsOuter[i])
    for (const slot of detectOpenSlots(topOuters, stlArrayBuffer, topZ)) {
      ops.push({
        id: ops.length + 1,
        type: 'slot',
        label: `Slot ${slot.width.toFixed(1)}mm`,
        slotBounds: slot,
        detectedDepth: slot.depth,
        detectedCount: 1,
        color: OP_COLORS[colorIdx++ % OP_COLORS.length],
        toolDiameter: 3.175,
        feedrate: 800,
        spindleSpeed: 18000,
        stepdown: 0.5,
        depth: Math.ceil(slot.depth * 10) / 10,
        passes: 1,
        direction: 'climb',
      })
    }
  }

  // ── Pocket / Drill: scan at topZ-0.01 AND just below each pocket floor ────
  // Scanning below floors reveals thread holes hidden inside counterbores.
  const floorZs = getFloorZLevels(stlArrayBuffer, topZ)
  const scanZSet = new Set([Math.round((topZ - 0.01) * 100) / 100])
  for (const fz of floorZs) scanZSet.add(Math.round((fz - 0.05) * 100) / 100)

  // [cx, cy, r] — deduplicate by position AND radius so thread holes under counterbores
  // (same XY, different radius) are not mistaken for duplicates.
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

      // Deduplicate: skip if a feature at the same XY center AND similar radius was already found
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
        type = isThrough ? 'drill' : 'pocket'
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
        groups.set(key, { type, label, depth, diameter: r * 2, centroids: [], colorIdx: colorIdx++ })
      }
      groups.get(key).centroids.push([cx, cy])
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
      toolDiameter: g.type === 'drill' ? Math.min(g.diameter * 0.8, 3.175) : 3.175,
      feedrate: g.type === 'drill' ? 300 : 800,
      spindleSpeed: 18000,
      stepdown: g.type === 'drill' ? g.depth : 0.5,
      depth: Math.ceil(g.depth * 10) / 10,
      passes: 1,
      direction: 'climb',
    })
  }

  return ops
}

// ── Toolpath visualization data ───────────────────────────────────────────────

export function computeToolpathData(stlArrayBuffer, operations) {
  const result = []

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]
    const color = op.color ?? OP_COLORS[i % OP_COLORS.length]
    const paths = []
    const stepdown = Math.max(op.stepdown, 0.001)

    // Drill: vertical lines at each detected centroid, no STL re-slicing needed
    if (op.type === 'drill') {
      const centroids = op.centroids ?? (op.centroid ? [op.centroid] : [])
      for (const [cx, cy] of centroids) {
        paths.push([[cx, cy, 0], [cx, cy, -op.depth]])
      }
      result.push({ label: op.label, color, paths, operationId: op.id })
      continue
    }

    // Slot: parallel Y-axis passes across slot width
    if (op.type === 'slot' && op.slotBounds) {
      const toolRadius = op.toolDiameter / 2
      const effectiveDepth = Math.min(op.depth, op.slotBounds.depth)
      const zPasses = Math.ceil(effectiveDepth / stepdown)
      const slotPasses = generateSlotPasses(op.slotBounds, toolRadius)
      for (let pass = 1; pass <= zPasses; pass++) {
        const z = -Math.min(pass * stepdown, effectiveDepth)
        for (const [[x1, y1], [x2, y2]] of slotPasses) {
          paths.push([[x1, y1, z], [x2, y2, z]])
        }
      }
      result.push({ label: op.label, color, paths, operationId: op.id })
      continue
    }

    // Profile / Pocket: STL-contour based
    const topZ = getStlTopZ(stlArrayBuffer)
    const sliceZ = op.type === 'profile' ? 0.01 : topZ - 0.01
    const contours = extractSliceContours(stlArrayBuffer, sliceZ)
    if (contours.length === 0) { result.push({ label: op.label, color, paths, operationId: op.id }); continue }

    const featureDepths = op.type === 'profile'
      ? contours.map(() => topZ)
      : getFeatureDepths(stlArrayBuffer, topZ, contours)
    const isOuter = classifyContours(contours)
    const toolRadius = op.toolDiameter / 2

    for (const ci of findContoursForOp(contours, isOuter, op)) {
      if (op.type === 'profile' && !isOuter[ci]) continue
      if (op.type === 'pocket' && isOuter[ci]) continue
      const effectiveDepth = Math.min(op.depth, featureDepths[ci])
      if (effectiveDepth <= 0) continue
      const zPasses = Math.ceil(effectiveDepth / stepdown)

      const toolpaths = op.type === 'pocket'
        ? generatePocketPasses(contours[ci], toolRadius)
        : offsetContours([contours[ci]], toolRadius)

      for (let pass = 1; pass <= zPasses; pass++) {
        const z = -Math.min(pass * stepdown, effectiveDepth)
        for (const path of toolpaths) {
          if (path.length < 2) continue
          const polyline = path.map(([x, y]) => [x, y, z])
          polyline.push([path[0][0], path[0][1], z])
          paths.push(polyline)
        }
      }
    }

    result.push({ label: op.label, color, paths, operationId: op.id })
  }

  return result
}

// ── G-code generation ─────────────────────────────────────────────────────────

export function generateGcode(stlArrayBuffer, operations, postProcessorId) {
  const pp = getPostProcessor(postProcessorId)
  const lines = []

  for (const op of operations) {
    lines.push(pp.header(op))
    lines.push('')
    lines.push(pp.comment(`=== ${op.label} ===`))

    const opLines =
      op.type === 'drill' ? generateDrill(op, pp) :
      op.type === 'slot'  ? generateSlot(op, pp) :
      generateMillingOp(stlArrayBuffer, op, pp)

    for (const line of opLines) lines.push(line)
    lines.push(pp.footer())
    lines.push('')
  }

  return lines.join('\n')
}

function generateMillingOp(stlArrayBuffer, op, pp) {
  const lines = []
  const stepdown = Math.max(op.stepdown, 0.001)
  const safeZ = 5.0
  const topZ = getStlTopZ(stlArrayBuffer)
  const sliceZ = op.type === 'profile' ? 0.01 : topZ - 0.01
  const contours = extractSliceContours(stlArrayBuffer, sliceZ)

  if (contours.length === 0) {
    lines.push(pp.comment('No contours found'))
    return lines
  }

  const featureDepths = op.type === 'profile'
    ? contours.map(() => topZ)
    : getFeatureDepths(stlArrayBuffer, topZ, contours)
  const isOuter = classifyContours(contours)
  const toolRadius = op.toolDiameter / 2

  lines.push(pp.rapidTo(undefined, undefined, safeZ))

  for (const ci of findContoursForOp(contours, isOuter, op)) {
    if (op.type === 'profile' && !isOuter[ci]) continue
    if (op.type === 'pocket' && isOuter[ci]) continue
    const effectiveDepth = Math.min(op.depth, featureDepths[ci])
    if (effectiveDepth <= 0) continue
    const zPasses = Math.ceil(effectiveDepth / stepdown)

    const toolpaths = op.type === 'pocket'
      ? generatePocketPasses(contours[ci], toolRadius)
      : offsetContours([contours[ci]], toolRadius)

    for (let pass = 1; pass <= zPasses; pass++) {
      const z = -Math.min(pass * stepdown, effectiveDepth)
      lines.push(pp.comment(`Feature ${ci + 1} pass ${pass}/${zPasses} — depth ${Math.abs(z).toFixed(3)} mm`))

      for (const path of toolpaths) {
        if (path.length < 2) continue
        const [startX, startY] = path[0]
        lines.push(pp.rapidTo(startX, startY, safeZ))
        lines.push(pp.linearTo(undefined, undefined, z, op.feedrate * 0.3))
        for (let k = 1; k < path.length; k++) {
          lines.push(pp.linearTo(path[k][0], path[k][1], undefined, op.feedrate))
        }
        lines.push(pp.linearTo(startX, startY, undefined, op.feedrate))
        lines.push(pp.rapidTo(undefined, undefined, safeZ))
      }
    }
  }

  return lines
}

// Drill uses stored centroids directly — no re-slicing needed since thread holes
// may not be visible at the top surface (they're inside counterbore voids).
function generateDrill(op, pp) {
  const lines = []
  const safeZ = 5.0
  const centroids = op.centroids ?? (op.centroid ? [op.centroid] : [])

  if (centroids.length === 0) {
    lines.push(pp.comment('No drill locations'))
    return lines
  }

  lines.push(pp.rapidTo(undefined, undefined, safeZ))
  for (const [cx, cy] of centroids) {
    lines.push(pp.comment(`Drill X${cx.toFixed(3)} Y${cy.toFixed(3)} depth ${op.depth.toFixed(3)}`))
    lines.push(pp.rapidTo(cx, cy, safeZ))
    lines.push(pp.linearTo(undefined, undefined, -op.depth, op.feedrate * 0.5))
    lines.push(pp.rapidTo(undefined, undefined, safeZ))
  }

  return lines
}

function generateSlot(op, pp) {
  const lines = []
  const safeZ = 5.0
  const { slotBounds } = op
  if (!slotBounds) { lines.push(pp.comment('No slot bounds')); return lines }

  const stepdown = Math.max(op.stepdown, 0.001)
  const toolRadius = op.toolDiameter / 2
  const effectiveDepth = Math.min(op.depth, slotBounds.depth)
  const zPasses = Math.ceil(effectiveDepth / stepdown)
  const slotPasses = generateSlotPasses(slotBounds, toolRadius)

  lines.push(pp.rapidTo(undefined, undefined, safeZ))

  for (let pass = 1; pass <= zPasses; pass++) {
    const z = -Math.min(pass * stepdown, effectiveDepth)
    lines.push(pp.comment(`Slot pass ${pass}/${zPasses} — depth ${Math.abs(z).toFixed(3)} mm`))
    for (const [[x1, y1], [x2, y2]] of slotPasses) {
      lines.push(pp.rapidTo(x1, y1, safeZ))
      lines.push(pp.linearTo(undefined, undefined, z, op.feedrate * 0.3))
      lines.push(pp.linearTo(x2, y2, undefined, op.feedrate))
      lines.push(pp.rapidTo(undefined, undefined, safeZ))
    }
  }

  return lines
}
