import { useState, useMemo } from 'react'
import { useAppState } from '../context/AppStateContext'
import { effectiveOp } from '../lib/gcodeGenerator'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const DIRECTIONS = [
  { id: 'climb', label: 'Climb' },
  { id: 'conventional', label: 'Conventional' },
]

const OVERRIDE_FIELDS = [
  { key: 'toolDiameter', label: 'Tool Diameter (mm)', min: 0.1, step: 0.025, type: 'number' },
  { key: 'feedrate',     label: 'Feedrate (mm/min)',  min: 1,   step: 10,    type: 'number' },
  { key: 'spindleSpeed', label: 'Spindle Speed (RPM)', min: 100, step: 100,  type: 'number' },
  { key: 'stepdown',     label: 'Stepdown (mm)',       min: 0.01, step: 0.1, type: 'number' },
  { key: 'stepover',     label: 'Stepover (%)',        min: 1,   step: 5, max: 100, type: 'number' },
  { key: 'direction',    label: 'Direction',           type: 'select', options: DIRECTIONS },
]

function swatchStyle(color) {
  return { background: color ? `#${color.toString(16).padStart(6, '0')}` : '#6b9fff' }
}

function SortableOpItem({ op, selectedOperationId, setSelectedOperationId, setEditingId, globalToolSettings, toggleEnabled, isActiveInTimeline, onJumpToProgress }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: op.id })
  const eop = effectiveOp(op, globalToolSettings)
  const disabled = op.enabled === false

  function handleClick() {
    setSelectedOperationId(op.id)
    setEditingId(null)
    if (onJumpToProgress) onJumpToProgress()
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      onClick={handleClick}
      className={`flex items-center justify-between px-2 py-2 cursor-pointer transition-colors ${
        op.id === selectedOperationId
          ? 'bg-[#1a2a3a] border-l-2 border-[#6b9fff]'
          : isActiveInTimeline
            ? 'bg-[#0d1a0d] border-l-2 border-[#69f0ae]'
            : 'hover:bg-[#181818] border-l-2 border-transparent'
      } ${disabled ? 'opacity-40' : ''}`}
    >
      {/* Grip handle */}
      <span
        {...attributes}
        {...listeners}
        className="text-[#333] hover:text-[#555] cursor-grab active:cursor-grabbing shrink-0 mr-1 select-none"
        onClick={e => e.stopPropagation()}
      >
        ⠿
      </span>

      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Enable toggle */}
        <input
          type="checkbox"
          checked={!disabled}
          onChange={e => { e.stopPropagation(); toggleEnabled(op.id) }}
          onClick={e => e.stopPropagation()}
          className="shrink-0 accent-[#6b9fff] cursor-pointer"
        />
        <div className="w-2 h-2 rounded-full shrink-0" style={swatchStyle(op.color)} />
        <div className="min-w-0 flex-1">
          <span className="text-[#c8c8c8] text-xs block truncate">{op.label}</span>
          <span className="text-[#555] text-xs">
            {op.type} · ⌀{eop.toolDiameter}mm
            {op.detectedDepth != null && ` · ${op.detectedDepth.toFixed(1)}mm`}
          </span>
        </div>
        {isActiveInTimeline && (
          <span className="text-[#69f0ae] text-[9px] shrink-0 ml-1" title="Timeline position">▶</span>
        )}
      </div>
      {Object.keys(op.overrides ?? {}).length > 0 && (
        <span className="text-[#6b9fff] text-xs shrink-0 ml-1" title="Has overrides">✦</span>
      )}
    </div>
  )
}

export default function OperationsPanel() {
  const {
    operations, setOperations,
    selectedOperationId, setSelectedOperationId,
    globalToolSettings,
    simProgress, moveSequence, jumpToProgress,
  } = useAppState()

  const [editingId, setEditingId] = useState(null)

  // Derive which operation is currently under the timeline scrubber
  const activeFromTimeline = useMemo(() => {
    if (!moveSequence?.opRanges?.length || !moveSequence.totalLength) return null
    const dist = simProgress * moveSequence.totalLength
    const range = moveSequence.opRanges.find(r => dist >= r.startDist && dist <= r.endDist)
    return range?.operationId ?? null
  }, [simProgress, moveSequence])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const selected = operations.find(op => op.id === selectedOperationId)

  function toggleEnabled(id) {
    setOperations(ops =>
      ops.map(op => op.id === id ? { ...op, enabled: op.enabled === false ? true : false } : op)
    )
  }

  function updateField(field, value) {
    setOperations(ops =>
      ops.map(op => op.id === selectedOperationId ? { ...op, [field]: value } : op)
    )
  }

  function setOverride(field, value) {
    setOperations(ops =>
      ops.map(op => op.id === selectedOperationId
        ? { ...op, overrides: { ...op.overrides, [field]: value } }
        : op
      )
    )
  }

  function clearOverride(field) {
    setOperations(ops =>
      ops.map(op => {
        if (op.id !== selectedOperationId) return op
        const next = { ...op.overrides }
        delete next[field]
        return { ...op, overrides: next }
      })
    )
  }

  function clearAllOverrides() {
    setOperations(ops =>
      ops.map(op => op.id === selectedOperationId ? { ...op, overrides: {} } : op)
    )
  }

  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    setOperations(ops => {
      const oldIndex = ops.findIndex(op => op.id === active.id)
      const newIndex = ops.findIndex(op => op.id === over.id)
      return arrayMove(ops, oldIndex, newIndex)
    })
  }

  const isEditing = editingId === selectedOperationId

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center px-3 py-2 bg-[#141414] border-b border-[#2a2a2a] shrink-0">
        <span className="text-[#888] text-xs uppercase tracking-wider">Operations</span>
      </div>

      {/* Operation list */}
      <div className="border-b border-[#2a2a2a] overflow-y-auto max-h-[45%] shrink-0">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={operations.map(op => op.id)} strategy={verticalListSortingStrategy}>
            {operations.map(op => {
              const range = moveSequence?.opRanges?.find(r => r.operationId === op.id)
              return (
                <SortableOpItem
                  key={op.id}
                  op={op}
                  selectedOperationId={selectedOperationId}
                  setSelectedOperationId={setSelectedOperationId}
                  setEditingId={setEditingId}
                  globalToolSettings={globalToolSettings}
                  toggleEnabled={toggleEnabled}
                  isActiveInTimeline={op.id === activeFromTimeline}
                  onJumpToProgress={range && moveSequence?.totalLength > 0
                    ? () => jumpToProgress(range.startDist / moveSequence.totalLength)
                    : null}
                />
              )
            })}
          </SortableContext>
        </DndContext>
        {operations.length === 0 && (
          <p className="text-[#444] text-xs px-3 py-4 text-center">
            Compile a model to detect operations.
          </p>
        )}
      </div>

      {/* Operation detail */}
      {selected ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">

          {/* Detected info */}
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
              onChange={e => updateField('label', e.target.value)}
              className={inputClass}
            />
          </Field>

          <div className="text-[#555] text-xs flex justify-between">
            <span>Type</span>
            <span className="text-[#888] capitalize">{selected.type}</span>
          </div>

          {selected.detectedDepth != null && (
            <div className="text-[#555] text-xs flex justify-between">
              <span>Z passes</span>
              <span className="text-[#888]">
                {Math.ceil(selected.detectedDepth / Math.max(effectiveOp(selected, globalToolSettings).stepdown, 0.001))}
                {(() => {
                  const sd = Math.max(effectiveOp(selected, globalToolSettings).stepdown, 0.001)
                  const rem = selected.detectedDepth % sd
                  return rem > 0.001 ? ` (last: ${rem.toFixed(2)}mm)` : ''
                })()}
              </span>
            </div>
          )}

          <div className="border-t border-[#1e1e1e]" />

          {/* Tool overrides */}
          <div className="flex items-center justify-between">
            <span className="text-[#666] text-xs uppercase tracking-wider">Tool Settings</span>
            {isEditing ? (
              <div className="flex gap-2">
                {Object.keys(selected.overrides ?? {}).length > 0 && (
                  <button
                    onClick={clearAllOverrides}
                    className="text-[#ff6b6b] text-xs hover:text-[#ff9999] transition-colors"
                  >
                    Reset all
                  </button>
                )}
                <button
                  onClick={() => setEditingId(null)}
                  className="text-[#6b9fff] text-xs hover:text-[#99c2ff] transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditingId(selected.id)}
                className="text-[#6b9fff] text-xs hover:text-[#99c2ff] transition-colors"
              >
                {Object.keys(selected.overrides ?? {}).length > 0 ? 'Edit overrides' : 'Override'}
              </button>
            )}
          </div>

          {isEditing ? (
            <div className="space-y-2.5">
              {OVERRIDE_FIELDS.map(f => {
                if (f.key === 'direction' && selected.type === 'drill') return null
                const hasOverride = (selected.overrides ?? {})[f.key] !== undefined
                const eop = effectiveOp(selected, globalToolSettings)
                return (
                  <div key={f.key} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className={`text-xs ${hasOverride ? 'text-[#6b9fff]' : 'text-[#666]'}`}>
                        {f.label}
                        {hasOverride && <span className="ml-1 text-[#6b9fff]">✦</span>}
                      </label>
                      {hasOverride && (
                        <button
                          onClick={() => clearOverride(f.key)}
                          className="text-[#555] hover:text-[#ff6b6b] text-xs transition-colors"
                          title="Reset to global"
                        >
                          ↩ global
                        </button>
                      )}
                    </div>
                    {f.type === 'select' ? (
                      <select
                        value={eop[f.key]}
                        onChange={e => setOverride(f.key, e.target.value)}
                        className={inputClass}
                      >
                        {f.options.map(o => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        value={eop[f.key]}
                        min={f.min}
                        max={f.max}
                        step={f.step}
                        onChange={e => {
                          const v = parseFloat(e.target.value)
                          setOverride(f.key, isNaN(v) ? (f.min ?? 0) : v)
                        }}
                        className={inputClass}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="space-y-1">
              {OVERRIDE_FIELDS.map(f => {
                if (f.key === 'direction' && selected.type === 'drill') return null
                const eop = effectiveOp(selected, globalToolSettings)
                const hasOverride = (selected.overrides ?? {})[f.key] !== undefined
                return (
                  <div key={f.key} className="flex justify-between text-xs">
                    <span className="text-[#555]">{f.label.replace(/ \(.*\)/, '')}</span>
                    <span className={hasOverride ? 'text-[#6b9fff]' : 'text-[#888]'}>
                      {f.type === 'select' ? f.options.find(o => o.id === eop[f.key])?.label : eop[f.key]}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
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

const inputClass =
  'w-full bg-[#111] border border-[#2a2a2a] text-[#c8c8c8] text-xs px-2 py-1.5 rounded focus:outline-none focus:border-[#6b9fff] transition-colors'
