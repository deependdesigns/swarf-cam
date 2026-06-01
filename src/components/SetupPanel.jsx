import { useAppState } from '../context/AppStateContext'

export default function SetupPanel() {
  const { machineSettings, setMachineSettings, globalToolSettings, setGlobalToolSettings } = useAppState()

  function updateMachine(field, value) {
    setMachineSettings(s => ({ ...s, [field]: value }))
  }

  function updateTool(field, value) {
    setGlobalToolSettings(s => ({ ...s, [field]: value }))
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-5">

      {/* Machine */}
      <Section label="Machine">
        <Field label="Safety Height (mm)">
          <NumInput value={machineSettings.safetyHeight} min={0.1} step={0.5}
            onChange={v => updateMachine('safetyHeight', v)} />
        </Field>
        <Field label="Origin Safety Height (mm)">
          <NumInput value={machineSettings.originSafetyHeight} min={0.1} step={1}
            onChange={v => updateMachine('originSafetyHeight', v)} />
        </Field>
        <Field label="Work Area X (mm)">
          <NumInput value={machineSettings.workAreaX} min={1} step={10}
            onChange={v => updateMachine('workAreaX', v)} />
        </Field>
        <Field label="Work Area Y (mm)">
          <NumInput value={machineSettings.workAreaY} min={1} step={10}
            onChange={v => updateMachine('workAreaY', v)} />
        </Field>
      </Section>

      {/* Coordinate Origin */}
      <Section label="Coordinate Origin">
        <Field label="Z Zero">
          <select
            value={machineSettings.zZeroMode}
            onChange={e => updateMachine('zZeroMode', e.target.value)}
            className={inputClass}
          >
            <option value="top">Top of material</option>
            <option value="spoilboard">Spoilboard</option>
          </select>
        </Field>
      </Section>

      {/* Material */}
      <Section label="Material">
        <div className="text-[#555] text-xs mb-2">Stock block dimensions for simulation.</div>
        <Field label="Width — X (mm)">
          <NumInput value={machineSettings.materialWidth ?? 150} min={1} step={10}
            onChange={v => updateMachine('materialWidth', v)} />
        </Field>
        <Field label="Length — Y (mm)">
          <NumInput value={machineSettings.materialLength ?? 150} min={1} step={10}
            onChange={v => updateMachine('materialLength', v)} />
        </Field>
        <Field label="Thickness — Z (mm)">
          <NumInput value={machineSettings.materialThickness} min={0.1} step={0.5}
            onChange={v => updateMachine('materialThickness', v)} />
        </Field>
      </Section>

      {/* Global Tool */}
      <Section label="Global Tool">
        <div className="text-[#555] text-xs mb-2">Single-tool job — applies to all operations unless overridden.</div>
        <Field label="Tool Diameter (mm)">
          <NumInput value={globalToolSettings.toolDiameter} min={0.1} step={0.025}
            onChange={v => updateTool('toolDiameter', v)} />
        </Field>
        <Field label="Feedrate (mm/min)">
          <NumInput value={globalToolSettings.feedrate} min={1} step={10}
            onChange={v => updateTool('feedrate', v)} />
        </Field>
        <Field label="Spindle Speed (RPM)">
          <NumInput value={globalToolSettings.spindleSpeed} min={100} step={100}
            onChange={v => updateTool('spindleSpeed', v)} />
        </Field>
        <Field label="Stepdown (mm)">
          <NumInput value={globalToolSettings.stepdown} min={0.01} step={0.1}
            onChange={v => updateTool('stepdown', v)} />
        </Field>
        <Field label="Stepover (%)">
          <NumInput value={globalToolSettings.stepover} min={1} max={100} step={5}
            onChange={v => updateTool('stepover', v)} />
        </Field>
        <Field label="Direction">
          <select
            value={globalToolSettings.direction}
            onChange={e => updateTool('direction', e.target.value)}
            className={inputClass}
          >
            <option value="climb">Climb</option>
            <option value="conventional">Conventional</option>
          </select>
        </Field>
      </Section>

    </div>
  )
}

function Section({ label, children }) {
  return (
    <div>
      <div className="text-[#555] text-xs uppercase tracking-wider mb-2">{label}</div>
      <div className="space-y-2.5">{children}</div>
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

function NumInput({ value, min, max, step, onChange }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={e => {
        const parsed = parseFloat(e.target.value)
        onChange(isNaN(parsed) ? (min ?? 0) : parsed)
      }}
      className={inputClass}
    />
  )
}

const inputClass =
  'w-full bg-[#111] border border-[#2a2a2a] text-[#c8c8c8] text-xs px-2 py-1.5 rounded focus:outline-none focus:border-[#6b9fff] transition-colors'
