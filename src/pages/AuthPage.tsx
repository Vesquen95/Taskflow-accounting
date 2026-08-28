import { useState, type FormEvent } from 'react'
import { useAuth } from '../hooks/useAuth'

export function AuthPage() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setSubmitting(true)
    try {
      if (mode === 'signin') {
        const { error: err } = await signIn(email, password)
        if (err) setError(err)
      } else {
        const { error: err } = await signUp(email, password)
        if (err) {
          setError(err)
        } else {
          setInfo('Account aangemaakt. Check je e-mail als bevestiging vereist is, of log direct in.')
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        {/* Dit is het eerste dat je ziet, dus staat het merk hier ruim en
            alleen. Taskflow zelf is een gereedschap, geen merk: de naam mag
            eronder in het klein. */}
        <div className="mb-8">
          <img src={`${import.meta.env.BASE_URL}rsm-logo.svg`} alt="RSM" className="h-9 w-auto" />
          <h1 className="mt-3 text-lg font-semibold text-slate-900">Taskflow</h1>
          <p className="text-sm text-slate-500">Opvolging van termijnen en verplichtingen.</p>
        </div>

        <div className="mb-6 flex rounded-md bg-slate-100 p-1 text-sm">
          <button
            type="button"
            onClick={() => {
              setMode('signin')
              setError(null)
              setInfo(null)
            }}
            className={`flex-1 rounded py-1.5 font-medium transition ${
              mode === 'signin' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'
            }`}
          >
            Inloggen
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('signup')
              setError(null)
              setInfo(null)
            }}
            className={`flex-1 rounded py-1.5 font-medium transition ${
              mode === 'signup' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'
            }`}
          >
            Registreren
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">
              E-mailadres
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700">
              Wachtwoord
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          {info && (
            <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {info}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {submitting ? 'Bezig…' : mode === 'signin' ? 'Inloggen' : 'Account aanmaken'}
          </button>
        </form>
      </div>
    </div>
  )
}
