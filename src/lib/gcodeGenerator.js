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

function generateSlotPasses(slotBounds, toolRadius, stepoverPct) {
  const { xMin, xMax, yMin, yMax } = slotBounds
  const stepover = Math.max(toolRadius * (stepoverPct / 100), 0.01)
  const slotCenterX = (xMin + xMax) / 2
  const maxHalfWidth = (xMax - xMin) / 2 - toolRadius

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
          depth: Math.ceil(topZ),
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
      ops.push({
        id: ops.length + 1,
        type: 'slot',
        label: `Slot ${slot.width.toFixed(1)}mm`,
        slotBounds: slot,
        detectedDepth: slot.depth,
        detectedCount: 1,
        color: OP_COLORS[colorIdx++ % OP_COLORS.length],
        depth: Math.ceil(slot.depth * 10) / 10,
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
      depth: Math.ceil(g.depth * 10) / 10,
      enabled: true,
      overrides: {},
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
      result.push({ label: eop.label, color, paths, operationId: eop.id })
      continue
    }

    if (eop.type === 'slot' && eop.slotBounds) {
      const effectiveDepth = Math.min(eop.depth, eop.slotBounds.depth)
      const zPasses = Math.ceil(effectiveDepth / stepdown)
      const slotPasses = generateSlotPasses(eop.slotBounds, toolRadius, eop.stepover)
      for (let pass = 1; pass <= zPasses; pass++) {
        const z = -Math.min(pass * stepdown, effectiveDepth)
        for (const [[x1, y1], [x2, y2]] of slotPasses) {
          paths.push([[x1, y1, z], [x2, y2, z]])
        }
      }
      result.push({ label: eop.label, color, paths, operationId: eop.id })
      continue
    }

    const topZ = getStlTopZ(stlArrayBuffer)
    const sliceZ = eop.type === 'profile' ? 0.01 : topZ - 0.01
    const contours = extractSliceContours(stlArrayBuffer, sliceZ)
    if (contours.length === 0) { result.push({ label: eop.label, color, paths, operationId: eop.id }); continue }

    const featureDepths = eop.type === 'profile'
      ? contours.map(() => topZ)
      : getFeatureDepths(stlArrayBuffer, topZ, contours)
    const isOuter = classifyContours(contours)

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
        for (const path of toolpaths) {
          if (path.length < 2) continue
          const polyline = path.map(([x, y]) => [x, y, z])
          polyline.push([path[0][0], path[0][1], z])
          paths.push(polyline)
        }
      }
    }

    result.push({ label: eop.label, color, paths, operationId: eop.id })
  }

  return result
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
  const sliceZ = eop.type === 'profile' ? 0.01 : topZ - 0.01
  const contours = extractSliceContours(stlArrayBuffer, sliceZ)

  if (contours.length === 0) {
    lines.push(pp.comment('No contours found'))
    return lines
  }

  const featureDepths = eop.type === 'profile'
    ? contours.map(() => topZ)
    : getFeatureDepths(stlArrayBuffer, topZ, contours)
  const isOuter = classifyContours(contours)
  const toolRadius = eop.toolDiameter / 2

  lines.push(pp.rapidTo(undefined, undefined, originSafeZ))

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
  const slotPasses = generateSlotPasses(slotBounds, toolRadius, eop.stepover)

  lines.push(pp.rapidTo(undefined, undefined, originSafeZ))

  for (let pass = 1; pass <= zPasses; pass++) {
    const cutZ = zBase - Math.min(pass * stepdown, effectiveDepth)
    lines.push(pp.comment(`Slot pass ${pass}/${zPasses} — depth ${(zBase - cutZ).toFixed(3)} mm`))
    for (const [[x1, y1], [x2, y2]] of slotPasses) {
      lines.push(pp.rapidTo(x1, y1, safeZ))
      lines.push(pp.linearTo(undefined, undefined, cutZ, eop.feedrate * 0.3))
      lines.push(pp.linearTo(x2, y2, undefined, eop.feedrate))
      lines.push(pp.rapidTo(undefined, undefined, safeZ))
    }
  }

  return lines
}
