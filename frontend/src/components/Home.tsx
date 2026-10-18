import { useCallback, useEffect, useState } from 'react'
import type { Lab, NodeState } from '../types/lab'
import {
  ApiError,
  deleteLab,
  deleteLabFile,
  getLabAnnotations,
  getLabs,
  getLabTopologyFiles,
  stopLab,
  type RawLabNode,
  type RawLabsResponse,
  type TopologyFileEntry,
} from '../api/client'
import { getLabDisplayName } from '../utils/labName'
import { readLabTitle } from '../utils/annotations'
import { deleteSnapshotsOf, startSavedLab } from '../utils/labRuntime'
import { isSnapshotLabName } from '../utils/snapshot'
import { useAuthStore } from '../store/authStore'
import { useUiStore } from '../store/uiStore'
import './Home.css'

const stateLabel: Record<NodeState, string> = {
  running: 'running',
  exited: 'stopped',
  created: 'created',
  paused: 'paused',
}

// 自動保存（2026-10-14）になってから、ラボは「保存済みのトポロジ」として存在し、
// 起動していなくても一覧に出す。保存済みラボの一覧（GET /labs/topology/files、自分のものだけ）に、
// 動いている/停止中のコンテナの状態（GET /api/v1/labs）を重ねる。
// GET /api/v1/labs は clab_admins 所属だと他ユーザーのラボも返すため、そちらは自分のものだけ使う
// title：annotationsに保存した表示名（2026-10-14〜。無ければこのブラウザのlocalStorageの名前）
type HomeLab = Lab & { runKind: 'running' | 'stopped' | 'none'; yamlFileName?: string; annotationsFileName?: string; title?: string }

function toLabs(files: TopologyFileEntry[], raw: RawLabsResponse, username: string | null): HomeLab[] {
  const names = new Set(files.map((f) => f.labName))
  for (const [labName, nodes] of Object.entries(raw)) {
    if (nodes[0]?.owner === username) names.add(labName)
  }
  // スナップショット（`<ラボ>-snap-<日時>`、utils/snapshot.ts）は起動しない保存用のラボなので一覧に出さない
  return [...names].filter((n) => !isSnapshotLabName(n)).sort().reverse().map((labName) => {
    const nodes = raw[labName] ?? []
    const file = files.find((f) => f.labName === labName)
    return {
    name: labName,
    owner: nodes[0]?.owner ?? username ?? '',
    runKind: nodes.length === 0 ? 'none' : nodes.some((n) => n.state === 'running') ? 'running' : 'stopped',
    yamlFileName: file?.yamlFileName,
    annotationsFileName: file?.hasAnnotations ? file.annotationsFileName : undefined,
    nodes: nodes.map((n: RawLabNode) => ({
      name: n.nodeName,
      kind: n.kind,
      image: n.image,
      state: (n.state in stateLabel ? n.state : 'created') as NodeState,
      ipv4_address: n.ipv4_address,
    })),
    }
  })
}

const runKindLabel: Record<HomeLab['runKind'], string> = { running: '起動中', stopped: '停止中', none: '未起動' }

// 2026-10-13以前のラボのovs-bridge(l2-switch)はコンテナを起動しないkindなのでコンソールの対象外
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
            title={n.kind === 'ovs-bridge' ? '古い形式のL2スイッチにはコンソールがありません（エディタの「作り直す」で使えるようになります）' : !hasConsole(n) ? 'ノードが起動していません' : 'コンソールを開く'}
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
  const [labs, setLabs] = useState<HomeLab[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, BusyAction | undefined>>({})
  const [actionError, setActionError] = useState<Record<string, string | undefined>>({})
  const openEditor = useUiStore((s) => s.openEditor)
  const username = useAuthStore((s) => s.username)

  const refresh = useCallback(() => {
    Promise.all([getLabTopologyFiles(), getLabs()])
      .then(async ([files, raw]) => {
        const list = toLabs(files, raw, username)
        setLabs(list)
        // 表示名はannotationsにあるので、ラボごとに取ってから差し替える（取れなければ従来の名前のまま）
        const titles = await Promise.all(
          list.map((lab) =>
            lab.annotationsFileName ? getLabAnnotations(lab.name).then(readLabTitle).catch(() => undefined) : undefined,
          ),
        )
        setLabs(list.map((lab, i) => ({ ...lab, title: titles[i] })))
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'ラボ一覧の取得に失敗しました'))
  }, [username])

  useEffect(() => {
    refresh()
  }, [refresh])

  const runAction = useCallback(
    async (lab: HomeLab, action: BusyAction) => {
      const labName = lab.name
      if (
        action === 'destroy' &&
        !window.confirm(`ラボ「${lab.title ?? getLabDisplayName(labName)}」を削除します。保存したトポロジやルーターの設定、スナップショットも消え、元に戻せません。よろしいですか？`)
      )
        return
      if (action === 'stop' && !window.confirm('ラボを停止します。write memoryしていないルーターの設定は消えます。よろしいですか？')) return

      setBusy((b) => ({ ...b, [labName]: action }))
      setActionError((e) => ({ ...e, [labName]: undefined }))
      try {
        if (action === 'start') {
          // 保存済みトポロジでapplyし、スイッチのVLAN・PCのアドレス等も流し直す（labRuntime.ts）
          const { failures } = await startSavedLab(labName)
          if (failures.length > 0) throw new Error(`起動しましたが設定の反映に失敗: ${failures.join(' / ')}`)
        } else if (action === 'stop') await stopLab(labName)
        else if (lab.runKind !== 'none') await deleteLab(labName)
        else {
          // 一度も起動していないラボはコンテナが無くDELETE /labs/{name}の対象外なので、保存ファイルを消す
          if (lab.annotationsFileName) await deleteLabFile(labName, lab.annotationsFileName).catch(() => undefined)
          await deleteLabFile(labName, lab.yamlFileName ?? `${labName}.clab.yml`)
        }
        // このラボのスナップショットもまとめて消す（残すと、ホームに出ないまま容量だけ使い続ける）
        if (action === 'destroy') await deleteSnapshotsOf(labName, await getLabTopologyFiles()).catch(() => undefined)
      } catch (e) {
        const message = e instanceof ApiError || e instanceof Error ? e.message : `${action}に失敗しました`
        setActionError((prev) => ({ ...prev, [labName]: message }))
      } finally {
        setBusy((b) => ({ ...b, [labName]: undefined }))
        refresh()
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
            <p className="lab-list__hint">自分のラボ（編集内容は自動保存されます）</p>
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
          // 保存時に日本語名等が使われた場合、実際のAPI上の名前は安全な名前に変換されている
          // （utils/labName.ts参照）。localStorageに記録された元の名前があればそちらを表示する。
          const displayName = lab.title ?? getLabDisplayName(lab.name)
          return (
            <div className="lab-card" key={lab.name}>
              <div className="lab-card__top">
                <span className="lab-card__name" title={displayName !== lab.name ? `ラボのID: ${lab.name}` : undefined}>
                  {displayName}
                </span>
                <span className="lab-card__owner">@{lab.owner}</span>
              </div>
              {lab.runKind !== 'none' && <LabNodeList labName={lab.name} nodes={lab.nodes} />}
              <div className="lab-card__meta">
                {runKindLabel[lab.runKind]}
                {lab.runKind !== 'none' && `（${runningCount}/${lab.nodes.length} ノード起動中）`}
              </div>
              {actionError[lab.name] && <p className="lab-card__error">{actionError[lab.name]}</p>}
              <div className="lab-card__actions">
                <button onClick={() => runAction(lab, 'start')} disabled={!!labBusy || lab.runKind === 'running'}>
                  {labBusy === 'start' ? '起動中...' : '▶ 起動'}
                </button>
                <button onClick={() => runAction(lab, 'stop')} disabled={!!labBusy || lab.runKind !== 'running'}>
                  {labBusy === 'stop' ? '停止中...' : '■ 停止'}
                </button>
                <button className="lab-card__actions-destroy" onClick={() => runAction(lab, 'destroy')} disabled={!!labBusy}>
                  {labBusy === 'destroy' ? '削除中...' : '削除'}
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
