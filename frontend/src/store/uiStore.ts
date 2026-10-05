// どの画面（ホーム/トポロジエディタ/統合コンソール）を表示中かのグローバル状態。
// ナビゲーションは「ホーム（ラボ一覧・新規作成）→トポロジエディタ」という一方向の流れにして
// いる（2026-10-05決定）。トポロジエディタは常時表示のタブではなく、ホームから
// 「新規作成」または「既存ラボをエディタで開く」のどちらかを選んで入る専用画面にすることで、
// 「今エディタに表示されているのはどのラボなのか」が常に明確になるようにしている
// （以前は常時表示のデモ用トポロジと実際に動いているラボの区別がつかず誤操作を招いていた）。
import { create } from 'zustand'

export type View = 'home' | 'editor' | 'console'

// エディタを「新規作成」で開くか、「既存ラボを読み込んで編集」で開くか
export type EditorTarget = { mode: 'new' } | { mode: 'edit'; labName: string }

interface UiState {
  view: View
  setView: (view: View) => void
  editorTarget: EditorTarget
  // ホームからの入り口。エディタへの画面遷移と「何を開くか」を同時に確定させる
  openEditor: (target: EditorTarget) => void
  // トポロジエディタの右側にコンソールをドッキング表示するかどうか。
  // ConsolePane（内部にxterm.js＋WebSocket接続を持つ）はApp.tsx側に1つだけマウントし、
  // ここのフラグでCSSの見た目（フル画面/ドッキング/非表示）だけを切り替える。
  consolePanelDocked: boolean
  setConsolePanelDocked: (docked: boolean) => void
  // ドッキングパネルの幅（px）。ユーザーがドラッグで調整できるように（2026-10-05追加）
  consolePanelWidth: number
  setConsolePanelWidth: (width: number) => void
}

export const useUiStore = create<UiState>()((set) => ({
  view: 'home',
  setView: (view) => set({ view }),
  editorTarget: { mode: 'new' },
  openEditor: (target) => set({ editorTarget: target, view: 'editor' }),
  consolePanelDocked: false,
  setConsolePanelDocked: (docked) => set({ consolePanelDocked: docked }),
  consolePanelWidth: 440,
  setConsolePanelWidth: (width) => set({ consolePanelWidth: Math.min(900, Math.max(280, width)) }),
}))
