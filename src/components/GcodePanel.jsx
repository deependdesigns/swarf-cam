import Editor from '@monaco-editor/react'
import { useAppState } from '../context/AppStateContext'
import { generateGcode, computeToolpathData } from '../lib/gcodeGenerator'

export default function GcodePanel() {
  const { gcode, setGcode, operations, stlData, postProcessor, setToolpathData } = useAppState()

  function handleGenerate() {
    if (!stlData) return
    setGcode(generateGcode(stlData, operations, postProcessor))
    setToolpathData(computeToolpathData(stlData, operations))
  }

  function handleDownload() {
    if (!gcode) return
    const blob = new Blob([gcode], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'swarf.nc'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col h-[280px] min-h-[200px]">
      <div className="flex items-center justify-between px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0">
        <span className="text-[#888] text-xs uppercase tracking-wider">G-code Output</span>
        <div className="flex gap-2">
          <button
            onClick={handleGenerate}
            disabled={!stlData}
            className="px-3 py-1 text-xs bg-[#1a3a1a] hover:bg-[#1e4a1e] border border-[#2a5a2a] text-[#7bff9b] rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ⚡ Generate
          </button>
          <button
            onClick={handleDownload}
            disabled={!gcode}
            className="px-3 py-1 text-xs bg-[#1a1a1a] hover:bg-[#252525] border border-[#333] text-[#aaa] rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ↓ Download
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          defaultLanguage="plaintext"
          value={gcode || '; G-code will appear here after generating\n; 1. Compile OpenSCAD code\n; 2. Configure operations\n; 3. Click Generate'}
          theme="vs-dark"
          options={{
            readOnly: true,
            fontSize: 12,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            minimap: { enabled: false },
            lineNumbers: 'off',
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
            renderLineHighlight: 'none',
          }}
        />
      </div>
    </div>
  )
}
