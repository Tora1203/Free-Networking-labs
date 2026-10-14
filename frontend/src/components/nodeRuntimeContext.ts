import { createContext, useContext } from 'react'

// キャンバス上のノードに起動状態を表示するための情報（2026-10-14、「on/offを切り替えられるが
// 見た目で分からない」指摘対応）。ノードのdataに入れると自動保存・元に戻すの履歴に混ざるため、
// Contextで別に渡す。
//   running  ：起動中
//   stopped  ：停止中（コンテナはあるが止まっている）
//   busy     ：起動・停止の処理中
//   pending  ：ラボは動いているが、このノードはまだ反映されていない（追加した直後など）
//   none     ：ラボを一度も起動していない／状態が分からない（何も表示しない）
export type NodeRunStatus = 'running' | 'stopped' | 'busy' | 'pending' | 'none'

export const NodeRuntimeContext = createContext<(nodeId: string) => NodeRunStatus>(() => 'none')

export function useNodeRunStatus(nodeId: string): NodeRunStatus {
  return useContext(NodeRuntimeContext)(nodeId)
}

export const NODE_RUN_STATUS_LABEL: Record<NodeRunStatus, string> = {
  running: '起動中',
  stopped: '停止中',
  busy: '処理中...',
  pending: '反映待ち',
  none: '',
}
