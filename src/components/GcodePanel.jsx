import { useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import { useAppState } from '../context/AppStateContext'

const STATUS_CONFIG = {
  generating: { icon: '⚙️', text: 'Generating…', cls: 'text-[#888]' },
  done:       { icon: '✅', text: 'Up to date',   cls: 'text-[#7bff9b]' },
  error:      { icon: '❌', text: null,            cls: 'text-[#ff6b6b]' },
}

export default function GcodePanel() {
  const { gcode, gcodeStatus, gcodeError, simProgress, gcodeLineMap, jumpToProgress } = useAppState()

  const editorRef      = useRef(null)
  const monacoRef      = useRef(null)
  const decorationsRef = useRef([])
  const gcodeLineMapRef = useRef(null)
  const suppressScrollRef = useRef(false)

  // Keep a ref to the latest gcodeLineMap so the stable onMouseDown closure can read it
  useEffect(() => { gcodeLineMapRef.current = gcodeLineMap }, [gcodeLineMap])

  // Clear decorations when gcode is replaced
  useEffect(() => {
    if (editorRef.current) {
      decorationsRef.current = editorRef.current.deltaDecorations(decorationsRef.current, [])
    }
  }, [gcode])

  // Highlight the current line whenever simProgress or the line map changes
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !gcodeLineMap?.progressToLine?.length) return

    const { progressToLine } = gcodeLineMap

    // Binary search: find last entry whose progress ≤ simProgress
    let lo = 0, hi = progressToLine.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (progressToLine[mid].progress <= simProgress) lo = mid
      else hi = mid - 1
    }
    const lineNumber = progressToLine[lo].lineIndex + 1  // Monaco is 1-indexed

    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [{
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      options: { isWholeLine: true, className: 'gcode-current-line' },
    }])

    if (!suppressScrollRef.current) {
      editor.revealLineInCenter(lineNumber)
    }
    suppressScrollRef.current = false
  }, [simProgress, gcodeLineMap])

  function handleEditorMount(editor, monaco) {
    editorRef.current = editor
    monacoRef.current = monaco

    editor.onMouseDown(e => {
      const lineNumber = e.target.position?.lineNumber
      if (!lineNumber || !gcodeLineMapRef.current) return
      const { progressToLine, linesToProgress } = gcodeLineMapRef.current
      const lineIndex = lineNumber - 1

      suppressScrollRef.current = true

      // Exact match on a motion line
      if (linesToProgress.has(lineIndex)) {
        jumpToProgress(linesToProgress.get(lineIndex))
        return
      }
      // Find the nearest motion line at or before the clicked line
      for (let i = progressToLine.length - 1; i >= 0; i--) {
        if (progressToLine[i].lineIndex <= lineIndex) {
          jumpToProgress(progressToLine[i].progress)
          return
        }
      }
      // Before all motion lines: jump to start
      if (progressToLine.length) jumpToProgress(progressToLine[0].progress)
    })
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

  const status = STATUS_CONFIG[gcodeStatus]

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0">
        <span className="text-[#888] text-xs uppercase tracking-wider">G-code Output</span>
        <div className="flex items-center gap-3">
          {status && (
            <span
              className={`text-xs flex items-center gap-1 ${status.cls}`}
              title={gcodeStatus === 'error' ? gcodeError : undefined}
            >
              <span>{status.icon}</span>
              <span className="max-w-[180px] truncate">
                {gcodeStatus === 'error' ? gcodeError : status.text}
              </span>
            </span>
          )}
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
          value={gcode || '; G-code will appear here automatically\n; 1. Compile OpenSCAD code\n; 2. Configure operations in the right panel'}
          theme="vs-dark"
          options={{
            readOnly: true,
            fontSize: 12,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
            renderLineHighlight: 'none',
          }}
          onMount={handleEditorMount}
        />
      </div>
    </div>
  )
}
