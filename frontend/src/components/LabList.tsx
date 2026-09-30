import { useCallback, useEffect, useState } from 'react'
import { PALETTE_NODE_CONFIGS, type Lab, type NodeState } from '../types/lab'
import {
  ApiError,
  destroyLab,
  getLabs,
  startLab,
  stopLab,
  type RawLabNode,
  type RawLabsResponse,
} from '../api/client'
import { getLabDisplayName } from '../utils/labName'
import { useConsoleStore } from '../store/consoleStore'
import { useUiStore } from '../store/uiStore'
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

// ovs-bridge(l2-switch)はコンテナを起動しないkindなのでシェル/コンソールの対象外
// （api-contract.md 3章参照）
function hasConsole(node: Lab['nodes'][number]) {
  return node.kind !== 'ovs-bridge' && node.state === 'running'
}

// containerlab側ではrouter/pcはどちらもkind:'linux'なので、imageで判別する
// （CMLのように、ルーターは開いた瞬間からvtysh操作にしておきたいため）
function isRouter(node: Lab['nodes'][number]) {
  return node.image === PALETTE_NODE_CONFIGS.router.image
}

// ノードごとに状態と「コンソールを開く」ボタンを並べる一覧。
// ワンタッチでコンソールを開けるように、ここから直接 consoleStore にセッションを追加し
// 画面を統合コンソールへ切り替える（labName/nodeNameの手入力を無くすのが狙い）
function LabNodeList({ labName, nodes }: { labName: string; nodes: Lab['nodes'] }) {
  const openConsole = useConsoleStore((s) => s.openConsole)
  const setView = useUiStore((s) => s.setView)

  const openNodeConsole = (node: Lab['nodes'][number]) => {
    openConsole(labName, node.name, isRouter(node) ? 'vtysh' : undefined)
    setView('console')
  }

  return (
    <div className="lab-node-list">
      {nodes.map((n) => (
        <div key={n.name} className="lab-node-row" title={`${n.name}: ${stateLabel[n.state]}`}>
          <span className={`lab-dot lab-dot--${n.state}`} />
          <span className="lab-node-row__name">{n.name}</span>
          <button
            className="lab-node-row__console"
            disabled={!hasConsole(n)}
            title={n.kind === 'ovs-bridge' ? 'L2スイッチにはコンソールがありません' : !hasConsole(n) ? 'ノードが起動していません' : 'コンソールを開く'}
            onClick={() => openNodeConsole(n)}
          >
            🖥
          </button>
        </div>
      ))}
    </div>
  )
}

type BusyAction = 'start' | 'stop' | 'destroy'

export default function LabList() {
  const [labs, setLabs] = useState<Lab[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, BusyAction | undefined>>({})
  const [actionError, setActionError] = useState<Record<string, string | undefined>>({})

  const refresh = useCallback(() => {
    getLabs()
      .then((raw) => setLabs(toLabs(raw)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'ラボ一覧の取得に失敗しました'))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const runAction = useCallback(
    async (labName: string, action: BusyAction) => {
      if (action === 'destroy' && !window.confirm(`ラボ「${labName}」を削除します。よろしいですか？`)) return

      setBusy((b) => ({ ...b, [labName]: action }))
      setActionError((e) => ({ ...e, [labName]: undefined }))
      try {
        if (action === 'start') await startLab(labName)
        else if (action === 'stop') await stopLab(labName)
        else await destroyLab(labName)
        refresh()
      } catch (e) {
        const message = e instanceof ApiError || e instanceof Error ? e.message : `${action}に失敗しました`
        setActionError((prev) => ({ ...prev, [labName]: message }))
      } finally {
        setBusy((b) => ({ ...b, [labName]: undefined }))
      }
    },
    [refresh],
  )

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
          const labBusy = busy[lab.name]
          // deploy時に日本語名等が使われた場合、実際のAPI上の名前は安全な名前に変換されている
          // （utils/labName.ts参照）。localStorageに記録された元の名前があればそちらを表示する。
          const displayName = getLabDisplayName(lab.name)
          return (
            <div className="lab-card" key={lab.name}>
              <div className="lab-card__top">
                <span className="lab-card__name" title={displayName !== lab.name ? `実際の名前: ${lab.name}` : undefined}>
                  {displayName}
                </span>
                <span className="lab-card__owner">@{lab.owner}</span>
              </div>
              <LabNodeList labName={lab.name} nodes={lab.nodes} />
              <div className="lab-card__meta">
                {runningCount}/{lab.nodes.length} nodes running
              </div>
              {actionError[lab.name] && <p className="lab-card__error">{actionError[lab.name]}</p>}
              <div className="lab-card__actions">
                <button onClick={() => runAction(lab.name, 'start')} disabled={!!labBusy}>
                  {labBusy === 'start' ? '起動中...' : 'Start'}
                </button>
                <button onClick={() => runAction(lab.name, 'stop')} disabled={!!labBusy}>
                  {labBusy === 'stop' ? '停止中...' : 'Stop'}
                </button>
                <button className="lab-card__actions-destroy" onClick={() => runAction(lab.name, 'destroy')} disabled={!!labBusy}>
                  {labBusy === 'destroy' ? '削除中...' : 'Destroy'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
