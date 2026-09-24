import { useState } from 'react'
import { useAuthStore } from '../store/authStore'
import './LoginForm.css'

export default function LoginForm() {
  const login = useAuthStore((s) => s.login)
  const isAuthenticating = useAuthStore((s) => s.isAuthenticating)
  const error = useAuthStore((s) => s.error)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    login(username, password).catch(() => {
      // エラーメッセージは authStore 側の state に入るのでここでは握りつぶす
    })
  }

  return (
    <div className="login-form">
      <form className="login-form__card" onSubmit={onSubmit}>
        <h1>ログイン</h1>
        <p className="login-form__hint">
          Linuxアカウント（clab_api / clab_admins グループ）でログインしてください
        </p>
        <label className="login-form__field">
          ユーザー名
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="login-form__field">
          パスワード
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="login-form__error">{error}</p>}
        <button type="submit" disabled={isAuthenticating}>
          {isAuthenticating ? 'ログイン中...' : 'ログイン'}
        </button>
      </form>
    </div>
  )
}
