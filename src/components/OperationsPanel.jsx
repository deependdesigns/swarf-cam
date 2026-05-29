import { useAppState } from '../context/AppStateContext'

const OP_TYPES = [
  { id: 'profile', label: 'Profile' },
  { id: 'pocket', label: 'Pocket' },
  { id: 'drill', label: 'Drill' },
  { id: 'slot', label: 'Slot (open)' },
]

const DIRECTIONS = [
  { id: 'climb', label: 'Climb' },
  { id: 'conventional', label: 'Conventional' },
]

// Swatch color from the hex number stored on each operation
function swatchStyle(color) {
  return { background: color ? `#${color.toString(16).padStart(6, '0')}` : '#6b9fff' }
}

export default function OperationsPanel() {
  const {
    operations, setOperations,
    selectedOperationId, setSelectedOperationId,
  } = useAppState()

  const selected = operations.find((op) => op.id === selectedOperationId)

  function removeOperation(id) {
    setOperations((ops) => {
      const next = ops.filter((op) => op.id !== id)
      if (id === selectedOperationId) setSelectedOperationId(next[0]?.id ?? null)
      return next
    })
  }

  function updateField(field, value) {
    setOperations((ops) =>
      ops.map((op) => (op.id === selectedOperationId ? { ...op, [field]: value } : op))
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0">
        <span className="text-[#888] text-xs uppercase tracking-wider">Operations</span>
      </div>

      {/* Operation list */}
      <div className="border-b border-[#2a2a2a] overflow-y-auto max-h-[45%] shrink-0">
        {operations.map((op) => (
          <div
            key={op.id}
            onClick={() => setSelectedOperationId(op.id)}
            className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${
              op.id === selectedOperationId
                ? 'bg-[#1a2a3a] border-l-2 border-[#6b9fff]'
                : 'hover:bg-[#181818] border-l-2 border-transparent'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2 h-2 rounded-full shrink-0" style={swatchStyle(op.color)} />
              <div className="min-w-0">
                <span className="text-[#c8c8c8] text-xs block truncate">{op.label}</span>
                <span className="text-[#555] text-xs">
                  {op.type} · ⌀{op.toolDiameter}mm
                  {op.detectedDepth != null && ` · ${op.detectedDepth.toFixed(1)}mm deep`}
                </span>
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); removeOperation(op.id) }}
              className="text-[#444] hover:text-[#ff6b6b] text-xs px-1 ml-1 shrink-0 transition-colors"
            >
              ✕
            </button>
          </div>
        ))}
        {operations.length === 0 && (
          <p className="text-[#444] text-xs px-3 py-4 text-center">
            Compile a model to detect operations.
          </p>
        )}
      </div>

      {/* Operation editor */}
      {selected ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Auto-detected info badge */}
          {selected.detectedDepth != null && (
            <div className="bg-[#0d1a0d] border border-[#1a3a1a] rounded px-2 py-1.5 text-[#69f0ae] text-xs space-y-0.5">
              <div className="flex justify-between">
                <span className="text-[#3a7a3a]">Detected depth</span>
                <span>{selected.detectedDepth.toFixed(2)} mm</span>
              </div>
              {selected.detectedCount > 1 && (
                <div className="flex justify-between">
                  <span className="text-[#3a7a3a]">Features</span>
                  <span>{selected.detectedCount} locations</span>
                </div>
              )}
            </div>
          )}

          <Field label="Label">
            <input
              type="text"
              value={selected.label}
              onChange={(e) => updateField('label', e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Type">
            <select
              value={selected.type}
              onChange={(e) => updateField('type', e.target.value)}
              className={inputClass}
            >
              {OP_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </Field>

          <Divider />

          <Field label="Tool Diameter (mm)">
            <NumInput value={selected.toolDiameter} min={0.1} step={0.025} onChange={(v) => updateField('toolDiameter', v)} />
          </Field>

          <Field label="Feedrate (mm/min)">
            <NumInput value={selected.feedrate} min={1} step={10} onChange={(v) => updateField('feedrate', v)} />
          </Field>

          <Field label="Spindle Speed (RPM)">
            <NumInput value={selected.spindleSpeed} min={100} step={100} onChange={(v) => updateField('spindleSpeed', v)} />
          </Field>

          <Divider />

          <Field label="Depth (mm)">
            <NumInput value={selected.depth} min={0.01} step={0.5} onChange={(v) => updateField('depth', v)} />
          </Field>

          <Field label="Stepdown (mm)">
            <NumInput value={selected.stepdown} min={0.01} step={0.1} onChange={(v) => updateField('stepdown', v)} />
          </Field>

          {selected.type !== 'drill' && (
            <Field label="Direction">
              <select
                value={selected.direction ?? 'climb'}
                onChange={(e) => updateField('direction', e.target.value)}
                className={inputClass}
              >
                {DIRECTIONS.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </Field>
          )}

          <Divider />

          <div className="text-[#555] text-xs space-y-1 pt-1">
            <div className="flex justify-between">
              <span>Z passes</span>
              <span className="text-[#888]">{Math.ceil(selected.depth / Math.max(selected.stepdown, 0.001))}</span>
            </div>
            <div className="flex justify-between">
              <span>Total depth</span>
              <span className="text-[#888]">{selected.depth.toFixed(2)} mm</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[#444] text-xs text-center px-4">Select an operation to edit</p>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="space-y-1">
      <label className="text-[#666] text-xs block">{label}</label>
      {children}
    </div>
  )
}

function NumInput({ value, min, step, onChange }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      step={step}
      onChange={(e) => {
        const parsed = parseFloat(e.target.value)
        onChange(isNaN(parsed) ? (min ?? 0) : parsed)
      }}
      className={inputClass}
    />
  )
}

function Divider() {
  return <div className="border-t border-[#1e1e1e]" />
}

const inputClass =
  'w-full bg-[#111] border border-[#2a2a2a] text-[#c8c8c8] text-xs px-2 py-1.5 rounded focus:outline-none focus:border-[#6b9fff] transition-colors'
