import { useAppState } from '../context/AppStateContext'

const POST_PROCESSORS = [
  { id: 'grbl', label: 'GRBL' },
  { id: 'mach3', label: 'Mach3' },
  { id: 'linuxcnc', label: 'LinuxCNC' },
]

export default function Header() {
  const { postProcessor, setPostProcessor, compiling } = useAppState()

  return (
    <header className="flex items-center justify-between px-4 py-2 bg-[#111] border-b border-[#2a2a2a] shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-[#e0e0e0] font-bold tracking-widest text-sm uppercase">
          ⚙ Swarf<span className="text-[#6b9fff]">.cam</span>
        </span>
        <span className="text-[#3a3a3a] text-xs">|</span>
        <span className="text-[#555] text-xs">browser CNC CAM</span>
      </div>

      <div className="flex items-center gap-3">
        {compiling && (
          <span className="text-[#6b9fff] text-xs animate-pulse">compiling…</span>
        )}
        <label className="text-[#666] text-xs">Post:</label>
        <select
          value={postProcessor}
          onChange={(e) => setPostProcessor(e.target.value)}
          className="bg-[#1a1a1a] border border-[#333] text-[#c8c8c8] text-xs px-2 py-1 rounded focus:outline-none focus:border-[#6b9fff]"
        >
          {POST_PROCESSORS.map((pp) => (
            <option key={pp.id} value={pp.id}>{pp.label}</option>
          ))}
        </select>
      </div>
    </header>
  )
}
