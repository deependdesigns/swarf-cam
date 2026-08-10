import { describe, it, expect } from 'vitest'
import { trackFeaturesAcrossLayers } from '../gcodeGenerator'

// Simple polygon factories — not realistic geometry, just enough for centroid/area checks
function makeRect(x1, y1, x2, y2) {
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
}
function makeCircleApprox(cx, cy, r, n = 16) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  })
}

function makeLayer(z, ...polygons) {
  return { z, voidContours: polygons }
}

describe('trackFeaturesAcrossLayers', () => {
  it('returns empty array for empty input', () => {
    expect(trackFeaturesAcrossLayers([])).toEqual([])
  })

  it('returns one track for a single layer', () => {
    const rect = makeRect(5, 5, 25, 15)
    const stack = [makeLayer(29.75, rect)]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].zTop).toBeCloseTo(29.75)
    expect(tracks[0].zBottom).toBeCloseTo(29.75)
  })

  it('groups identical-topology layers into one track', () => {
    const c = makeCircleApprox(15, 15, 5)
    const stack = [
      makeLayer(29.75, c),
      makeLayer(29.25, c),
      makeLayer(28.75, c),
    ]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].zTop).toBeCloseTo(29.75)
    expect(tracks[0].zBottom).toBeCloseTo(28.75)
  })

  it('tier-splits when the same-XY feature changes diameter (counterbore → bore)', () => {
    const c1 = makeCircleApprox(15, 15, 10)  // large circle (counterbore level)
    const c2 = makeCircleApprox(15, 15, 5)   // small circle (bore level)
    const stack = [
      makeLayer(19.75, c1),
      makeLayer(19.25, c1),
      makeLayer(14.75, c2),  // same XY, area changes > 5% → new tier
      makeLayer(14.25, c2),
    ]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(2)
    const [wide, narrow] = tracks.sort((a, b) => b.zTop - a.zTop)
    expect(wide.zTop).toBeCloseTo(19.75)
    expect(wide.zBottom).toBeCloseTo(19.25)
    expect(narrow.zTop).toBeCloseTo(14.75)
    expect(narrow.zBottom).toBeCloseTo(14.25)
  })

  it('closes one feature independently while a separate feature (different XY) continues', () => {
    const slot = makeRect(5, 30, 35, 40)         // separate feature, disappears partway down
    const bore = makeCircleApprox(20, 15, 10)    // separate feature (different centroid), persists
    const bore2 = makeCircleApprox(20, 15, 5)    // bore tier-splits later

    const stack = [
      makeLayer(24.75, slot, bore),
      makeLayer(24.25, slot, bore),
      makeLayer(17.5, bore),         // slot gone; bore continues on its own
      makeLayer(17.0, bore),
      makeLayer(10.0, bore2),        // bore tier-splits into the smaller bore2
    ]
    const tracks = trackFeaturesAcrossLayers(stack)
    // slot: 1 track (24.75→24.25); bore: 1 track (24.75→17.0); bore2: 1 track (10.0→10.0)
    expect(tracks).toHaveLength(3)
    const slotTrack = tracks.find(t => Math.abs(t.zTop - 24.75) < 0.01 && Math.abs(polygonAreaApprox(t) - 300) < 1)
    expect(slotTrack.zBottom).toBeCloseTo(24.25)
    const boreTrack = tracks.find(t => Math.abs(t.zTop - 24.75) < 0.01 && Math.abs(polygonAreaApprox(t) - 300) >= 1)
    expect(boreTrack.zBottom).toBeCloseTo(17.0)
    const bore2Track = tracks.find(t => Math.abs(t.zTop - 10.0) < 0.01)
    expect(bore2Track.zBottom).toBeCloseTo(10.0)
  })

  it('tracks a feature through a merge (crossed by another void) and demerge unaffected', () => {
    // A pocket that a slot crosses over partway down, then the slot ends and the pocket
    // continues alone — the pocket's own track must span the whole stack unaffected, matching
    // what the deleted parentClosed safeguard was (imperfectly) trying to protect.
    const pocket = makeCircleApprox(20, 15, 5)                 // area ≈ 78.5
    const merged = makeRect(0, 0, 100, 100)                    // big blob containing (20,15)

    const stack = [
      makeLayer(20.0, pocket),
      makeLayer(19.5, pocket),
      makeLayer(15.0, merged),   // slot crosses the pocket here — pocket's own contour vanishes
      makeLayer(14.5, merged),
      makeLayer(10.0, pocket),   // slot ends — pocket demerges, resumes on its own
      makeLayer(9.5, pocket),
    ]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].zTop).toBeCloseTo(20.0)
    expect(tracks[0].zBottom).toBeCloseTo(9.5)
  })

  it('bridges a single-layer gap (slicing noise) without closing the track', () => {
    const c = makeCircleApprox(15, 15, 5)
    const stack = [
      makeLayer(20.0, c),
      makeLayer(19.5),          // no contours this layer — transient noise
      makeLayer(19.0, c),
    ]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].zTop).toBeCloseTo(20.0)
    expect(tracks[0].zBottom).toBeCloseTo(19.0)
  })

  it('closes a track after more than one consecutive missed layer', () => {
    const c = makeCircleApprox(15, 15, 5)
    const stack = [
      makeLayer(20.0, c),
      makeLayer(19.5),
      makeLayer(19.0),          // two consecutive misses — track should close, not bridge
      makeLayer(18.5, c),       // this is a genuinely new track
    ]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(2)
    expect(tracks[0].zTop).toBeCloseTo(20.0)
    expect(tracks[0].zBottom).toBeCloseTo(20.0)
    expect(tracks[1].zTop).toBeCloseTo(18.5)
  })

  it('creates a new track when centroid shifts beyond tolerance', () => {
    const near = makeCircleApprox(15, 15, 5)
    const far = makeCircleApprox(18, 18, 5)  // centroid offset > 2mm

    const stack = [makeLayer(10, near), makeLayer(9.5, far)]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(2)
  })

  it('keeps one track when centroid drift is within tolerance', () => {
    const a = makeCircleApprox(15.0, 15.0, 5)
    const b = makeCircleApprox(15.5, 15.5, 5)  // 0.7mm drift — within 2mm tolerance

    const stack = [makeLayer(10, a), makeLayer(9.5, b)]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(1)
  })

  it('tier-splits when area changes by more than 5%', () => {
    const small = makeCircleApprox(15, 15, 5)     // area ≈ π·25 ≈ 78.5
    const large = makeCircleApprox(15, 15, 5.5)   // area ≈ π·30.25 ≈ 95 — ~21% larger

    const stack = [makeLayer(10, small), makeLayer(9.5, large)]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(2)
  })

  it('keeps one track when area change is within 5%', () => {
    const a = makeCircleApprox(15, 15, 5, 32)
    const b = makeCircleApprox(15, 15, 5, 16)  // fewer segments → slightly different area, same radius

    const stack = [makeLayer(10, a), makeLayer(9.5, b)]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(1)
  })

  it('produces no track for layers with no void contours', () => {
    const c = makeCircleApprox(15, 15, 5)
    const stack = [
      makeLayer(29.75),          // no voids (solid top face)
      makeLayer(24.75, c),
    ]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].zTop).toBeCloseTo(24.75)
  })

  it('produces correct zTop/zBottom for a multi-layer track', () => {
    const c = makeCircleApprox(15, 15, 5)
    const stack = [
      makeLayer(29.75, c),
      makeLayer(29.25, c),
      makeLayer(28.75, c),
      makeLayer(28.25, c),
      makeLayer(27.75, c),
    ]
    const [t] = trackFeaturesAcrossLayers(stack)
    expect(t.zTop).toBeCloseTo(29.75)
    expect(t.zBottom).toBeCloseTo(27.75)
  })

  it('tracks duplicated same-size holes independently even when Clipper returns them in a different order per layer', () => {
    // Regression: three identical-area holes (e.g. duplicated bolt holes) tie under a
    // sort-by-area comparison, so a naive rank-based zip can pair up unrelated holes across
    // layers. unionContours()/Clipper does not guarantee stable path order across independent
    // calls, so simulate that by shuffling order per layer.
    const holeA = makeCircleApprox(125.7, 67.0, 5)
    const holeB = makeCircleApprox(67.3, 67.0, 5)
    const holeC = makeCircleApprox(9.0, 67.0, 5)

    const stack = [
      makeLayer(12.55, holeA, holeB, holeC),
      makeLayer(12.05, holeC, holeA, holeB),  // same 3 holes, different order
      makeLayer(11.55, holeB, holeC, holeA),  // same 3 holes, yet another order
    ]
    const tracks = trackFeaturesAcrossLayers(stack)
    expect(tracks).toHaveLength(3)
    for (const t of tracks) {
      expect(t.zTop).toBeCloseTo(12.55)
      expect(t.zBottom).toBeCloseTo(11.55)
    }
  })

  it('regression: an unrelated feature changing shape does not fragment a different, unchanged feature', () => {
    // Reproduces the reported bug: a hex-head-style bolt (shape/area change at some Z) sits far
    // away in XY from a plain constant-diameter hole. The unrelated transition must not affect
    // the constant hole's own track.
    const steadyHole = makeCircleApprox(125.7, 67.0, 5)      // never changes
    const steppedWide = makeCircleApprox(9.0, 67.0, 6)       // area ≈ 113
    const steppedNarrow = makeCircleApprox(9.0, 67.0, 2.6)   // area ≈ 21 — >5% smaller, new tier

    const stack = [
      makeLayer(10.0, steadyHole, steppedWide),
      makeLayer(9.5, steadyHole, steppedWide),
      makeLayer(9.0, steadyHole, steppedNarrow),   // steppedWide → steppedNarrow tier-splits
      makeLayer(8.5, steadyHole, steppedNarrow),
    ]
    const tracks = trackFeaturesAcrossLayers(stack)

    const steadyTracks = tracks.filter(t => Math.hypot(t.centroid[0] - 125.7, t.centroid[1] - 67.0) < 1)
    expect(steadyTracks).toHaveLength(1)
    expect(steadyTracks[0].zTop).toBeCloseTo(10.0)
    expect(steadyTracks[0].zBottom).toBeCloseTo(8.5)

    const steppedTracks = tracks.filter(t => Math.hypot(t.centroid[0] - 9.0, t.centroid[1] - 67.0) < 1)
    expect(steppedTracks).toHaveLength(2)
  })
})

function polygonAreaApprox(track) {
  const c = track.contour
  let area = 0
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    area += (c[j][0] + c[i][0]) * (c[j][1] - c[i][1])
  }
  return Math.abs(area / 2)
}
