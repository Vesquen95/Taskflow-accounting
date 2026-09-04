import { useMemo, useState } from 'react'
import { useTaskInstances } from '../hooks/useTaskInstances'
import { useEmployees } from '../hooks/useEmployees'
import { useTeams } from '../hooks/useTeams'
import { teamLabel } from '../lib/teams'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { TaskBlocks } from '../components/TaskBlocks'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'
import type { TaskInstanceWithRelations } from '../types'

/**
 * Wat op jouw goedkeuring wacht.
 *
 * Dit scherm bestaat omdat het weekoverzicht (migratie 0043) een getal
 * noemde waar niemand naartoe kon klikken: negenentwintig aangiftes die op
 * één partner stonden te wachten, waarvan de oudste van maart. Ze waren niet
 * verborgen -- ze stonden gewoon verspreid over zes werkstromen, elk achter
 * een deadlinevenster, herkenbaar aan een paarse badge. Wie ze wilde vinden,
 * moest weten dat hij ze zocht.
 *
 * Drie keuzes die dit scherm anders maken dan een werkstroom:
 *
 *  1. GEEN deadlinevenster. Elders is het venster een planinstrument; hier
 *     zou het werk verstoppen. Een aangifte die sinds maart op goedkeuring
 *     wacht, hoort in het scherm te staan dat over goedkeuren gaat, ook in
 *     september.
 *  2. Twee lijsten, niet één. Wat collega's indienden is werk voor jou; wat
 *     je zelf indiende, kun je technisch goedkeuren maar dan keur je je eigen
 *     werk goed. Dat mag (het four-eyes-principe is hier een waarschuwing,
 *     geen slot -- §7 beslissing 3), maar het hoort niet stilletjes tussen de
 *     rest te staan.
 *  3. De tweede lijst staat ONDER de eerste en is niet weg te klikken. Werk
 *     verbergen achter een schakelaar is precies hoe die negenentwintig
 *     ontstonden.
 */
export function GoedkeuringPage() {
  const { employees } = useEmployees()
  const { teams } = useTeams()
  const { employee } = useCurrentEmployee()
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)

  const {
    tasks,
    loading,
    error,
    filters,
    setFilters,
    reload,
    updateStatus,
    updateDueDate,
    reassign,
    bulkReassign,
    bulkUpdateStatus,
    markReviewHandled,
  } = useTaskInstances({ statussen: ['wacht_op_goedkeuring'] })

  // Wat je zelf indiende staat apart. De splitsing gebeurt hier en niet in de
  // query: het zijn twee lijsten uit dezelfde ronde, en een tweede query zou
  // ze op verschillende momenten kunnen ophalen.
  const { vanCollegas, vanJezelf } = useMemo(() => {
    const mijn: TaskInstanceWithRelations[] = []
    const anderen: TaskInstanceWithRelations[] = []
    for (const taak of tasks) {
      if (employee && taak.toegewezen_medewerker_id === employee.id) mijn.push(taak)
      else anderen.push(taak)
    }
    return { vanCollegas: anderen, vanJezelf: mijn }
  }, [tasks, employee])

  const gedeeld = {
    employees,
    onOpenTask: setOpenTask,
    onBulkReassign: bulkReassign,
    onBulkStatus: bulkUpdateStatus,
    currentEmployee: employee,
    onStatusChange: updateStatus,
  }

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">Goedkeuren</h1>
        <p className="text-sm text-slate-500">
          Alles wat op een goedkeuring wacht, zonder deadlinevenster — ook wat al
          maanden blijft staan.
        </p>
      </div>

      {/* Geen venster in deze balk, met opzet: zie de toelichting bovenaan. */}
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="goedkeuring-team">
            Team
          </label>
          <select
            id="goedkeuring-team"
            value={filters.team ?? 'alle'}
            onChange={(e) => setFilters((f) => ({ ...f, team: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          >
            <option value="alle">Alle teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {teamLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="goedkeuring-medewerker">
            Ingediend door
          </label>
          <select
            id="goedkeuring-medewerker"
            value={filters.toegewezenAan ?? 'alle'}
            onChange={(e) => setFilters((f) => ({ ...f, toegewezenAan: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          >
            <option value="alle">Iedereen</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.naam}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="goedkeuring-zoeken">
            Zoeken
          </label>
          <input
            id="goedkeuring-zoeken"
            type="text"
            placeholder="Klant, verplichting…"
            value={filters.zoekterm ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, zoekterm: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          />
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p role="status" className="text-sm text-slate-600">
          Taken laden…
        </p>
      ) : tasks.length === 0 ? (
        <EmptyState title="Er wacht niets op je goedkeuring." />
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              Ingediend door collega's{' '}
              <span className="font-normal text-slate-500">({vanCollegas.length})</span>
            </h2>
            {vanCollegas.length === 0 ? (
              <EmptyState title="Niets van collega's op dit moment." />
            ) : (
              <TaskBlocks {...gedeeld} tasks={vanCollegas} />
            )}
          </section>

          {vanJezelf.length > 0 && (
            <section>
              <h2 className="mb-1 text-sm font-semibold text-slate-900">
                Door jou ingediend{' '}
                <span className="font-normal text-slate-500">({vanJezelf.length})</span>
              </h2>
              {/* De waarschuwing staat boven de lijst en niet pas in het detail:
                  wie hier in bulk goedkeurt, opent geen enkele taak. */}
              <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Deze taken staan op jouw naam. Je kunt ze goedkeuren, maar dan ben je
                zowel de verantwoordelijke als de goedkeurder — het four-eyes-principe
                is dan niet gerespecteerd.
              </p>
              <TaskBlocks {...gedeeld} tasks={vanJezelf} />
            </section>
          )}
        </div>
      )}

      {openTask && (
        <TaskDetailModal
          task={openTask}
          employees={employees}
          onClose={() => setOpenTask(null)}
          onStatusChange={updateStatus}
          onReassign={reassign}
          onMarkReviewHandled={markReviewHandled}
          onDueDateChange={updateDueDate}
        />
      )}
    </div>
  )
}
