import { useState } from 'react'
import { useAppState } from '../context/AppStateContext'

const OP_TYPES = [
  { id: 'profile', label: 'Profile' },
  { id: 'pocket', label: 'Pocket' },
  { id: 'drill', label: 'Drill' },
]

const DIRECTIONS = [
  { id: 'climb', label: 'Climb' },
  { id: 'conventional', label: 'Conventional' },
]

let nextId = 2

export default function OperationsPanel() {
  const { operations, setOperations } = useAppState()
  const [selectedId, setSelectedId] = useState(operations[0]?.id ?? null)

  const selected = operations.find((op) => op.id === selectedId)

  function addOperation() {
    const newOp = {
      id: nextId++,
      type: 'profile',
      label: `Operation ${nextId - 1}`,
      toolDiameter: 3.175,
      feedrate: 1000,
      spindleSpeed: 18000,
      stepdown: 1.0,
      depth: 10.0,
      passes: 1,
      direction: 'climb',
    }
    setOperations((ops) => [...ops, newOp])
    setSelectedId(newOp.id)
  }

  function removeOperation(id) {
    setOperations((ops) => ops.filter((op) => op.id !== id))
    setSelectedId((prev) => {
      if (prev === id) return operations.find((op) => op.id !== id)?.id ?? null
      return prev
    })
  }

  function updateField(field, value) {
    setOperations((ops) =>
      ops.map((op) => (op.id === selectedId ? { ...op, [field]: value } : op))
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0">
        <span className="text-[#888] text-xs uppercase tracking-wider">Operations</span>
        <button
          onClick={addOperation}
          className="px-2 py-1 text-xs bg-[#1a1a1a] hover:bg-[#252525] border border-[#333] text-[#aaa] rounded transition-colors"
        >
          + Add
        </button>
      </div>

      {/* Operation list */}
      <div className="border-b border-[#2a2a2a] shrink-0">
        {operations.map((op) => (
          <div
            key={op.id}
            onClick={() => setSelectedId(op.id)}
            className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${
              op.id === selectedId
                ? 'bg-[#1a2a3a] border-l-2 border-[#6b9fff]'
                : 'hover:bg-[#181818] border-l-2 border-transparent'
            }`}
          >
            <div>
              <span className="text-[#c8c8c8] text-xs block">{op.label}</span>
              <span className="text-[#555] text-xs">{op.type} · ⌀{op.toolDiameter}mm</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); removeOperation(op.id) }}
              className="text-[#444] hover:text-[#ff6b6b] text-xs px-1 transition-colors"
            >
              ✕
            </button>
          </div>
        ))}
        {operations.length === 0 && (
          <p className="text-[#444] text-xs px-3 py-3">No operations. Click + Add.</p>
        )}
      </div>

      {/* Operation editor */}
      {selected ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
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
                value={selected.direction}
                onChange={(e) => updateField('direction', e.target.value)}
                className={inputClass}
              >
                {DIRECTIONS.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </Field>
          )}

          {selected.type !== 'drill' && (
            <Field label="Passes (finishing)">
              <NumInput value={selected.passes} min={1} step={1} onChange={(v) => updateField('passes', Math.round(v))} />
            </Field>
          )}

          <Divider />

          <div className="text-[#555] text-xs space-y-1 pt-1">
            <div className="flex justify-between">
              <span>Z passes</span>
              <span className="text-[#888]">{Math.ceil(selected.depth / selected.stepdown)}</span>
            </div>
            <div className="flex justify-between">
              <span>Total depth</span>
              <span className="text-[#888]">{selected.depth.toFixed(2)} mm</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[#444] text-xs">Select an operation to edit</p>
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
