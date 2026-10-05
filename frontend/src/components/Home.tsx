import { useCallback, useEffect, useState } from 'react'
import type { Lab, NodeState } from '../types/lab'
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
import { useUiStore } from '../store/uiStore'
import './Home.css'

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

// ノードごとに状態と「コンソールを開く」ボタンを並べる一覧。
// 統合コンソールは単独のタブを持たず、常にトポロジエディタのドッキングパネルとしてしか
// 存在しない（2026-10-05決定）。このボタンは裏でそのラボをエディタで開き、読み込み完了後に
// 対象ノードのコンソールを自動でドッキング表示する（TopologyEditor.tsx参照）
function LabNodeList({ labName, nodes }: { labName: string; nodes: Lab['nodes'] }) {
  const openEditor = useUiStore((s) => s.openEditor)

  const openNodeConsole = (node: Lab['nodes'][number]) => {
    openEditor({ mode: 'edit', labName, autoOpenConsoleNode: node.name })
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

// ホーム画面：ラボ一覧＋新規作成の入り口。
// トポロジエディタには「新規作成」または各ラボの「エディタで開く」からしか入れない
// （2026-10-05決定、docs/direction.md参照）。常時表示のタブに戻すと、今エディタに出ている
// トポロジがどのラボなのか分からなくなる誤操作の元になっていたため。
export default function Home() {
  const [labs, setLabs] = useState<Lab[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, BusyAction | undefined>>({})
  const [actionError, setActionError] = useState<Record<string, string | undefined>>({})
  const openEditor = useUiStore((s) => s.openEditor)

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
        <div className="lab-list__header-row">
          <div>
            <h1>ホーム</h1>
            <p className="lab-list__hint">GET /api/v1/labs（自分が所有するラボのみ表示されます）</p>
          </div>
          <button className="lab-list__new-button" onClick={() => openEditor({ mode: 'new' })}>
            ＋ 新規ラボを作成
          </button>
        </div>
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
              <button className="lab-card__edit" onClick={() => openEditor({ mode: 'edit', labName: lab.name })}>
                ✎ エディタで開く
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
