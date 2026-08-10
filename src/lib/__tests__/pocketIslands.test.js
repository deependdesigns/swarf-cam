import { describe, it, expect } from 'vitest'
import { generatePocketPasses, findIslandsForContour } from '../gcodeGenerator'
import { buildContourHierarchy } from '../stlSlicer'

function makeCircleApprox(cx, cy, r, n = 32) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  })
}

function makeSquare(x1, y1, x2, y2) {
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
}

describe('generatePocketPasses — island avoidance', () => {
  const pocket = makeSquare(0, 0, 40, 40)
  const islandCenter = [20, 20]
  const islandRadius = 8
  const island = makeCircleApprox(islandCenter[0], islandCenter[1], islandRadius)
  const toolRadius = 3
  const stepoverPct = 50

  it('keeps every path vertex at least toolRadius from the island boundary', () => {
    const paths = generatePocketPasses(pocket, toolRadius, stepoverPct, null, [island])
    expect(paths.length).toBeGreaterThan(0)
    const minAllowed = islandRadius + toolRadius - 0.5 // tolerance for polygon faceting
    for (const path of paths) {
      for (const [x, y] of path) {
        const d = Math.hypot(x - islandCenter[0], y - islandCenter[1])
        expect(d).toBeGreaterThanOrEqual(minAllowed)
      }
    }
  })

  it('still clears meaningful area around the island (not over-conservative)', () => {
    const paths = generatePocketPasses(pocket, toolRadius, stepoverPct, null, [island])
    expect(paths.length).toBeGreaterThan(3)
  })

  it('regression: closest ring hugs the island at ~toolRadius, not 2x toolRadius', () => {
    const paths = generatePocketPasses(pocket, toolRadius, stepoverPct, null, [island])
    let minStandoff = Infinity
    for (const path of paths) {
      for (const [x, y] of path) {
        const standoff = Math.hypot(x - islandCenter[0], y - islandCenter[1]) - islandRadius
        if (standoff < minStandoff) minStandoff = standoff
      }
    }
    // The naive (buggy) pre-subtract-then-loop approach would push this to ~2×toolRadius (6mm).
    // The corrected fixed-keepout-per-ring approach hugs the island at ~toolRadius (3mm).
    expect(minStandoff).toBeGreaterThanOrEqual(toolRadius - 0.5)
    expect(minStandoff).toBeLessThan(toolRadius + 1.5)
  })

  it('without islands, clears all the way to the pocket center as before', () => {
    const paths = generatePocketPasses(pocket, toolRadius, stepoverPct)
    expect(paths.length).toBeGreaterThan(0)
    const anyNearCenter = paths.some(path =>
      path.some(([x, y]) => Math.hypot(x - 20, y - 20) < toolRadius + 1))
    expect(anyNearCenter).toBe(true)
  })
})

describe('buildContourHierarchy / findIslandsForContour', () => {
  it('identifies a 3-level nesting: outer boundary → void → island → smaller void', () => {
    const outer = makeSquare(0, 0, 100, 100)   // depth 0, outer
    const void1 = makeSquare(10, 10, 90, 90)   // depth 1, void
    const island = makeSquare(20, 20, 80, 80)  // depth 2, outer (island)
    const void2 = makeSquare(30, 30, 70, 70)   // depth 3, void (hole inside the island)

    const contours = [outer, void1, island, void2]
    const hierarchy = buildContourHierarchy(contours)

    expect(hierarchy.isOuter).toEqual([true, false, true, false])
    expect(hierarchy.depth).toEqual([0, 1, 2, 3])
    expect(hierarchy.parent).toEqual([-1, 0, 1, 2])

    const islandsOfVoid1 = findIslandsForContour(hierarchy, contours, 1)
    expect(islandsOfVoid1).toHaveLength(1)
    expect(islandsOfVoid1[0]).toBe(island)

    // The void inside the island (void2) is not an island of void1 — it's a void, not solid.
    const islandsOfIsland = findIslandsForContour(hierarchy, contours, 2)
    expect(islandsOfIsland).toHaveLength(0)
  })

  it('classifyContours still matches buildContourHierarchy.isOuter (no regression)', async () => {
    const { classifyContours } = await import('../stlSlicer')
    const outer = makeSquare(0, 0, 20, 20)
    const inner = makeSquare(5, 5, 15, 15)
    const contours = [outer, inner]
    expect(classifyContours(contours)).toEqual(buildContourHierarchy(contours).isOuter)
  })
})
