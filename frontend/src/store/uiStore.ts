// どの画面（トポロジエディタ/ラボ一覧/統合コンソール）を表示中かのグローバル状態。
// LabListのノードから「ワンタッチでコンソールを開く」際、App.tsxのローカルstateだと
// 他コンポーネントから画面遷移を起こせないため、Zustandに切り出した（セッション内のみ、永続化はしない）。
import { create } from 'zustand'

export type View = 'topology' | 'labs' | 'console'

interface UiState {
  view: View
  setView: (view: View) => void
  // トポロジエディタの右側にコンソールをドッキング表示するかどうか。
  // ConsolePane（内部にxterm.js＋WebSocket接続を持つ）はApp.tsx側に1つだけマウントし、
  // ここのフラグでCSSの見た目（フル画面/ドッキング/非表示）だけを切り替える。
  // 一度は「トポロジエディタ側にもConsolePaneをもう1つ直接マウント」する実装をしたが、
  // それだと同じセッションに対して接続が2重に張られてしまい、片方が無反応に見えるバグになった
  // （2026-09-29発見・修正）。
  consolePanelDocked: boolean
  setConsolePanelDocked: (docked: boolean) => void
}

export const useUiStore = create<UiState>()((set) => ({
  view: 'topology',
  setView: (view) => set({ view }),
  consolePanelDocked: false,
  setConsolePanelDocked: (docked) => set({ consolePanelDocked: docked }),
}))
