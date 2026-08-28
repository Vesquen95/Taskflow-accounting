import { useState, type FormEvent } from 'react'
import { useEmployees } from '../hooks/useEmployees'
import { ErrorState } from '../components/ErrorState'
import type { EmployeeRol } from '../types'
import { reportError } from '../lib/errorMessage'

/** Medewerkersbeheer (§1/§5/§6, kantoorbeheerder-only): rollen,
 * goedkeuringsrecht, uitnodigen van collega's, en (de)activeren. Het
 * offboarding-blok (§3 punt 6) leeft in de database (trigger) — deze pagina
 * toont gewoon de foutmelding als een deactivatie wordt geweigerd omdat de
 * medewerker nog open taken heeft; herverdelen gebeurt via de Werklijst
 * (bulkactie). */
export function MedewerkersPage() {
  const { employees, loading, error, reload, inviteEmployee, updateEmployee } = useEmployees()
  const [naam, setNaam] = useState('')
  const [email, setEmail] = useState('')
  const [rol, setRol] = useState<EmployeeRol>('medewerker')
  const [magGoedkeuren, setMagGoedkeuren] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleInvite(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!naam.trim() || !email.trim()) {
      setFormError('Naam en e-mailadres zijn verplicht.')
      return
    }
    setSubmitting(true)
    try {
      await inviteEmployee({ naam: naam.trim(), email: email.trim(), rol, mag_goedkeuren: magGoedkeuren })
      setNaam('')
      setEmail('')
      setRol('medewerker')
      setMagGoedkeuren(false)
    } catch (err) {
      setFormError(reportError(err, 'Uitnodigen is mislukt'))
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleActief(id: string, actief: boolean) {
    setRowError(null)
    try {
      await updateEmployee(id, { actief: !actief })
    } catch (err) {
      setRowError(reportError(err, 'Wijzigen is mislukt'))
    }
  }

  async function toggleMagGoedkeuren(id: string, current: boolean) {
    setRowError(null)
    try {
      await updateEmployee(id, { mag_goedkeuren: !current })
    } catch (err) {
      setRowError(reportError(err, 'Wijzigen is mislukt'))
    }
  }

  if (error) {
    return (
      <div className="p-6">
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">Medewerkers</h1>
        <p className="text-sm text-slate-500">Collega's uitnodigen, rollen en goedkeuringsrecht beheren.</p>
      </div>

      <form onSubmit={handleInvite} className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Naam</label>
          <input value={naam} onChange={(e) => setNaam(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">E-mailadres</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Rol</label>
          <select value={rol} onChange={(e) => setRol(e.target.value as EmployeeRol)} className="rounded-md border border-slate-300 px-2 py-1.5">
            <option value="medewerker">Medewerker</option>
            <option value="kantoorbeheerder">Kantoorbeheerder</option>
          </select>
        </div>
        <label className="flex items-center gap-1.5 pb-1.5 text-slate-600">
          <input type="checkbox" checked={magGoedkeuren} onChange={(e) => setMagGoedkeuren(e.target.checked)} />
          Mag goedkeuren
        </label>
        <button type="submit" disabled={submitting} className="rounded-md bg-brand-600 px-4 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
          {submitting ? 'Bezig…' : 'Uitnodigen'}
        </button>
      </form>
      {formError && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {formError}
        </p>
      )}
      {rowError && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {rowError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Naam</th>
                <th className="px-3 py-2">E-mail</th>
                <th className="px-3 py-2">Rol</th>
                <th className="px-3 py-2">Mag goedkeuren</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {employees.map((emp) => (
                <tr key={emp.id}>
                  <td className="px-3 py-2 font-medium text-slate-800">{emp.naam}</td>
                  <td className="px-3 py-2 text-slate-500">{emp.email}</td>
                  <td className="px-3 py-2 text-slate-600">{emp.rol === 'kantoorbeheerder' ? 'Kantoorbeheerder' : 'Medewerker'}</td>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => toggleMagGoedkeuren(emp.id, emp.mag_goedkeuren)} className="text-xs font-medium text-brand-600 hover:text-brand-700">
                      {emp.mag_goedkeuren ? 'Ja — intrekken' : 'Nee — toekennen'}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    {emp.auth_user_id ? (
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                          emp.actief ? 'border-emerald-300 bg-emerald-100 text-emerald-700' : 'border-slate-300 bg-slate-100 text-slate-500'
                        }`}
                      >
                        {emp.actief ? 'Actief' : 'Inactief'}
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full border border-blue-300 bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                        Uitnodiging verstuurd
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {emp.auth_user_id && (
                      <button type="button" onClick={() => toggleActief(emp.id, emp.actief)} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                        {emp.actief ? 'Deactiveren' : 'Activeren'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
