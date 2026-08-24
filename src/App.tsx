import { AuthProvider, useAuth } from './hooks/useAuth'
import { AuthPage } from './pages/AuthPage'
import { Board } from './components/Board'

function AppShell() {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-400">Laden…</p>
      </div>
    )
  }

  return session ? <Board /> : <AuthPage />
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
