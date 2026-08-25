import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { useAuth } from '../hooks/useAuth'

/** Onboarding (§6): self-serve first-user-becomes-kantoorbeheerder for a
 * brand-new firm, or "claim invite" for a colleague a kantoorbeheerder
 * already pre-registered by email (see supabase/migrations/
 * 0007_onboarding_and_demo_seed.sql for the decision write-up). */
export function OnboardingPage() {
  const { reload } = useCurrentEmployee()
  const { signOut, user } = useAuth()
  const [mode, setMode] = useState<'nieuw' | 'uitnodiging'>('nieuw')
  const [firmNaam, setFirmNaam] = useState('')
  const [medewerkerNaam, setMedewerkerNaam] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleCreateFirm(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const { error: err } = await supabase.rpc('create_firm_and_admin', {
        p_firm_naam: firmNaam,
        p_medewerker_naam: medewerkerNaam,
      })
      if (err) throw err
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kantoor aanmaken is mislukt.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleClaimInvite() {
    setError(null)
    setSubmitting(true)
    try {
      const { error: err } = await supabase.rpc('claim_invite')
      if (err) throw err
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Geen openstaande uitnodiging gevonden voor dit e-mailadres.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold text-slate-900">Welkom bij Taskflow</h1>
        <p className="mb-6 text-sm text-slate-500">
          Ingelogd als <span className="font-medium">{user?.email}</span>. Er is nog geen medewerkersprofiel aan dit account
          gekoppeld.
        </p>

        <div className="mb-4 flex rounded-md bg-slate-100 p-1 text-sm">
          <button
            type="button"
            onClick={() => {
              setMode('nieuw')
              setError(null)
            }}
            className={`flex-1 rounded py-1.5 font-medium transition ${mode === 'nieuw' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
          >
            Nieuw kantoor
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('uitnodiging')
              setError(null)
            }}
            className={`flex-1 rounded py-1.5 font-medium transition ${mode === 'uitnodiging' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
          >
            Ik heb een uitnodiging
          </button>
        </div>

        {mode === 'nieuw' ? (
          <form onSubmit={handleCreateFirm} className="space-y-4">
            <div>
              <label htmlFor="firm-naam" className="mb-1 block text-sm font-medium text-slate-700">
                Naam van het kantoor
              </label>
              <input
                id="firm-naam"
                required
                value={firmNaam}
                onChange={(e) => setFirmNaam(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="medewerker-naam" className="mb-1 block text-sm font-medium text-slate-700">
                Jouw naam
              </label>
              <input
                id="medewerker-naam"
                required
                value={medewerkerNaam}
                onChange={(e) => setMedewerkerNaam(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <p className="text-xs text-slate-400">
              Je wordt automatisch kantoorbeheerder van dit nieuwe kantoor en kan daarna collega's uitnodigen.
            </p>
            {error && (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-60"
            >
              {submitting ? 'Bezig…' : 'Kantoor aanmaken'}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Als een kantoorbeheerder je al heeft uitgenodigd op dit e-mailadres, koppel je jezelf hier aan dat kantoor.
            </p>
            {error && (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            <button
              type="button"
              disabled={submitting}
              onClick={handleClaimInvite}
              className="w-full rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-60"
            >
              {submitting ? 'Bezig…' : 'Uitnodiging accepteren'}
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 text-xs font-medium text-slate-400 hover:text-slate-700"
        >
          Uitloggen
        </button>
      </div>
    </div>
  )
}
