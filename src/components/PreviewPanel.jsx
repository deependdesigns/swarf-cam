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
import { parseGcode, simulateMilling } from '../lib/millingSimulator'

const SPEEDS = [0.5, 1, 2, 5, 10]
const GRID_RES = 256

export default function PreviewPanel() {
  const {
    stlData, toolpathData, showToolpaths, setShowToolpaths,
    selectedOperationId, machineSettings, globalToolSettings,
    showRapids, setShowRapids, modelTransparent, setModelTransparent,
    rapidPaths, moveSequence, gcode,
  } = useAppState()

  const mountRef  = useRef(null)
  const sceneRef  = useRef(null)
  const moveSeqRef   = useRef(null)
  const progressRef  = useRef(0)
  const isPlayingRef = useRef(false)
  const playSpeedRef = useRef(1)
  const lastTimeRef  = useRef(null)
  const animRafRef   = useRef(null)

  const [simProgress,  setSimProgress]  = useState(0)
  const [isPlaying,    setIsPlaying]    = useState(false)
  const [playSpeed,    setPlaySpeed]    = useState(1)
  const [previewMode,  setPreviewMode]  = useState('render')  // 'render' | 'milling'
  const [simulating,   setSimulating]   = useState(false)
  const [heightmap,    setHeightmap]    = useState(null)

  useEffect(() => { moveSeqRef.current = moveSequence }, [moveSequence])

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

  // ── STL load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current && stlData) {
      loadStlIntoScene(sceneRef.current, stlData)
      // Hide immediately if in milling mode
      if (previewMode === 'milling' && sceneRef.current.mesh) {
        sceneRef.current.mesh.visible = false
      }
    }
  }, [stlData])

  // ── STL visibility based on preview mode ────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current?.mesh) return
    sceneRef.current.mesh.visible = previewMode !== 'milling'
  }, [previewMode])

  // ── Toolpaths ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current) return
    if (previewMode === 'milling') {
      clearToolpaths(sceneRef.current)
      return
    }
    if (showToolpaths && toolpathData) {
      renderToolpaths(sceneRef.current, toolpathData)
      highlightOperation(sceneRef.current, selectedOperationId)
    } else {
      clearToolpaths(sceneRef.current)
    }
  }, [toolpathData, showToolpaths, previewMode])

  // ── Highlight operation ─────────────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current && previewMode !== 'milling') {
      highlightOperation(sceneRef.current, selectedOperationId)
    }
  }, [selectedOperationId])

  // ── Work area ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current) {
      updateWorkArea(sceneRef.current, machineSettings.workAreaX, machineSettings.workAreaY)
    }
  }, [machineSettings.workAreaX, machineSettings.workAreaY])

  // ── Rapid moves ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current) return
    if (previewMode === 'milling') { clearRapidMoves(sceneRef.current); return }
    if (showRapids && rapidPaths) renderRapidMoves(sceneRef.current, rapidPaths)
    else clearRapidMoves(sceneRef.current)
  }, [rapidPaths, showRapids, previewMode])

  // ── Model transparency ──────────────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current && previewMode !== 'milling') {
      setMeshOpacity(sceneRef.current, modelTransparent)
    }
  }, [modelTransparent, stlData, previewMode])

  // ── Move sequence / tool head ───────────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current) return
    isPlayingRef.current = false
    setIsPlaying(false)
    cancelAnimationFrame(animRafRef.current)
    progressRef.current = 0
    setSimProgress(0)

    if (previewMode === 'milling') {
      clearToolHead(sceneRef.current)
      return
    }

    if (moveSequence?.moves?.length) {
      updateToolHead(sceneRef.current, globalToolSettings.toolDiameter)
      const startPos = moveSequence.moves[0]?.points[0]
      if (startPos) positionToolHead(sceneRef.current, startPos)
    } else {
      clearToolHead(sceneRef.current)
    }
  }, [moveSequence, previewMode])

  // ── Milling simulation ──────────────────────────────────────────────────────
  // Runs whenever the user is in milling mode and relevant inputs change.
  useEffect(() => {
    if (previewMode !== 'milling') {
      setSimulating(false)
      return
    }

    setSimulating(true)
    const id = setTimeout(() => {
      const moves  = parseGcode(gcode)
      const result = simulateMilling(
        moves,
        machineSettings.workAreaX,
        machineSettings.workAreaY,
        machineSettings.materialThickness,
        machineSettings.zZeroMode,
        GRID_RES,
      )
      setHeightmap(result)
      setSimulating(false)
    }, 0)
    return () => clearTimeout(id)
  }, [
    previewMode,
    gcode,
    machineSettings.workAreaX,
    machineSettings.workAreaY,
    machineSettings.materialThickness,
    machineSettings.zZeroMode,
  ])

  // ── Stock mesh rendering ────────────────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current) return
    if (previewMode === 'milling' && heightmap) {
      buildStockMesh(
        sceneRef.current,
        heightmap,
        machineSettings.workAreaX,
        machineSettings.workAreaY,
        machineSettings.materialThickness,
        GRID_RES,
      )
      fitCameraToStock(sceneRef.current, machineSettings.workAreaX, machineSettings.workAreaY, machineSettings.materialThickness)
    } else if (previewMode !== 'milling') {
      clearStockMesh(sceneRef.current)
    }
  }, [previewMode, heightmap, machineSettings.workAreaX, machineSettings.workAreaY, machineSettings.materialThickness])

  // ── Animation loop ──────────────────────────────────────────────────────────
  const runAnimFrame = useCallback((timestamp) => {
    if (!isPlayingRef.current) { lastTimeRef.current = null; return }

    if (lastTimeRef.current !== null) {
      const delta     = (timestamp - lastTimeRef.current) / 1000
      const totalTime = moveSeqRef.current?.totalTime ?? 20
      const newProg   = Math.min(1, progressRef.current + (delta * playSpeedRef.current) / totalTime)
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
    animRafRef.current = requestAnimationFrame(runAnimFrame)
  }, [])

  function handlePlayPause() {
    const next = !isPlayingRef.current
    isPlayingRef.current = next
    setIsPlaying(next)
    if (next) {
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

  function handleSpeed(speed) {
    playSpeedRef.current = speed
    setPlaySpeed(speed)
  }

  function handleModeToggle() {
    setPreviewMode(m => m === 'render' ? 'milling' : 'render')
  }

  const currentPos  = moveSequence ? getPositionAtProgress(moveSequence, simProgress) : null
  const currentMove = moveSequence ? getMoveAtProgress(moveSequence, simProgress) : null

  const moveTypeColor = {
    rapid: 'text-[#aa8800]',
    plunge: 'text-[#cc7700]',
    feed: 'text-[#3a9a4a]',
  }

  const inMillingMode = previewMode === 'milling'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0">
        <span className="text-[#888] text-xs uppercase tracking-wider">
          {inMillingMode ? 'Stock Simulation' : '3D Preview'}
        </span>
        <div className="flex items-center gap-2">

          {/* Mode toggle */}
          <button
            onClick={handleModeToggle}
            className={`px-2 py-1 text-xs border rounded transition-colors ${
              inMillingMode
                ? 'bg-[#2a1a0a] border-[#5a3a10] text-[#e8a840]'
                : 'bg-[#1a1a1a] border-[#333] text-[#555]'
            }`}
            title={inMillingMode ? 'Switch to OpenSCAD render view' : 'Switch to stock simulation view'}
          >
            Stock Sim
          </button>

          {/* OpenSCAD Render controls — hidden in milling mode */}
          {!inMillingMode && toolpathData && (
            <>
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
                className={`px-2 py-1 text-xs border rounded transition-colors ${
                  modelTransparent
                    ? 'bg-[#0d1a2a] border-[#1a3a5a] text-[#6b9fff]'
                    : 'bg-[#1a1a1a] border-[#333] text-[#555]'
                }`}
              >
                Ghost
              </button>
            </>
          )}

          {/* Simulating indicator */}
          {inMillingMode && simulating && (
            <span className="text-[#e8a840] text-xs animate-pulse">Simulating…</span>
          )}

          <div className="flex items-center gap-3 text-[#444] text-xs ml-1">
            <span>drag: rotate</span>
            <span>scroll: zoom</span>
            <span>shift+drag: pan</span>
          </div>
        </div>
      </div>

      {/* 3D canvas */}
      <div className="flex-1 relative min-h-0">
        <div ref={mountRef} className="absolute inset-0" />

        {/* OpenSCAD render mode: no-model placeholder */}
        {!inMillingMode && !stlData && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <div className="text-[#2a2a2a] text-6xl mb-4">⬡</div>
              <p className="text-[#444] text-sm">Compile OpenSCAD to preview model</p>
            </div>
          </div>
        )}

        {/* Milling mode: no-gcode placeholder */}
        {inMillingMode && !gcode && !simulating && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="text-[#555] text-sm">Generate G-code to simulate material removal</p>
              <p className="text-[#333] text-xs mt-1">Stock dimensions come from the Setup tab</p>
            </div>
          </div>
        )}
      </div>

      {/* Timeline — only in render mode after Generate */}
      {!inMillingMode && moveSequence && (
        <div className="shrink-0 px-3 pt-2 pb-2.5 bg-[#0e0e0e] border-t border-[#2a2a2a] space-y-1.5">
          {/* Controls row */}
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
              min={0}
              max={10000}
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

          {/* Position / move info row */}
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
