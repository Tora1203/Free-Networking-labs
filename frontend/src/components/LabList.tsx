import { useEffect, useState } from 'react'
import type { Lab, NodeState } from '../types/lab'
import { getLabs, type RawLabNode, type RawLabsResponse } from '../api/client'
import './LabList.css'

const stateLabel: Record<NodeState, string> = {
  running: 'running',
  exited: 'stopped',
  created: 'created',
  paused: 'paused',
}

// GET /api/v1/labs は { [labName]: RawLabNode[] } で返る（api-contract.md 2.1）。
// 自分が所有するラボだけが返る（実機確認済み）。UI用の Lab[] 形状に変換する。
function toLabs(raw: RawLabsResponse): Lab[] {
  return Object.entries(raw).map(([labName, nodes]) => ({
    name: labName,
    owner: nodes[0]?.owner ?? '',
    nodes: nodes.map((n: RawLabNode) => ({
      name: n.nodeName,
      kind: n.kind,
      image: n.image,
      state: (n.state in stateLabel ? n.state : 'created') as NodeState,
      ipv4_address: n.ipv4_address,
    })),
  }))
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
  const [labs, setLabs] = useState<Lab[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getLabs()
      .then((raw) => {
        if (!cancelled) setLabs(toLabs(raw))
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'ラボ一覧の取得に失敗しました')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="lab-list">
      <header className="lab-list__header">
        <h1>ラボ一覧</h1>
        <p className="lab-list__hint">GET /api/v1/labs（自分が所有するラボのみ表示されます）</p>
      </header>
      {error && <p className="lab-list__error">{error}</p>}
      {labs === null && !error && <p className="lab-list__hint">読み込み中...</p>}
      {labs !== null && labs.length === 0 && <p className="lab-list__hint">ラボがありません</p>}
      <div className="lab-grid">
        {labs?.map((lab) => {
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
