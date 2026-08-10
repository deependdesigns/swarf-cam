// Slice an STL (ASCII or binary) at a given Z height and return 2D contour polygons
import { unionContours } from './toolpathOffsets'

export function getStlMinXY(stlData) {
  const buffer = stlData instanceof ArrayBuffer ? stlData : stlData.buffer ?? stlData
  const firstBytes = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength))
  const isAscii = String.fromCharCode(...firstBytes).startsWith('solid')
  const triangles = isAscii ? parseAsciiStl(buffer) : parseBinaryStl(buffer)
  let minX = Infinity, minY = Infinity
  for (const [v1, v2, v3] of triangles) {
    if (v1[0] < minX) minX = v1[0]; if (v2[0] < minX) minX = v2[0]; if (v3[0] < minX) minX = v3[0]
    if (v1[1] < minY) minY = v1[1]; if (v2[1] < minY) minY = v2[1]; if (v3[1] < minY) minY = v3[1]
  }
  return { minX: isFinite(minX) ? minX : 0, minY: isFinite(minY) ? minY : 0 }
}

export function getStlTopZ(stlData) {
  const buffer = stlData instanceof ArrayBuffer ? stlData : stlData.buffer ?? stlData
  const firstBytes = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength))
  const isAscii = String.fromCharCode(...firstBytes).startsWith('solid')
  const triangles = isAscii ? parseAsciiStl(buffer) : parseBinaryStl(buffer)
  let maxZ = -Infinity
  for (const [v1, v2, v3] of triangles) {
    if (v1[2] > maxZ) maxZ = v1[2]
    if (v2[2] > maxZ) maxZ = v2[2]
    if (v3[2] > maxZ) maxZ = v3[2]
  }
  return isFinite(maxZ) ? maxZ : 0
}

// For each contour from a top-surface slice, return the auto-detected depth (mm from top)
// by finding upward-facing floor triangles and matching them to their innermost contour.
// sliceZ: only consider floor triangles below this level (defaults to all below topZ).
// This prevents floor triangles from slots or pockets above the detection slice from
// contaminating the depth calculation for a bore found at a lower scan level.
export function getFeatureDepths(stlData, topZ, contours, sliceZ = Infinity) {
  const buffer = stlData instanceof ArrayBuffer ? stlData : stlData.buffer ?? stlData
  const firstBytes = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength))
  const isAscii = String.fromCharCode(...firstBytes).startsWith('solid')
  const triangles = isAscii ? parseAsciiStl(buffer) : parseBinaryStl(buffer)

  const EPS = 0.01
  // Collect upward-facing horizontal triangles below the top surface (pocket floors).
  // Only include triangles strictly below sliceZ so that floors from features above
  // the detection slice (e.g. a slot floor at z=20 when scanning for a bore at z=19.95)
  // do not override the bore's actual floor.
  const floorTris = []
  for (const [v1, v2, v3] of triangles) {
    const z = v1[2]
    if (Math.abs(v2[2] - z) > EPS || Math.abs(v3[2] - z) > EPS) continue
    if (z >= topZ - EPS) continue
    if (z >= sliceZ - EPS) continue
    // Cross product Z component gives normal direction; positive = upward
    const nz = (v2[0]-v1[0])*(v3[1]-v1[1]) - (v2[1]-v1[1])*(v3[0]-v1[0])
    if (nz <= 0) continue
    floorTris.push({ z, verts: [[v1[0],v1[1]], [v2[0],v2[1]], [v3[0],v3[1]]] })
  }

  // Process contours smallest-first so each floor tri is assigned to its innermost match
  const sortedIdx = contours
    .map((c, i) => ({ i, area: polygonArea(c) }))
    .sort((a, b) => a.area - b.area)
    .map(x => x.i)

  const floorZPerContour = new Float64Array(contours.length) // 0 = no floor found
  for (const tri of floorTris) {
    for (const ci of sortedIdx) {
      const c = contours[ci]
      if (
        pointInPolygon(tri.verts[0][0], tri.verts[0][1], c) &&
        pointInPolygon(tri.verts[1][0], tri.verts[1][1], c) &&
        pointInPolygon(tri.verts[2][0], tri.verts[2][1], c)
      ) {
        if (tri.z > floorZPerContour[ci]) floorZPerContour[ci] = tri.z
        break
      }
    }
  }

  return contours.map((_, i) =>
    floorZPerContour[i] > EPS ? topZ - floorZPerContour[i] : topZ
  )
}

// Return all unique Z values of upward-facing horizontal triangles (pocket floors)
export function getFloorZLevels(stlData, topZ) {
  const buffer = stlData instanceof ArrayBuffer ? stlData : stlData.buffer ?? stlData
  const firstBytes = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength))
  const isAscii = String.fromCharCode(...firstBytes).startsWith('solid')
  const triangles = isAscii ? parseAsciiStl(buffer) : parseBinaryStl(buffer)
  const EPS = 0.01
  const zSet = new Set()
  for (const [v1, v2, v3] of triangles) {
    const z = v1[2]
    if (Math.abs(v2[2] - z) > EPS || Math.abs(v3[2] - z) > EPS) continue
    if (z >= topZ - EPS || z < EPS) continue
    const nz = (v2[0]-v1[0])*(v3[1]-v1[1]) - (v2[1]-v1[1])*(v3[0]-v1[0])
    if (nz <= 0) continue
    zSet.add(Math.round(z * 10) / 10)
  }
  return [...zSet].sort((a, b) => b - a)
}

// Find depth of highest upward-facing floor triangle within an XY bounding region
export function getRegionFloorDepth(stlData, topZ, xMin, xMax, yMin, yMax) {
  const buffer = stlData instanceof ArrayBuffer ? stlData : stlData.buffer ?? stlData
  const firstBytes = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength))
  const isAscii = String.fromCharCode(...firstBytes).startsWith('solid')
  const triangles = isAscii ? parseAsciiStl(buffer) : parseBinaryStl(buffer)
  const EPS = 0.01
  let maxFloorZ = 0
  for (const [v1, v2, v3] of triangles) {
    const z = v1[2]
    if (Math.abs(v2[2] - z) > EPS || Math.abs(v3[2] - z) > EPS) continue
    if (z >= topZ - EPS || z < EPS) continue
    const nz = (v2[0]-v1[0])*(v3[1]-v1[1]) - (v2[1]-v1[1])*(v3[0]-v1[0])
    if (nz <= 0) continue
    const cx = (v1[0] + v2[0] + v3[0]) / 3
    const cy = (v1[1] + v2[1] + v3[1]) / 3
    if (cx >= xMin - EPS && cx <= xMax + EPS && cy >= yMin - EPS && cy <= yMax + EPS) {
      if (z > maxFloorZ) maxFloorZ = z
    }
  }
  return maxFloorZ > EPS ? topZ - maxFloorZ : topZ
}

export function polygonArea(polygon) {
  let area = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j][0] + polygon[i][0]) * (polygon[j][1] - polygon[i][1])
  }
  return Math.abs(area / 2)
}

export function polygonCentroid(polygon) {
  let x = 0, y = 0
  for (const [px, py] of polygon) { x += px; y += py }
  return [x / polygon.length, y / polygon.length]
}

function normalizeBuffer(stlData) {
  return stlData instanceof ArrayBuffer ? stlData : stlData.buffer ?? stlData
}

function parseBuffer(buffer) {
  const firstBytes = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength))
  return String.fromCharCode(...firstBytes).startsWith('solid')
    ? parseAsciiStl(buffer)
    : parseBinaryStl(buffer)
}

function contoursFromTriangles(triangles, sliceZ) {
  const segments = []
  for (const [v1, v2, v3] of triangles) {
    const seg = intersectTriangleAtZ([v1, v2, v3], sliceZ)
    if (seg) segments.push(seg)
  }
  if (segments.length === 0) return []
  return chainSegments(segments)
}

export function extractSliceContours(stlData, sliceZ = 0) {
  const buffer = normalizeBuffer(stlData)
  return contoursFromTriangles(parseBuffer(buffer), sliceZ)
}

function parseAsciiStl(buffer) {
  const text = new TextDecoder().decode(buffer)
  const triangles = []
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g
  let match
  const verts = []

  while ((match = vertexRe.exec(text)) !== null) {
    verts.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])])
    if (verts.length === 3) {
      triangles.push([verts[0], verts[1], verts[2]])
      verts.length = 0
    }
  }

  return triangles
}

function parseBinaryStl(buffer) {
  const view = new DataView(buffer)
  const triCount = view.getUint32(80, true)
  const triangles = []

  for (let i = 0; i < triCount; i++) {
    const off = 84 + i * 50
    triangles.push([
      [view.getFloat32(off + 12, true), view.getFloat32(off + 16, true), view.getFloat32(off + 20, true)],
      [view.getFloat32(off + 24, true), view.getFloat32(off + 28, true), view.getFloat32(off + 32, true)],
      [view.getFloat32(off + 36, true), view.getFloat32(off + 40, true), view.getFloat32(off + 44, true)],
    ])
  }

  return triangles
}

function intersectTriangleAtZ(verts, z) {
  const pts = []
  const edges = [[verts[0], verts[1]], [verts[1], verts[2]], [verts[2], verts[0]]]

  for (const [a, b] of edges) {
    if ((a[2] <= z && b[2] >= z) || (b[2] <= z && a[2] >= z)) {
      const dz = b[2] - a[2]
      if (Math.abs(dz) < 1e-9) continue
      const t = (z - a[2]) / dz
      pts.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
    }
  }

  return pts.length === 2 ? pts : null
}

function chainSegments(segments) {
  const used = new Uint8Array(segments.length)
  const polys = []
  const EPS = 1e-4

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue
    used[start] = 1

    const poly = [segments[start][0], segments[start][1]]
    let found = true

    while (found) {
      found = false
      const tail = poly[poly.length - 1]
      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue
        const [a, b] = segments[j]
        if (dist2(tail, a) < EPS) { poly.push(b); used[j] = 1; found = true; break }
        if (dist2(tail, b) < EPS) { poly.push(a); used[j] = 1; found = true; break }
      }
    }

    if (poly.length >= 3) polys.push(poly)
  }

  return polys
}

function dist2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

export function pointInPolygon(px, py, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

export function getStlBounds(stlData) {
  const buffer = normalizeBuffer(stlData)
  const triangles = parseBuffer(buffer)
  let xMin=Infinity, xMax=-Infinity, yMin=Infinity, yMax=-Infinity
  for (const [v1,v2,v3] of triangles) {
    for (const v of [v1,v2,v3]) {
      if (v[0]<xMin) xMin=v[0]; if (v[0]>xMax) xMax=v[0]
      if (v[1]<yMin) yMin=v[1]; if (v[1]>yMax) yMax=v[1]
    }
  }
  return { xMin, xMax, yMin, yMax }
}

// Classify contours by nesting depth (even-odd rule) and immediate-parent relationship.
// Returns { isOuter, depth, parent }:
//   isOuter[i] — true means solid boundary (outer), false means void (hole to machine).
//   depth[i]   — nesting depth (how many other contours contain it).
//   parent[i]  — index of the tightest (smallest-area) contour that contains it, or -1.
// Moved here from gcodeGenerator so sliceAllLayers can use it without a circular import.
export function buildContourHierarchy(contours) {
  const n = contours.length
  const depth = new Array(n).fill(0)
  const parent = new Array(n).fill(-1)
  const parentArea = new Array(n).fill(Infinity)
  const areas = contours.map(polygonArea)

  for (let i = 0; i < n; i++) {
    const [px, py] = contours[i][0]
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      let inside = false
      const poly = contours[j]
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xi, yi] = poly[a], [xj, yj] = poly[b]
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
          inside = !inside
      }
      if (inside) {
        depth[i]++
        if (areas[j] < parentArea[i]) { parentArea[i] = areas[j]; parent[i] = j }
      }
    }
  }

  return { isOuter: depth.map(d => d % 2 === 0), depth, parent }
}

// Classify contours by nesting depth (even-odd rule).
// Returns isOuter[] — true means solid boundary (outer), false means void (hole to machine).
export function classifyContours(contours) {
  return buildContourHierarchy(contours).isOuter
}

// Slice the STL at every zStep from just below the top surface down to Z≈0.
// At each level, returns the union of all void (inner) contours at that depth.
// stockBounds (optional) can restrict the Z range: { zMin, zMax }.
export function sliceAllLayers(stlArrayBuffer, zStep = 0.5, stockBounds = null) {
  const buffer = normalizeBuffer(stlArrayBuffer)
  const triangles = parseBuffer(buffer)

  let topZ = -Infinity
  for (const [v1, v2, v3] of triangles) {
    if (v1[2] > topZ) topZ = v1[2]
    if (v2[2] > topZ) topZ = v2[2]
    if (v3[2] > topZ) topZ = v3[2]
  }
  if (!isFinite(topZ) || topZ <= 0) return []

  const zBottom = stockBounds?.zMin ?? 0
  const zTop = stockBounds?.zMax ?? topZ

  const layers = []
  for (let z = zTop - zStep / 2; z > zBottom; z -= zStep) {
    const sliceZ = Math.max(z, zBottom + 0.01)
    const contours = contoursFromTriangles(triangles, sliceZ)
    if (contours.length === 0) {
      layers.push({ z: sliceZ, voidContours: [] })
      continue
    }
    const isOuter = classifyContours(contours)
    const voids = contours.filter((_, i) => !isOuter[i])
    layers.push({ z: sliceZ, voidContours: voids.length > 1 ? unionContours(voids) : voids })
  }

  return layers
}
