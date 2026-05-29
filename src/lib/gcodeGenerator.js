import { getPostProcessor } from './postProcessors/index'
import { extractSliceContours } from './stlSlicer'
import { offsetContours } from './toolpathOffsets'

export function generateGcode(stlArrayBuffer, operations, postProcessorId) {
  const pp = getPostProcessor(postProcessorId)
  const lines = []

  for (const op of operations) {
    lines.push(pp.header(op))
    lines.push('')
    lines.push(pp.comment(`=== ${op.label} ===`))

    const opLines = op.type === 'drill'
      ? generateDrill(op, pp)
      : generateMillingOp(stlArrayBuffer, op, pp)

    for (const line of opLines) lines.push(line)

    lines.push(pp.footer())
    lines.push('')
  }

  return lines.join('\n')
}

function generateMillingOp(stlArrayBuffer, op, pp) {
  const lines = []
  const stepdown = Math.max(op.stepdown, 0.001)
  const zPasses = Math.ceil(op.depth / stepdown)
  const safeZ = 5.0

  // Extract 2D contour from STL by slicing at Z=0 (top face)
  const contours = extractSliceContours(stlArrayBuffer, 0)

  if (contours.length === 0) {
    lines.push(pp.comment('No contours found — using bounding box approximation'))
    for (const line of generateBboxToolpath(op, pp)) lines.push(line)
    return lines
  }

  // Offset contours by tool radius
  const toolRadius = op.toolDiameter / 2
  const offsetDist = op.type === 'profile' ? toolRadius : -toolRadius
  const toolpaths = offsetContours(contours, offsetDist)

  lines.push(pp.rapidTo(undefined, undefined, safeZ))

  for (let pass = 1; pass <= zPasses; pass++) {
    const z = -Math.min(pass * stepdown, op.depth)
    lines.push(pp.comment(`Z pass ${pass}/${zPasses} — depth ${Math.abs(z).toFixed(3)} mm`))

    for (const path of toolpaths) {
      if (path.length < 2) continue

      const [startX, startY] = path[0]
      lines.push(pp.rapidTo(startX, startY, safeZ))
      lines.push(pp.linearTo(undefined, undefined, z, op.feedrate * 0.3))

      for (let i = 1; i < path.length; i++) {
        const [x, y] = path[i]
        lines.push(pp.linearTo(x, y, undefined, op.feedrate))
      }

      // Close the loop
      lines.push(pp.linearTo(startX, startY, undefined, op.feedrate))
      lines.push(pp.rapidTo(undefined, undefined, safeZ))
    }
  }

  return lines
}

function generateDrill(op, pp) {
  const lines = []
  const safeZ = 5.0
  // Placeholder: drill at origin — in future, pick hole centers from geometry
  lines.push(pp.comment('Drill cycle'))
  lines.push(pp.rapidTo(0, 0, safeZ))
  lines.push(pp.linearTo(undefined, undefined, -op.depth, op.feedrate * 0.5))
  lines.push(pp.rapidTo(undefined, undefined, safeZ))
  return lines
}

function generateBboxToolpath(op, pp) {
  // Fallback: simple rectangular path when no contour is available
  const lines = []
  const safeZ = 5.0
  const r = op.toolDiameter / 2
  const size = 25 // mm, rough placeholder
  const stepdown = Math.max(op.stepdown, 0.001)
  const zPasses = Math.ceil(op.depth / stepdown)

  lines.push(pp.rapidTo(-size - r, -size - r, safeZ))

  for (let pass = 1; pass <= zPasses; pass++) {
    const z = -Math.min(pass * stepdown, op.depth)
    lines.push(pp.linearTo(undefined, undefined, z, op.feedrate * 0.3))
    lines.push(pp.linearTo(size + r, -size - r, undefined, op.feedrate))
    lines.push(pp.linearTo(size + r, size + r, undefined, op.feedrate))
    lines.push(pp.linearTo(-size - r, size + r, undefined, op.feedrate))
    lines.push(pp.linearTo(-size - r, -size - r, undefined, op.feedrate))
    lines.push(pp.rapidTo(undefined, undefined, safeZ))
  }

  return lines
}
