import { useEffect, useRef, useState, useCallback } from 'react'
import { useAppState } from '../context/AppStateContext'
import {
  initThreeScene, loadStlIntoScene, disposeScene,
  renderToolpaths, clearToolpaths, highlightOperation, updateWorkArea,
  renderRapidMoves, clearRapidMoves, setMeshOpacity,
  updateToolHead, positionToolHead, clearToolHead,
  clearStockMesh, buildStockMesh, fitCameraToStock,
} from '../lib/threeScene'
import { getPositionAtProgress, getMoveAtProgress } from '../lib/gcodeGenerator'
import { track } from '../lib/analytics'
import { parseGcode, simulateMilling } from '../lib/millingSimulator'

const SPEEDS = [0.5, 1, 2, 5, 10]
const GRID_RES = 512

export default function PreviewPanel() {
  const {
    stlData, toolpathData, showToolpaths, setShowToolpaths,
    selectedOperationId, machineSettings, globalToolSettings,
    showRapids, setShowRapids, modelTransparent, setModelTransparent,
    rapidPaths, moveSequence, gcode,
    simProgress, setSimProgress, progressJumpRequest,
  } = useAppState()

  const mountRef     = useRef(null)
  const sceneRef     = useRef(null)
  const moveSeqRef   = useRef(null)
  const progressRef  = useRef(0)
  const isPlayingRef = useRef(false)
  const playSpeedRef = useRef(1)
  const lastTimeRef  = useRef(null)
  const animRafRef   = useRef(null)

  const [isPlaying,   setIsPlaying]   = useState(false)
  const [playSpeed,   setPlaySpeed]   = useState(1)
  const [previewMode, setPreviewMode] = useState('render')  // 'render' | 'milling'
  const [simulating,  setSimulating]  = useState(false)
  const [heightmap,   setHeightmap]   = useState(null)

  useEffect(() => { moveSeqRef.current = moveSequence }, [moveSequence])

  // Handle jump requests from GcodePanel / OperationsPanel
  useEffect(() => {
    if (!progressJumpRequest) return
    // Subscribing to an external command object (bumped seq from GcodePanel/OperationsPanel)
    // and syncing local playback state in response — the documented effect+setState pattern.
    isPlayingRef.current = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsPlaying(false)
    cancelAnimationFrame(animRafRef.current)
    const p = Math.max(0, Math.min(1, progressJumpRequest.progress))
    progressRef.current = p
    setSimProgress(p)
    if (sceneRef.current && moveSeqRef.current) {
      const pos = getPositionAtProgress(moveSeqRef.current, p)
      if (pos) positionToolHead(sceneRef.current, pos)
    }
  }, [progressJumpRequest])

  // ── Init scene ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mountRef.current) return
    const scene = initThreeScene(mountRef.current)
    sceneRef.current = scene
    updateWorkArea(scene, machineSettings.workAreaX, machineSettings.workAreaY)
    return () => {
      cancelAnimationFrame(animRafRef.current)
      disposeScene(scene)
      sceneRef.current = null
    }
  }, [])

  // ── STL load ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current && stlData) loadStlIntoScene(sceneRef.current, stlData)
  }, [stlData])

  // ── STL visibility and opacity ───────────────────────────────────────────────
  // In milling mode: hidden by default; Ghost button shows the model as a reference overlay.
  // In render mode: opaque by default; Ghost button makes it transparent.
  useEffect(() => {
    if (!sceneRef.current?.mesh) return
    if (previewMode === 'milling') {
      sceneRef.current.mesh.visible = modelTransparent
      if (modelTransparent) setMeshOpacity(sceneRef.current, true)
    } else {
      sceneRef.current.mesh.visible = true
      setMeshOpacity(sceneRef.current, modelTransparent)
    }
  }, [previewMode, modelTransparent, stlData])

  // ── Toolpaths ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current) return
    if (showToolpaths && toolpathData) {
      renderToolpaths(sceneRef.current, toolpathData)
      highlightOperation(sceneRef.current, selectedOperationId)
    } else {
      clearToolpaths(sceneRef.current)
    }
  }, [toolpathData, showToolpaths, previewMode])

  // ── Highlight selected operation ─────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current) highlightOperation(sceneRef.current, selectedOperationId)
  }, [selectedOperationId])

  // ── Work area boundary ───────────────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current) updateWorkArea(sceneRef.current, machineSettings.workAreaX, machineSettings.workAreaY)
  }, [machineSettings.workAreaX, machineSettings.workAreaY])

  // ── Rapid moves ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current) return
    if (showRapids && rapidPaths) renderRapidMoves(sceneRef.current, rapidPaths)
    else clearRapidMoves(sceneRef.current)
  }, [rapidPaths, showRapids, previewMode])

  // ── Tool head ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current) return
    isPlayingRef.current = false
    setIsPlaying(false)
    cancelAnimationFrame(animRafRef.current)
    progressRef.current = 0
    setSimProgress(0)

    if (moveSequence?.moves?.length) {
      updateToolHead(sceneRef.current, globalToolSettings.toolDiameter)
      const startPos = moveSequence.moves[0]?.points[0]
      if (startPos) positionToolHead(sceneRef.current, startPos)
    } else {
      clearToolHead(sceneRef.current)
    }
  }, [moveSequence, previewMode])

  // ── Milling simulation ───────────────────────────────────────────────────────
  useEffect(() => {
    // Badge visibility is gated on previewMode too (see JSX below), so no state reset
    // is needed here when leaving milling mode.
    if (previewMode !== 'milling') return

    const matW = machineSettings.materialWidth  ?? 150
    const matL = machineSettings.materialLength ?? 150

    // Immediate "simulating" cue while the setTimeout-deferred work below runs — the actual
    // heightmap result lands asynchronously, so this can't be derived at render time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSimulating(true)
    const id = setTimeout(() => {
      const moves  = parseGcode(gcode)
      const result = simulateMilling(
        moves, matW, matL,
        machineSettings.materialThickness,
        machineSettings.zZeroMode,
        GRID_RES,
      )
      setHeightmap(result)
      setSimulating(false)
    }, 0)
    return () => clearTimeout(id)
  }, [
    previewMode, gcode,
    machineSettings.materialWidth,
    machineSettings.materialLength,
    machineSettings.materialThickness,
    machineSettings.zZeroMode,
  ])

  // ── Stock mesh ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current) return
    const matW = machineSettings.materialWidth  ?? 150
    const matL = machineSettings.materialLength ?? 150
    if (previewMode === 'milling' && heightmap) {
      buildStockMesh(sceneRef.current, heightmap, matW, matL, machineSettings.materialThickness, GRID_RES)
      fitCameraToStock(sceneRef.current, matW, matL, machineSettings.materialThickness)
    } else if (previewMode !== 'milling') {
      clearStockMesh(sceneRef.current)
    }
  }, [previewMode, heightmap, machineSettings.materialWidth, machineSettings.materialLength, machineSettings.materialThickness])

  // ── Animation loop ───────────────────────────────────────────────────────────
  // runAnimFrameRef holds the latest closure so the recursive rAF call below doesn't
  // self-reference the const being initialized (also plays nicer with the React Compiler).
  const runAnimFrameRef = useRef(null)
  const runAnimFrame = useCallback((timestamp) => {
    if (!isPlayingRef.current) { lastTimeRef.current = null; return }

    if (lastTimeRef.current !== null) {
      const delta    = (timestamp - lastTimeRef.current) / 1000
      const total    = moveSeqRef.current?.totalTime ?? 20
      const newProg  = Math.min(1, progressRef.current + (delta * playSpeedRef.current) / total)
      progressRef.current = newProg

      if (sceneRef.current && moveSeqRef.current) {
        const pos = getPositionAtProgress(moveSeqRef.current, newProg)
        if (pos) positionToolHead(sceneRef.current, pos)
      }
      setSimProgress(newProg)

      if (newProg >= 1) {
        isPlayingRef.current = false
        setIsPlaying(false)
        lastTimeRef.current = null
        return
      }
    }

    lastTimeRef.current = timestamp
    animRafRef.current = requestAnimationFrame(runAnimFrameRef.current)
  }, [])
  // runAnimFrame is referentially stable (deps: []), so this effect only ever runs once —
  // it's not a per-render sync, just the one-time handoff refs need instead of self-reference.
  useEffect(() => { runAnimFrameRef.current = runAnimFrame }, [runAnimFrame])

  function handlePlayPause() {
    const next = !isPlayingRef.current
    isPlayingRef.current = next
    setIsPlaying(next)
    if (next) {
      track.timelinePlayed()
      if (progressRef.current >= 1) { progressRef.current = 0; setSimProgress(0) }
      lastTimeRef.current = null
      animRafRef.current = requestAnimationFrame(runAnimFrame)
    }
  }

  function handleScrub(e) {
    const p = parseInt(e.target.value) / 10000
    progressRef.current = p
    setSimProgress(p)
    isPlayingRef.current = false
    setIsPlaying(false)
    if (sceneRef.current && moveSeqRef.current) {
      const pos = getPositionAtProgress(moveSeqRef.current, p)
      if (pos) positionToolHead(sceneRef.current, pos)
    }
  }

  function handleSpeed(speed) { playSpeedRef.current = speed; setPlaySpeed(speed); track.timelineSpeedChanged(speed) }

  const currentPos  = moveSequence ? getPositionAtProgress(moveSequence, simProgress) : null
  const currentMove = moveSequence ? getMoveAtProgress(moveSequence, simProgress) : null
  const moveTypeColor = { rapid: 'text-[#aa8800]', plunge: 'text-[#cc7700]', feed: 'text-[#3a9a4a]' }
  const inMillingMode = previewMode === 'milling'

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0 flex-wrap">

        {/* Mode tab switcher */}
        <div className="flex bg-[#111] border border-[#222] rounded overflow-hidden shrink-0">
          <button
            onClick={() => { setPreviewMode('render'); track.previewModeChanged('render') }}
            className={`px-3 py-1 text-xs transition-colors ${
              !inMillingMode
                ? 'bg-[#1a2a3a] text-[#6b9fff]'
                : 'text-[#555] hover:text-[#888]'
            }`}
          >
            3D Model
          </button>
          <div className="w-px bg-[#2a2a2a] self-stretch" />
          <button
            onClick={() => { setPreviewMode('milling'); track.previewModeChanged('milling') }}
            className={`px-3 py-1 text-xs transition-colors ${
              inMillingMode
                ? 'bg-[#2a1a0a] text-[#e8a840]'
                : 'text-[#555] hover:text-[#888]'
            }`}
          >
            Stock Sim
          </button>
        </div>

        {/* Overlay controls — available in both modes */}
        {toolpathData && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowToolpaths(v => !v)}
              className={`px-2 py-1 text-xs border rounded transition-colors ${
                showToolpaths
                  ? 'bg-[#0d2a1a] border-[#1a5a2a] text-[#69f0ae]'
                  : 'bg-[#1a1a1a] border-[#333] text-[#555]'
              }`}
            >
              Paths
            </button>
            <button
              onClick={() => setShowRapids(v => !v)}
              className={`px-2 py-1 text-xs border rounded transition-colors ${
                showRapids
                  ? 'bg-[#2a2000] border-[#554400] text-[#ddaa22]'
                  : 'bg-[#1a1a1a] border-[#333] text-[#555]'
              }`}
            >
              Rapids
            </button>
            <button
              onClick={() => setModelTransparent(v => !v)}
              title={inMillingMode ? 'Overlay reference model as ghost' : 'Toggle model transparency'}
              className={`px-2 py-1 text-xs border rounded transition-colors ${
                modelTransparent
                  ? 'bg-[#0d1a2a] border-[#1a3a5a] text-[#6b9fff]'
                  : 'bg-[#1a1a1a] border-[#333] text-[#555]'
              }`}
            >
              Ghost
            </button>
          </div>
        )}

        {simulating && inMillingMode && (
          <span className="text-[#e8a840] text-xs animate-pulse">Simulating…</span>
        )}

        <div className="flex items-center gap-3 text-[#444] text-xs ml-auto">
          <span>drag: rotate</span>
          <span>scroll: zoom</span>
          <span>shift+drag: pan</span>
        </div>
      </div>

      {/* ── 3D canvas ──────────────────────────────────────────────────────── */}
      <div className="flex-1 relative min-h-0">
        <div ref={mountRef} className="absolute inset-0" />

        {!inMillingMode && !stlData && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <div className="text-[#2a2a2a] text-6xl mb-4">⬡</div>
              <p className="text-[#444] text-sm">Compile OpenSCAD to preview model</p>
            </div>
          </div>
        )}

        {inMillingMode && !gcode && !simulating && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="text-[#555] text-sm">Generate G-code to simulate material removal</p>
              <p className="text-[#333] text-xs mt-1">Set material dimensions in the Setup tab</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Timeline — visible in both modes once G-code is generated ──────── */}
      {moveSequence && (
        <div className="shrink-0 px-3 pt-2 pb-2.5 bg-[#0e0e0e] border-t border-[#2a2a2a] space-y-1.5">
          <div className="flex items-center gap-2">
            <button
              onClick={handlePlayPause}
              className="w-6 h-6 flex items-center justify-center bg-[#1a1a1a] border border-[#333] rounded text-[#888] hover:text-[#c8c8c8] hover:border-[#555] transition-colors text-xs shrink-0"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            <input
              type="range"
              min={0} max={10000}
              value={Math.round(simProgress * 10000)}
              onChange={handleScrub}
              className="flex-1 accent-[#6b9fff] cursor-pointer"
              style={{ height: '4px' }}
            />

            <div className="flex gap-0.5 shrink-0">
              {SPEEDS.map(s => (
                <button
                  key={s}
                  onClick={() => handleSpeed(s)}
                  className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                    playSpeed === s
                      ? 'bg-[#6b9fff] text-black font-medium'
                      : 'bg-[#1a1a1a] border border-[#2a2a2a] text-[#555] hover:text-[#888]'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 font-mono text-[10px]">
            {currentPos ? (
              <>
                <span className="text-[#555]">X<span className="text-[#888] ml-0.5">{currentPos[0].toFixed(2)}</span></span>
                <span className="text-[#555]">Y<span className="text-[#888] ml-0.5">{currentPos[1].toFixed(2)}</span></span>
                <span className="text-[#555]">Z<span className="text-[#888] ml-0.5">{currentPos[2].toFixed(2)}</span></span>
                {currentMove && (
                  <span className={`uppercase tracking-wider ${moveTypeColor[currentMove.type] ?? 'text-[#666]'}`}>
                    {currentMove.type}
                    {currentMove.feedrate != null && currentMove.type !== 'rapid'
                      ? ` · ${Math.round(currentMove.feedrate)} mm/min`
                      : ''}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[#333]">Scrub or play to simulate toolpath</span>
            )}
            <span className="ml-auto text-[#333]">{Math.round(simProgress * 100)}%</span>
          </div>
        </div>
      )}

    </div>
  )
}
