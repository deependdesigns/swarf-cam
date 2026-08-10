import { describe, it, expect } from 'vitest'
import { sliceAllLayers, classifyContours, polygonArea } from '../stlSlicer'

// ── Binary STL builder ────────────────────────────────────────────────────────

function makeBinaryStl(triangles) {
  const buf = new ArrayBuffer(84 + triangles.length * 50)
  const view = new DataView(buf)
  view.setUint32(80, triangles.length, true)
  for (let i = 0; i < triangles.length; i++) {
    const [v1, v2, v3] = triangles[i]
    const off = 84 + i * 50
    // normal (unused by slicer)
    view.setFloat32(off,     0, true); view.setFloat32(off + 4,  0, true); view.setFloat32(off + 8,  0, true)
    // v1
    view.setFloat32(off + 12, v1[0], true); view.setFloat32(off + 16, v1[1], true); view.setFloat32(off + 20, v1[2], true)
    // v2
    view.setFloat32(off + 24, v2[0], true); view.setFloat32(off + 28, v2[1], true); view.setFloat32(off + 32, v2[2], true)
    // v3
    view.setFloat32(off + 36, v3[0], true); view.setFloat32(off + 40, v3[1], true); view.setFloat32(off + 44, v3[2], true)
    view.setUint16(off + 48, 0, true)
  }
  return buf
}

// Triangulate a closed box [x1,x2] × [y1,y2] × [z1,z2] — 12 triangles, all outward-facing
function boxTriangles(x1, x2, y1, y2, z1, z2) {
  return [
    // -Z face
    [[x1,y1,z1],[x2,y2,z1],[x2,y1,z1]], [[x1,y1,z1],[x1,y2,z1],[x2,y2,z1]],
    // +Z face
    [[x1,y1,z2],[x2,y1,z2],[x2,y2,z2]], [[x1,y1,z2],[x2,y2,z2],[x1,y2,z2]],
    // -Y face
    [[x1,y1,z1],[x2,y1,z1],[x2,y1,z2]], [[x1,y1,z1],[x2,y1,z2],[x1,y1,z2]],
    // +Y face
    [[x1,y2,z1],[x2,y2,z2],[x2,y2,z1]], [[x1,y2,z1],[x1,y2,z2],[x2,y2,z2]],
    // -X face
    [[x1,y1,z1],[x1,y1,z2],[x1,y2,z2]], [[x1,y1,z1],[x1,y2,z2],[x1,y2,z1]],
    // +X face
    [[x2,y1,z1],[x2,y2,z2],[x2,y1,z2]], [[x2,y1,z1],[x2,y2,z1],[x2,y2,z2]],
  ]
}

// ── classifyContours (sanity check before testing sliceAllLayers) ─────────────

describe('classifyContours', () => {
  it('treats a single ring as outer', () => {
    const ring = [[0,0],[10,0],[10,10],[0,10]]
    expect(classifyContours([ring])).toEqual([true])
  })

  it('treats a ring inside another as inner', () => {
    const outer = [[0,0],[20,0],[20,20],[0,20]]
    const inner = [[5,5],[15,5],[15,15],[5,15]]
    const result = classifyContours([outer, inner])
    expect(result[0]).toBe(true)   // outer
    expect(result[1]).toBe(false)  // inner (void)
  })
})

// ── sliceAllLayers ────────────────────────────────────────────────────────────

describe('sliceAllLayers — solid box (no voids)', () => {
  const stl = makeBinaryStl(boxTriangles(0, 30, 0, 30, 0, 30))

  it('returns one layer per zStep', () => {
    const layers = sliceAllLayers(stl, 5)
    // topZ=30, zStep=5 → first slice at 30-2.5=27.5, then 22.5, 17.5, 12.5, 7.5, 2.5 → 6 layers
    expect(layers.length).toBe(6)
  })

  it('produces empty voidContours for every layer (solid box has no holes)', () => {
    const layers = sliceAllLayers(stl, 5)
    for (const layer of layers) {
      expect(layer.voidContours).toHaveLength(0)
    }
  })

  it('layers are ordered top-down (decreasing z)', () => {
    const layers = sliceAllLayers(stl, 5)
    for (let i = 1; i < layers.length; i++) {
      expect(layers[i].z).toBeLessThan(layers[i - 1].z)
    }
  })

  it('respects stockBounds zMax', () => {
    const layers = sliceAllLayers(stl, 5, { zMax: 20, zMin: 0 })
    // First slice at 20-2.5=17.5, then 12.5, 7.5, 2.5 → 4 layers
    expect(layers.length).toBe(4)
    expect(layers[0].z).toBeCloseTo(17.5)
  })
})

describe('sliceAllLayers — box with a rectangular through-hole', () => {
  // Model: outer box [0,30]×[0,30]×[0,30]
  //        minus inner column [10,20]×[10,20]×[0,30] (open top and bottom → through-hole)
  //
  // STL faces of the resulting solid (box minus column):
  //   Outer box faces (minus the column footprint on top/bottom)
  //   Inner column walls (4 vertical faces of the hole)
  //   The top/bottom faces are the annular ring: outer box minus inner square
  //
  // For slicing purposes we only need the vertical inner walls — those are what
  // produce the closed inner contour at any mid-Z slice.

  function columnWallTriangles(x1, x2, y1, y2, z1, z2) {
    // Inward-facing walls of the column (reversed winding vs boxTriangles)
    return [
      // -Y inner wall (faces +Y = inward)
      [[x1,y1,z1],[x1,y1,z2],[x2,y1,z2]], [[x1,y1,z1],[x2,y1,z2],[x2,y1,z1]],
      // +Y inner wall
      [[x1,y2,z1],[x2,y2,z2],[x1,y2,z2]], [[x1,y2,z1],[x2,y2,z1],[x2,y2,z2]],
      // -X inner wall
      [[x1,y1,z1],[x1,y2,z1],[x1,y2,z2]], [[x1,y1,z1],[x1,y2,z2],[x1,y1,z2]],
      // +X inner wall
      [[x2,y1,z1],[x2,y1,z2],[x2,y2,z2]], [[x2,y1,z1],[x2,y2,z2],[x2,y2,z1]],
    ]
  }

  // annular top/bottom faces: outer box minus inner square
  function annularFace(z, outerX1, outerX2, outerY1, outerY2, holeX1, holeX2, holeY1, holeY2, faceUp) {
    // Split annulus into 4 rectangular strips around the hole
    // winding: faceUp → CCW when viewed from above (right-hand normal = +Z for top, -Z for bottom)
    const tris = []
    // Left strip: x=[outerX1,holeX1], y=[outerY1,outerY2]
    tris.push(...faceTriangles(outerX1, holeX1, outerY1, outerY2, z, faceUp))
    // Right strip
    tris.push(...faceTriangles(holeX2, outerX2, outerY1, outerY2, z, faceUp))
    // Bottom strip (between left and right)
    tris.push(...faceTriangles(holeX1, holeX2, outerY1, holeY1, z, faceUp))
    // Top strip
    tris.push(...faceTriangles(holeX1, holeX2, holeY2, outerY2, z, faceUp))
    return tris
  }

  function faceTriangles(x1, x2, y1, y2, z, faceUp) {
    if (faceUp) {
      return [
        [[x1,y1,z],[x2,y2,z],[x2,y1,z]], [[x1,y1,z],[x1,y2,z],[x2,y2,z]],
      ]
    } else {
      return [
        [[x1,y1,z],[x2,y1,z],[x2,y2,z]], [[x1,y1,z],[x2,y2,z],[x1,y2,z]],
      ]
    }
  }

  // Outer box side faces (excluding the hole regions on top/bottom, but side faces are full-height)
  const outerSides = [
    // -Y side
    [[0,0,0],[30,0,0],[30,0,30]], [[0,0,0],[30,0,30],[0,0,30]],
    // +Y side
    [[0,30,0],[30,30,30],[30,30,0]], [[0,30,0],[0,30,30],[30,30,30]],
    // -X side
    [[0,0,0],[0,0,30],[0,30,30]], [[0,0,0],[0,30,30],[0,30,0]],
    // +X side
    [[30,0,0],[30,30,30],[30,0,30]], [[30,0,0],[30,30,0],[30,30,30]],
  ]

  const allTris = [
    ...outerSides,
    ...columnWallTriangles(10, 20, 10, 20, 0, 30),
    ...annularFace(0,  0, 30, 0, 30, 10, 20, 10, 20, false),
    ...annularFace(30, 0, 30, 0, 30, 10, 20, 10, 20, true),
  ]

  const stl = makeBinaryStl(allTris)

  it('produces one void contour (the square hole) at mid-height', () => {
    const layers = sliceAllLayers(stl, 5)
    // Every layer should have exactly one void contour (the 10×10 square hole)
    for (const layer of layers) {
      expect(layer.voidContours).toHaveLength(1)
    }
  })

  it('void contour has approximately the correct area (10×10 = 100 mm²)', () => {
    const layers = sliceAllLayers(stl, 5)
    for (const layer of layers) {
      const area = polygonArea(layer.voidContours[0])
      // Allow ±5% for floating point and discretisation
      expect(area).toBeGreaterThan(90)
      expect(area).toBeLessThan(110)
    }
  })

  it('followed by trackFeaturesAcrossLayers yields one track', async () => {
    const { trackFeaturesAcrossLayers } = await import('../gcodeGenerator')
    const layers = sliceAllLayers(stl, 5)
    const tracks = trackFeaturesAcrossLayers(layers)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].zTop).toBeGreaterThan(tracks[0].zBottom)
  })
})

describe('sliceAllLayers — two stacked rectangular pockets (stepped bore analogue)', () => {
  // Model: solid box [0,30]×[0,30]×[0,30]
  //   Wide pocket [5,25]×[5,25]×[15,30]  (top half)
  //   Narrow pocket [10,20]×[10,20]×[0,15] (bottom half)
  // Encoded only as inner wall triangles for the slicer to detect at mid-Z levels.

  function innerWalls(x1, x2, y1, y2, z1, z2) {
    return [
      [[x1,y1,z1],[x1,y1,z2],[x2,y1,z2]], [[x1,y1,z1],[x2,y1,z2],[x2,y1,z1]],
      [[x1,y2,z1],[x2,y2,z2],[x1,y2,z2]], [[x1,y2,z1],[x2,y2,z1],[x2,y2,z2]],
      [[x1,y1,z1],[x1,y2,z1],[x1,y2,z2]], [[x1,y1,z1],[x1,y2,z2],[x1,y1,z2]],
      [[x2,y1,z1],[x2,y1,z2],[x2,y2,z2]], [[x2,y1,z1],[x2,y2,z2],[x2,y2,z1]],
    ]
  }

  // outer box sides
  const sides = [
    [[0,0,0],[30,0,30],[30,0,0]],  [[0,0,0],[0,0,30],[30,0,30]],
    [[0,30,0],[30,30,0],[30,30,30]],[[0,30,0],[30,30,30],[0,30,30]],
    [[0,0,0],[0,30,0],[0,30,30]],  [[0,0,0],[0,30,30],[0,0,30]],
    [[30,0,0],[30,0,30],[30,30,30]],[[30,0,0],[30,30,30],[30,30,0]],
  ]
  // floors
  const wideFloor  = [[[5,5,15],[25,25,15],[25,5,15]], [[5,5,15],[5,25,15],[25,25,15]]]
  const narrowFloor= [[[10,10,0],[20,20,0],[20,10,0]], [[10,10,0],[10,20,0],[20,20,0]]]

  const allTris = [
    ...sides,
    ...innerWalls(5, 25, 5, 25, 15, 30),
    ...innerWalls(10, 20, 10, 20, 0, 15),
    ...wideFloor, ...narrowFloor,
  ]

  const stl = makeBinaryStl(allTris)

  it('layers in top half [15,30] see the wide void', () => {
    const layers = sliceAllLayers(stl, 2)
    const topLayers = layers.filter(l => l.z > 15 && l.voidContours.length > 0)
    expect(topLayers.length).toBeGreaterThan(0)
    for (const l of topLayers) {
      const area = polygonArea(l.voidContours[0])
      // Wide pocket 20×20=400 mm²
      expect(area).toBeGreaterThan(360)
      expect(area).toBeLessThan(440)
    }
  })

  it('layers in bottom half [0,15] see only the narrow void', () => {
    const layers = sliceAllLayers(stl, 2)
    const botLayers = layers.filter(l => l.z < 15 && l.voidContours.length > 0)
    expect(botLayers.length).toBeGreaterThan(0)
    for (const l of botLayers) {
      const area = polygonArea(l.voidContours[0])
      // Narrow pocket 10×10=100 mm²
      expect(area).toBeGreaterThan(80)
      expect(area).toBeLessThan(120)
    }
  })

  it('trackFeaturesAcrossLayers produces two distinct tracks (tier split at the step)', async () => {
    const { trackFeaturesAcrossLayers } = await import('../gcodeGenerator')
    const layers = sliceAllLayers(stl, 2)
    const tracks = trackFeaturesAcrossLayers(layers.filter(l => l.voidContours.length > 0))
    expect(tracks).toHaveLength(2)
    const [wide, narrow] = tracks.sort((a, b) => b.zTop - a.zTop)
    expect(wide.zTop).toBeGreaterThan(15)
    expect(narrow.zTop).toBeLessThanOrEqual(15)
  })
})
