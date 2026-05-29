import { useState } from 'react'
import SetupPanel from './SetupPanel'
import OperationsPanel from './OperationsPanel'

const TABS = [
  { id: 'setup', label: 'Setup' },
  { id: 'operations', label: 'Operations' },
]

export default function RightPanel() {
  const [activeTab, setActiveTab] = useState('operations')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-[#2a2a2a] bg-[#111]">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-2 text-xs transition-colors ${
              activeTab === tab.id
                ? 'text-[#c8c8c8] border-b-2 border-[#6b9fff] bg-[#141414]'
                : 'text-[#555] hover:text-[#888]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'setup' ? <SetupPanel /> : <OperationsPanel />}
      </div>
    </div>
  )
}
