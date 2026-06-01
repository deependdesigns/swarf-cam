import { useRef } from 'react'
import Editor from '@monaco-editor/react'
import { useAppState } from '../context/AppStateContext'
import { compileOpenSCAD } from '../lib/openscadCompiler'
import { track } from '../lib/analytics'

export default function CodeEditorPanel({ onCollapse }) {
  const { scadCode, setScadCode, setStlData, compiling, setCompiling, setCompileError, compileError } = useAppState()
  const editorRef = useRef(null)

  function handleEditorMount(editor) {
    editorRef.current = editor
  }

  async function handleCompile() {
    track.compileClicked()
    setCompiling(true)
    setCompileError(null)
    try {
      const stl = await compileOpenSCAD(scadCode)
      setStlData(stl)
      track.compileSuccess()
    } catch (err) {
      setCompileError(err.message || 'Compilation failed')
      track.compileError(err.message || 'Compilation failed')
    } finally {
      setCompiling(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 border-b border-[#2a2a2a]">
      <PanelHeader title="OpenSCAD Editor">
        <button
          onClick={handleCompile}
          disabled={compiling}
          className="px-3 py-1 text-xs bg-[#1a3a6b] hover:bg-[#1e4a8a] border border-[#2a4a8a] text-[#7bb3ff] rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {compiling ? 'Compiling…' : '▶ Compile'}
        </button>
        {onCollapse && (
          <button onClick={onCollapse} className="text-[#444] hover:text-[#888] px-1 transition-colors" title="Collapse panel">◀</button>
        )}
      </PanelHeader>

      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          defaultLanguage="plaintext"
          value={scadCode}
          onChange={(val) => setScadCode(val ?? '')}
          onMount={handleEditorMount}
          theme="vs-dark"
          options={{
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            renderLineHighlight: 'gutter',
            scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
          }}
        />
      </div>

      {compileError && (
        <div className="px-3 py-2 bg-[#2a1010] border-t border-[#5a2020] text-[#ff6b6b] text-xs font-mono whitespace-pre-wrap max-h-24 overflow-y-auto">
          {compileError}
        </div>
      )}
    </div>
  )
}

function PanelHeader({ title, children }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0">
      <span className="text-[#888] text-xs uppercase tracking-wider">{title}</span>
      <div className="flex gap-2">{children}</div>
    </div>
  )
}
