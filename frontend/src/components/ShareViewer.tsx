import { useEffect, useMemo, useState } from 'react'
import { Background, Controls, ReactFlow, ReactFlowProvider, ConnectionMode } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TopologyNode from './TopologyNode'
import LabelNode from './LabelNode'
import AreaNode from './AreaNode'
import FloatingEdge, { type FloatingEdgeData } from './FloatingEdge'
import Brand from './Brand'
import { NodeRuntimeContext, type NodeRunStatus } from './nodeRuntimeContext'
import { getSharedLab, watchShare, type SharedLab } from '../api/collabClient'
import { ApiError } from '../api/client'
import { parseImportedTopology } from '../utils/labTopology'
import { readLabTitle } from '../utils/annotations'
import './ShareViewer.css'

const nodeTypes = { topoNode: TopologyNode, labelNode: LabelNode, areaNode: AreaNode }
const edgeTypes = { floating: FloatingEdge }

// 共有リンクで開く、ラボの閲覧専用の画面（2026-10-16）。ログイン後に見られる。5秒ごとに取り直して、持ち主の変更を映す
function ShareViewerInner({ shareId }: { shareId: string }) {
  const [lab, setLab] = useState<SharedLab | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const next = await getSharedLab(shareId)
        if (stopped) return
        setLab(next)
        setError(null)
      } catch (e) {
        if (stopped) return
        // 見つからない・期限切れは取り直しても直らないので止める
        if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
          setLab(null)
          setError(e.message)
          stopped = true
          return
        }
        setError(e instanceof Error ? e.message : '読み込めませんでした')
      }
    }
    void load()
    const timer = setInterval(() => {
      if (!stopped && !document.hidden) void load()
    }, 5000)
    // 持ち主（や編集した人）の保存を、サーバーからの通知で1秒ほどで映す。通知が無くても5秒ごとに取り直す
    const stopWatch = watchShare(shareId, () => {
      if (!stopped) void load()
    })
    return () => {
      stopped = true
      clearInterval(timer)
      stopWatch()
    }
  }, [shareId])

  const graph = useMemo(() => {
    if (!lab) return null
    try {
      const parsed = parseImportedTopology(lab.yaml, lab.annotations)
      const pairCounts = new Map<string, number>()
      const seen = new Map<string, number>()
      for (const e of parsed.edges) {
        const k = [e.source, e.target].sort().join('|')
        pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1)
      }
      const edges = parsed.edges.map((e) => {
        const k = [e.source, e.target].sort().join('|')
        const index = seen.get(k) ?? 0
        seen.set(k, index + 1)
        const d = e.data as { sourceIface?: string; targetIface?: string } | undefined
        return {
          ...e,
          type: 'floating',
          label: d?.sourceIface && d.targetIface ? `${d.sourceIface}↔${d.targetIface}` : undefined,
          style: { stroke: 'var(--edge)', strokeWidth: 2 },
          labelStyle: { fill: 'var(--ink-soft)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--surface)' },
          data: { ...e.data, parallelIndex: index, parallelCount: pairCounts.get(k) ?? 1 } satisfies FloatingEdgeData,
        }
      })
      return { nodes: parsed.nodes, edges, title: readLabTitle(lab.annotations) ?? lab.labName }
    } catch {
      return null
    }
  }, [lab])

  const states = useMemo(() => {
    const map: Record<string, string> = {}
    for (const n of lab?.nodes ?? []) map[n.nodeName] = n.state
    return map
  }, [lab])
  const runStatus = (nodeId: string): NodeRunStatus => {
    const s = states[nodeId]
    if (s === 'running') return 'running'
    if (s === 'created' || s === 'restarting') return 'busy'
    return s ? 'stopped' : 'none'
  }

  return (
    <div className="share-viewer">
      <div className="share-viewer__bar">
        <Brand size="nav" />
        <div className="share-viewer__title">{graph?.title ?? '共有されたラボ'}</div>
        <span className="share-viewer__badge">閲覧のみ</span>
        {lab && (
          <span className="share-viewer__meta">
            持ち主: {lab.owner} ／ 閲覧: {lab.viewer} ／ 期限: {new Date(lab.expiresAt).toLocaleString()}
          </span>
        )}
      </div>
      {error && <div className="share-viewer__error">{error}</div>}
      <div className="share-viewer__canvas">
        {graph && (
          <NodeRuntimeContext.Provider value={runStatus}>
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              connectionMode={ConnectionMode.Loose}
              minZoom={0.4}
              maxZoom={2}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </NodeRuntimeContext.Provider>
        )}
      </div>
    </div>
  )
}

export default function ShareViewer({ shareId }: { shareId: string }) {
  return (
    <ReactFlowProvider>
      <ShareViewerInner shareId={shareId} />
    </ReactFlowProvider>
  )
}
