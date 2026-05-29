import { useState, useCallback, useEffect } from 'react'
import { AppStateContext } from './context/AppStateContext'
import Header from './components/Header'
import CodeEditorPanel from './components/CodeEditorPanel'
import GcodePanel from './components/GcodePanel'
import PreviewPanel from './components/PreviewPanel'
import RightPanel from './components/RightPanel'
import { detectFeatures } from './lib/gcodeGenerator'

const DEFAULT_SCAD = `// Swarf.cam — OpenSCAD example
// Edit this code and click Compile to preview

difference() {
  cube([50, 50, 10], center = true);
  cylinder(h = 12, r = 8, center = true, $fn = 64);
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

  useEffect(() => {
    localStorage.setItem('swarf-machine', JSON.stringify(machineSettings))
  }, [machineSettings])

  useEffect(() => {
    localStorage.setItem('swarf-tool', JSON.stringify(globalToolSettings))
  }, [globalToolSettings])

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
          <div className="flex flex-col w-[420px] min-w-[320px] border-r border-[#2a2a2a]">
            <CodeEditorPanel />
            <GcodePanel />
          </div>
          <div className="flex-1 min-w-0 border-r border-[#2a2a2a]">
            <PreviewPanel />
          </div>
          <div className="w-[300px] min-w-[260px]">
            <RightPanel />
          </div>
        </div>
      </div>
    </AppStateContext.Provider>
  )
}
