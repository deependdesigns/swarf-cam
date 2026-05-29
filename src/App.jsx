import { useState, useCallback } from 'react'
import { AppStateContext } from './context/AppStateContext'
import Header from './components/Header'
import CodeEditorPanel from './components/CodeEditorPanel'
import PreviewPanel from './components/PreviewPanel'
import OperationsPanel from './components/OperationsPanel'
import GcodePanel from './components/GcodePanel'

const DEFAULT_SCAD = `// Swarf.cam — OpenSCAD example
// Edit this code and click Compile to preview

difference() {
  cube([50, 50, 10], center = true);
  cylinder(h = 12, r = 8, center = true, $fn = 64);
}
`

const DEFAULT_OPERATION = {
  id: 1,
  type: 'profile',
  label: 'Profile Cut',
  toolDiameter: 3.175,
  feedrate: 1000,
  spindleSpeed: 18000,
  stepdown: 1.0,
  depth: 10.0,
  passes: 1,
  direction: 'climb',
}

export default function App() {
  const [scadCode, setScadCode] = useState(DEFAULT_SCAD)
  const [stlData, setStlData] = useState(null)
  const [compiling, setCompiling] = useState(false)
  const [compileError, setCompileError] = useState(null)
  const [operations, setOperations] = useState([DEFAULT_OPERATION])
  const [gcode, setGcode] = useState('')
  const [postProcessor, setPostProcessor] = useState('grbl')

  const handleStlReady = useCallback((data) => {
    setStlData(data)
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
    }}>
      <div className="flex flex-col h-full bg-[#0d0d0d]">
        <Header />
        <div className="flex flex-1 overflow-hidden">
          {/* Left column: Code Editor + G-code Output */}
          <div className="flex flex-col w-[420px] min-w-[320px] border-r border-[#2a2a2a]">
            <CodeEditorPanel />
            <GcodePanel />
          </div>

          {/* Center: 3D Preview */}
          <div className="flex-1 min-w-0 border-r border-[#2a2a2a]">
            <PreviewPanel />
          </div>

          {/* Right: Operations */}
          <div className="w-[300px] min-w-[260px]">
            <OperationsPanel />
          </div>
        </div>
      </div>
    </AppStateContext.Provider>
  )
}
