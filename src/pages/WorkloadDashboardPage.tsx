import { useMemo } from 'react'
import { useTaskInstances } from '../hooks/useTaskInstances'
import { useEmployees } from '../hooks/useEmployees'
import { ErrorState } from '../components/ErrorState'
import { daysUntil } from '../lib/urgency'

/** Workload-dashboard (§4 point 6, kantoorbeheerder/partner): capaciteit
 * per medewerker, aantal te laat, verwacht volume. */
export function WorkloadDashboardPage() {
  const { employees } = useEmployees()
  const { tasks, loading, error, reload } = useTaskInstances({})

  const rows = useMemo(() => {
    return employees
      .filter((e) => e.actief)
      .map((emp) => {
        const own = tasks.filter((t) => t.toegewezen_medewerker_id === emp.id)
        const overdue = own.filter((t) => daysUntil(t.due_date) < 0).length
        const dueThisWeek = own.filter((t) => {
          const d = daysUntil(t.due_date)
          return d >= 0 && d <= 7
        }).length
        const dueThisMonth = own.filter((t) => {
          const d = daysUntil(t.due_date)
          return d >= 0 && d <= 31
        }).length
        const wachtOpGoedkeuring = own.filter((t) => t.status === 'wacht_op_goedkeuring').length
        return { emp, total: own.length, overdue, dueThisWeek, dueThisMonth, wachtOpGoedkeuring }
      })
      .sort((a, b) => b.overdue - a.overdue || b.total - a.total)
  }, [employees, tasks])

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">Workload-dashboard</h1>
        <p className="text-sm text-slate-500">Capaciteit en achterstand per medewerker, kantoorbreed.</p>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Medewerker</th>
                <th className="px-3 py-2">Open taken</th>
                <th className="px-3 py-2">Te laat</th>
                <th className="px-3 py-2">Binnen 7 dagen</th>
                <th className="px-3 py-2">Binnen 31 dagen</th>
                <th className="px-3 py-2">Wacht op goedkeuring</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ emp, total, overdue, dueThisWeek, dueThisMonth, wachtOpGoedkeuring }) => (
                <tr key={emp.id}>
                  <td className="px-3 py-2 font-medium text-slate-800">{emp.naam}</td>
                  <td className="px-3 py-2 text-slate-600">{total}</td>
                  <td className={`px-3 py-2 font-semibold ${overdue > 0 ? 'text-red-600' : 'text-slate-400'}`}>{overdue}</td>
                  <td className="px-3 py-2 text-slate-600">{dueThisWeek}</td>
                  <td className="px-3 py-2 text-slate-600">{dueThisMonth}</td>
                  <td className="px-3 py-2 text-slate-600">{wachtOpGoedkeuring}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                    Geen actieve medewerkers.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
