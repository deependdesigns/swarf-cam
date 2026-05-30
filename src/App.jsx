import { useState, useCallback, useEffect, useRef } from 'react'
import { AppStateContext } from './context/AppStateContext'
import Header from './components/Header'
import CodeEditorPanel from './components/CodeEditorPanel'
import GcodePanel from './components/GcodePanel'
import PreviewPanel from './components/PreviewPanel'
import RightPanel from './components/RightPanel'
import { detectFeatures } from './lib/gcodeGenerator'

const DEFAULT_SCAD = `// Jig Depth
jigDepth = 90;
// Jig Thickness
jigHeight = 12.8;
// Vertical Fudge Factor
verticalFudge = .2;
// Distance between miter slot and blade
miterOffsetXval = 104.7;
// Miter Width
miterWidth = 12;
// Miter Height
miterHeight = 8;
// Miter Depth Fudge Factor
miterCutoutDepthFudge = 4;
// Miter Bolt Head Diameter
miterBoltHeadDm = 9.5;
// Miter Bolt Head Cutout
miterBoltHeadHeight = 5.5;
// Miter Bolt Thread Diameter
miterBoltThreadDm = 5.2;
// Miter Bolt Vertical Offset
miterBoltOffsetYval = 7;
// Gap Between Miter Bar and Jig Body
miterBarOffset = 4;
// Fence Bolt Horizontal Offset
fenceBoltOffsetXval = 4;
// Fence Bolt Verticle Offset
fenceBoltOffsetYval = 18;
// Fence Bolt Head DIameter
fenceBoltHeadDm = 10;
// Fence Bolt Head Cutout
fenceBoltHeadHeight = 9.5;
// Fence Bolt Thread Diameter
fenceBoltThreadDm = 5.4;
// Work Offset
workOffset = [ 0, 0, 0 ];
jigWidth = miterOffsetXval + miterWidth + fenceBoltHeadDm + ( fenceBoltOffsetXval * 2 );
fenceBoltOffsetXvalReal = fenceBoltOffsetXval + ( fenceBoltHeadDm / 2 );
fenceBoltOffsetX = [ fenceBoltOffsetXvalReal , jigWidth / 2, jigWidth - fenceBoltOffsetXvalReal  ];
fenceBoltOffsetYvalReal = fenceBoltOffsetYval + ( fenceBoltHeadDm /2 );
fenceBoltOffsetY = jigDepth - fenceBoltOffsetYvalReal;
fenceBoltHeadOffsetZ = jigHeight - fenceBoltHeadHeight;
miterBoltOffsetYvalReal = miterBoltOffsetYval + ( miterBoltHeadDm / 2 );
miterBoltOffsetY = [ miterBoltOffsetYvalReal, jigDepth / 2, jigDepth - miterBoltOffsetYvalReal ];
miterCutoutDepth = jigDepth + miterCutoutDepthFudge;
miterCutoutHeight = jigHeight - miterHeight;
miterCutoutOffsetZ = jigHeight - miterCutoutHeight;
miterCutoutCenter = miterOffsetXval + ( miterWidth / 2 );
miterBoltHeadOffsetZ = jigHeight - miterBoltHeadHeight;
miterBarX = jigWidth + miterBarOffset;
miterBarCenter = miterBarX + ( miterWidth / 2 );

translate(workOffset)
difference() {

    // Jig Body
    cube([ jigWidth, jigDepth, jigHeight ]);

    // Fence Bolt Head Cutouts
    for (x = fenceBoltOffsetX)
    translate([ x, fenceBoltOffsetY, fenceBoltHeadOffsetZ ])
    cylinder( d = fenceBoltHeadDm, h = fenceBoltHeadHeight + verticalFudge, $fn= 30 );

    // Fence Bolt Thread Cutouts
    for (x = fenceBoltOffsetX)
    translate([ x, fenceBoltOffsetY, -verticalFudge / 2 ])
    cylinder( d = fenceBoltThreadDm, h = jigHeight + verticalFudge, $fn= 30 );

    // Miter Bar Cutout
    translate([ miterOffsetXval, -miterCutoutDepthFudge / 2, miterCutoutOffsetZ ])
    cube([ miterWidth, miterCutoutDepth, miterCutoutHeight + verticalFudge / 2 ]);

    // Miter Bar Cutout Bolt Thread Cutouts
    for (y = miterBoltOffsetY)
    translate([ miterCutoutCenter, y, -verticalFudge / 2 ])
    cylinder( d = miterBoltThreadDm, h = jigHeight + verticalFudge, $fn= 30 );

}

translate(workOffset)
difference() {

    // Miter Bar
    translate([ miterBarX, 0, 0 ])
    cube( [ miterWidth, jigDepth, jigHeight ]);

    // Miter Bar Bolt Head Cutouts
    for (y = miterBoltOffsetY)
    translate([ miterBarCenter, y, miterBoltHeadOffsetZ ])
    rotate( 90)
    cylinder( d = miterBoltHeadDm, h = miterBoltHeadHeight + verticalFudge / 2, $fn= 6 );

    // Miter Bar Bolt Thread Cutouts
    for (y = miterBoltOffsetY)
    translate([ miterBarCenter, y, -verticalFudge / 2 ])
    cylinder( d = miterBoltThreadDm, h = jigHeight + verticalFudge, $fn= 30 );

}
`

const DEFAULT_MACHINE = {
  safetyHeight: 5,
  originSafetyHeight: 10,
  workAreaX: 300,
  workAreaY: 300,
  zZeroMode: 'top',
  materialThickness: 10,
}

const DEFAULT_TOOL = {
  toolDiameter: 3.175,
  feedrate: 1000,
  spindleSpeed: 18000,
  stepdown: 1.0,
  stepover: 85,
  direction: 'climb',
}

function loadStorage(key, defaults) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults }
  } catch {
    return { ...defaults }
  }
}

export default function App() {
  const [scadCode, setScadCode] = useState(DEFAULT_SCAD)
  const [stlData, setStlData] = useState(null)
  const [compiling, setCompiling] = useState(false)
  const [compileError, setCompileError] = useState(null)
  const [operations, setOperations] = useState([])
  const [gcode, setGcode] = useState('')
  const [postProcessor, setPostProcessor] = useState('grbl')
  const [toolpathData, setToolpathData] = useState(null)
  const [showToolpaths, setShowToolpaths] = useState(true)
  const [selectedOperationId, setSelectedOperationId] = useState(null)
  const [machineSettings, setMachineSettings] = useState(() => loadStorage('swarf-machine', DEFAULT_MACHINE))
  const [globalToolSettings, setGlobalToolSettings] = useState(() => loadStorage('swarf-tool', DEFAULT_TOOL))
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [gcodeHeight, setGcodeHeight] = useState(280)
  const isResizing = useRef(false)
  const resizeStart = useRef({ y: 0, h: 0 })

  useEffect(() => {
    localStorage.setItem('swarf-machine', JSON.stringify(machineSettings))
  }, [machineSettings])

  useEffect(() => {
    localStorage.setItem('swarf-tool', JSON.stringify(globalToolSettings))
  }, [globalToolSettings])

  useEffect(() => {
    function onMove(e) {
      if (!isResizing.current) return
      const dy = resizeStart.current.y - e.clientY
      setGcodeHeight(h => Math.max(80, Math.min(600, resizeStart.current.h + dy)))
    }
    function onUp() { isResizing.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  function startResize(e) {
    isResizing.current = true
    resizeStart.current = { y: e.clientY, h: gcodeHeight }
    e.preventDefault()
  }

  const handleStlReady = useCallback((data) => {
    setStlData(data)
    if (data) {
      const detected = detectFeatures(data)
      setOperations(detected)
      setSelectedOperationId(detected[0]?.id ?? null)
    }
  }, [])

  return (
    <AppStateContext.Provider value={{
      scadCode, setScadCode,
      stlData, setStlData: handleStlReady,
      compiling, setCompiling,
      compileError, setCompileError,
      operations, setOperations,
      gcode, setGcode,
      postProcessor, setPostProcessor,
      toolpathData, setToolpathData,
      showToolpaths, setShowToolpaths,
      selectedOperationId, setSelectedOperationId,
      machineSettings, setMachineSettings,
      globalToolSettings, setGlobalToolSettings,
    }}>
      <div className="flex flex-col h-full bg-[#0d0d0d]">
        <Header />
        <div className="flex flex-1 overflow-hidden">

          {/* Left panel — collapsible */}
          {leftCollapsed ? (
            <div className="flex flex-col items-center w-8 shrink-0 border-r border-[#2a2a2a] bg-[#0d0d0d] pt-2 gap-3">
              <button onClick={() => setLeftCollapsed(false)} className="text-[#444] hover:text-[#888] transition-colors" title="Expand editor">▶</button>
              <span className="text-[#2a2a2a] text-[10px] uppercase tracking-widest select-none" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>Editor</span>
            </div>
          ) : (
            <div className="flex flex-col w-[420px] min-w-[320px] shrink-0 border-r border-[#2a2a2a]">
              <CodeEditorPanel onCollapse={() => setLeftCollapsed(true)} />
              {/* G-code resize handle */}
              <div
                className="h-[5px] shrink-0 cursor-ns-resize bg-[#111] hover:bg-[#6b9fff] transition-colors border-y border-[#2a2a2a] group"
                onMouseDown={startResize}
                title="Drag to resize G-code panel"
              />
              <div style={{ height: gcodeHeight }} className="shrink-0">
                <GcodePanel />
              </div>
            </div>
          )}

          {/* Center — 3D preview */}
          <div className="flex-1 min-w-0 border-r border-[#2a2a2a]">
            <PreviewPanel />
          </div>

          {/* Right panel — collapsible */}
          {rightCollapsed ? (
            <div className="flex flex-col items-center w-8 shrink-0 border-l border-[#2a2a2a] bg-[#0d0d0d] pt-2 gap-3">
              <button onClick={() => setRightCollapsed(false)} className="text-[#444] hover:text-[#888] transition-colors" title="Expand panel">◀</button>
              <span className="text-[#2a2a2a] text-[10px] uppercase tracking-widest select-none" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>Setup</span>
            </div>
          ) : (
            <div className="w-[300px] min-w-[260px] shrink-0">
              <RightPanel onCollapse={() => setRightCollapsed(true)} />
            </div>
          )}

        </div>
      </div>
    </AppStateContext.Provider>
  )
}
