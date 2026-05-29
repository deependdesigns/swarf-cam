import { useEffect, useRef } from 'react'
import { useAppState } from '../context/AppStateContext'
import {
  initThreeScene, loadStlIntoScene, disposeScene,
  renderToolpaths, clearToolpaths, highlightOperation, updateWorkArea,
} from '../lib/threeScene'

export default function PreviewPanel() {
  const {
    stlData, toolpathData, showToolpaths, setShowToolpaths,
    selectedOperationId, machineSettings,
  } = useAppState()
  const mountRef = useRef(null)
  const sceneRef = useRef(null)

  useEffect(() => {
    if (!mountRef.current) return
    const scene = initThreeScene(mountRef.current)
    sceneRef.current = scene
    updateWorkArea(scene, machineSettings.workAreaX, machineSettings.workAreaY)
    return () => {
      disposeScene(scene)
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    if (sceneRef.current && stlData) {
      loadStlIntoScene(sceneRef.current, stlData)
    }
  }, [stlData])

  useEffect(() => {
    if (!sceneRef.current) return
    if (showToolpaths && toolpathData) {
      renderToolpaths(sceneRef.current, toolpathData)
      // Apply current selection immediately after render
      highlightOperation(sceneRef.current, selectedOperationId)
    } else {
      clearToolpaths(sceneRef.current)
    }
  }, [toolpathData, showToolpaths])

  // Highlight changes without re-rendering all paths
  useEffect(() => {
    if (sceneRef.current) {
      highlightOperation(sceneRef.current, selectedOperationId)
    }
  }, [selectedOperationId])

  useEffect(() => {
    if (sceneRef.current) {
      updateWorkArea(sceneRef.current, machineSettings.workAreaX, machineSettings.workAreaY)
    }
  }, [machineSettings.workAreaX, machineSettings.workAreaY])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0">
        <span className="text-[#888] text-xs uppercase tracking-wider">3D Preview</span>
        <div className="flex items-center gap-3">
          {toolpathData && (
            <button
              onClick={() => setShowToolpaths(v => !v)}
              className={`px-2 py-1 text-xs border rounded transition-colors ${
                showToolpaths
                  ? 'bg-[#0d2a1a] border-[#1a5a2a] text-[#69f0ae]'
                  : 'bg-[#1a1a1a] border-[#333] text-[#555]'
              }`}
            >
              {showToolpaths ? '⬡ Paths' : '⬡ Paths'}
            </button>
          )}
          <div className="flex items-center gap-3 text-[#444] text-xs">
            <span>drag: rotate</span>
            <span>scroll: zoom</span>
            <span>shift+drag: pan</span>
          </div>
        </div>
      </div>
      <div className="flex-1 relative min-h-0">
        <div ref={mountRef} className="absolute inset-0" />
        {!stlData && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <div className="text-[#2a2a2a] text-6xl mb-4">⬡</div>
              <p className="text-[#444] text-sm">Compile OpenSCAD to preview model</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
