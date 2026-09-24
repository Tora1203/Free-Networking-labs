// ログイン状態のグローバル管理（2026-09-16決定: 状態管理はZustandを採用、docs/direction.md参照）。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { ApiError, login as apiLogin, setAuthToken, setUnauthorizedHandler } from '../api/client'

interface AuthState {
  token: string | null
  username: string | null
  isAuthenticating: boolean
  error: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => {
      // トークン切れ(401)を検知したら自動的にログアウト状態に戻す（api-contract.mdの通りリフレッシュ手段は無い）
      setUnauthorizedHandler(() => set({ token: null, username: null }))

      return {
        token: null,
        username: null,
        isAuthenticating: false,
        error: null,
        login: async (username, password) => {
          set({ isAuthenticating: true, error: null })
          try {
            const { token } = await apiLogin(username, password)
            setAuthToken(token)
            set({ token, username, isAuthenticating: false })
          } catch (e) {
            const message = e instanceof ApiError ? e.message : 'ログインに失敗しました'
            set({ isAuthenticating: false, error: message })
            throw e
          }
        },
        logout: () => {
          setAuthToken(null)
          set({ token: null, username: null, error: null })
        },
      }
    },
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token, username: state.username }),
      onRehydrateStorage: () => (state) => {
        // localStorageから復元したトークンをAPIクライアントにも反映する
        if (state?.token) setAuthToken(state.token)
      },
    },
  ),
)
