// どの画面（トポロジエディタ/ラボ一覧/統合コンソール）を表示中かのグローバル状態。
// LabListのノードから「ワンタッチでコンソールを開く」際、App.tsxのローカルstateだと
// 他コンポーネントから画面遷移を起こせないため、Zustandに切り出した（セッション内のみ、永続化はしない）。
import { create } from 'zustand'

export type View = 'topology' | 'labs' | 'console'

interface UiState {
  view: View
  setView: (view: View) => void
}

export const useUiStore = create<UiState>()((set) => ({
  view: 'topology',
  setView: (view) => set({ view }),
}))
