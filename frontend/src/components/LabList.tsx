import type { Lab, NodeState } from '../types/lab'
import { mockLabs } from '../mocks/labs'
import './LabList.css'

const stateLabel: Record<NodeState, string> = {
  running: 'running',
  exited: 'stopped',
  created: 'created',
}

function LabStatusDots({ nodes }: { nodes: Lab['nodes'] }) {
  return (
    <div className="lab-dots">
      {nodes.map((n) => (
        <span key={n.name} className={`lab-dot lab-dot--${n.state}`} title={`${n.name}: ${stateLabel[n.state]}`} />
      ))}
    </div>
  )
}

export default function LabList() {
  return (
    <div className="lab-list">
      <header className="lab-list__header">
        <h1>ラボ一覧</h1>
        <p className="lab-list__hint">
          GET /api/v1/labs（ダミーデータ・バックエンド未接続）
        </p>
      </header>
      <div className="lab-grid">
        {mockLabs.map((lab) => {
          const runningCount = lab.nodes.filter((n) => n.state === 'running').length
          return (
            <div className="lab-card" key={lab.name}>
              <div className="lab-card__top">
                <span className="lab-card__name">{lab.name}</span>
                <span className="lab-card__owner">@{lab.owner}</span>
              </div>
              <LabStatusDots nodes={lab.nodes} />
              <div className="lab-card__meta">
                {runningCount}/{lab.nodes.length} nodes running
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
