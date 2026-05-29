// Slice an STL (ASCII or binary) at a given Z height and return 2D contour polygons

export function extractSliceContours(stlData, sliceZ = 0) {
  // stlData is an ArrayBuffer (may be ASCII STL encoded as UTF-8)
  const buffer = stlData instanceof ArrayBuffer ? stlData : stlData.buffer ?? stlData

  const firstBytes = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength))
  const magic = String.fromCharCode(...firstBytes)
  const isAscii = magic.startsWith('solid')

  const triangles = isAscii
    ? parseAsciiStl(buffer)
    : parseBinaryStl(buffer)

  const segments = []
  for (const [v1, v2, v3] of triangles) {
    const seg = intersectTriangleAtZ([v1, v2, v3], sliceZ)
    if (seg) segments.push(seg)
  }

  if (segments.length === 0) return []
  return chainSegments(segments)
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
