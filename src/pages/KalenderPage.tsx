import { useEffect, useMemo, useState } from 'react'
import { TEAMBAK, useTaskInstances } from '../hooks/useTaskInstances'
import { useEmployees } from '../hooks/useEmployees'
import { useTeams } from '../hooks/useTeams'
import { teamLabel } from '../lib/teams'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { StatusBadge } from '../components/StatusBadge'
import { UrgencyBadge } from '../components/UrgencyBadge'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'
import { Paginering } from '../components/Paginering'
import { formatDate } from '../lib/urgency'
import { isoDatum } from '../lib/werkstromen'
import type { TaskInstanceWithRelations } from '../types'

/** Eén schijf van de kalender. Bij ~100 dossiers loopt de horizon van 36
 *  maanden in de duizenden rijen; 50 is wat het kantoor in één scherm
 *  overziet, en het is meteen de bovengrens van wat de query ophaalt. */
const PAGINA_GROOTTE = 50

function taakWoord(aantal: number): string {
  return aantal === 1 ? 'taak' : 'taken'
}

/**
 * Kalender-/tijdlijnweergave (§4 point 4), sinds augustus 2026 het
 * hoofdscherm: dit is waar je binnenkomt.
 *
 * Bewust een lijst per maand en geen volledig maand-/weekraster — die keuze
 * uit v1 blijft staan: ze beantwoordt "hoeveel deadlines stapelen zich in
 * welke maand op, en bij wie" zonder de complexiteit van een kalenderraster.
 *
 * De status is hier een **label** en geen knop (docs/PLAN.md §4, beslist met
 * het kantoor). Dat verandert niet nu dit het eerste scherm is: je kijkt hier
 * naar de spreiding van deadlines, je werkt ze af in de werkstromen. Wie hier
 * toch iets wil wijzigen, opent de taak.
 *
 * Twee dingen die dit scherm expliciet moet maken:
 *   1. Er staan 50 taken op een pagina, en het totaal komt uit de databank
 *      (count: 'exact'). Een teller die de opgehaalde rijen telt, laat een
 *      afgekapte lijst als een volledige lijst lezen.
 *   2. Het scherm begint bij vandaag. Met honderd dossiers loopt de
 *      achterstand maanden terug, en wie binnenkomt op de oudste maand moet
 *      eerst een handvol pagina's vooruit klikken voor hij ziet wat er deze
 *      week moet. Het vinkje staat dus standaard AAN.
 *
 *      Verbergen mag, stil verbergen niet: zolang er achterstand is, staat er
 *      een rode balk met het aantal en één klik om ze alsnog te tonen. Een
 *      gemiste wettelijke deadline verdwijnt niet uit beeld — ze verhuist naar
 *      een melding die je niet kunt missen.
 */
export function KalenderPage() {
  const { employees } = useEmployees()
  const { teams } = useTeams()
  // Eén keer per mount: de kalender hoort niet van datum te wisselen terwijl
  // je erin bladert.
  const vandaag = useMemo(() => isoDatum(new Date()), [])
  const {
    tasks,
    totaal,
    achterstandAantal,
    loading,
    error,
    filters,
    setFilters,
    reload,
    updateStatus,
    updateDueDate,
    reassign,
    markReviewHandled,
  } = useTaskInstances({
    pagina: 1,
    paginaGrootte: PAGINA_GROOTTE,
    telAchterstandVoor: vandaag,
    // Beginnen bij vandaag. De achterstand blijft geteld en staat bovenaan in
    // de rode balk; ze is één klik weg, niet weggemoffeld.
    dueVanaf: vandaag,
  })
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)

  const pagina = filters.pagina ?? 1
  // Geen tweede stukje state naast de filters: de ondergrens in de query ís de
  // stand van het vinkje. Zo kan het scherm niet iets anders beweren dan wat
  // het ophaalde.
  const achterstandVerborgen = filters.dueVanaf !== undefined
  const achterstand = achterstandAantal ?? 0

  function zetPagina(nieuwe: number) {
    setFilters((f) => ({ ...f, pagina: nieuwe }))
  }

  function zetAchterstandVerborgen(verbergen: boolean) {
    // Terug naar pagina 1: na het weglaten van de achterstand betekent
    // "pagina 3" iets anders dan ervoor.
    setFilters((f) => ({ ...f, dueVanaf: verbergen ? vandaag : undefined, pagina: 1 }))
  }

  // De lijst kan onder je voeten krimpen — een collega werkt taken af, of het
  // vinkje haalt de achterstand weg. Sta je dan op een pagina die niet meer
  // bestaat, dan is een lege pagina zonder uitweg het slechtste antwoord.
  useEffect(() => {
    if (!loading && !error && tasks.length === 0 && pagina > 1) {
      setFilters((f) => ({ ...f, pagina: 1 }))
    }
  }, [loading, error, tasks.length, pagina, setFilters])

  const grouped = useMemo(() => {
    const map = new Map<string, TaskInstanceWithRelations[]>()
    for (const t of tasks) {
      const key = t.due_date.slice(0, 7) // YYYY-MM
      const list = map.get(key) ?? []
      list.push(t)
      map.set(key, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [tasks])

  // Een maandblok mag over een paginagrens vallen. Het eerste en het laatste
  // blok van een pagina kunnen dus doorlopen; hun teller gaat enkel over deze
  // pagina en moet dat ook zeggen.
  const heeftVolgende = totaal === null ? tasks.length === PAGINA_GROOTTE : pagina * PAGINA_GROOTTE < totaal
  const blokLooptDoor = (index: number) =>
    (index === 0 && pagina > 1) || (index === grouped.length - 1 && heeftVolgende)

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Kalender</h1>
          <p className="text-sm text-slate-500">Deadline-dichtheid per maand, kantoorbreed of per medewerker.</p>
          {achterstand > 0 && (
            <p className="mt-1 text-sm font-semibold text-red-700">
              {achterstand} {taakWoord(achterstand)} te laat
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={achterstandVerborgen}
              onChange={(e) => zetAchterstandVerborgen(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Te late taken uit het verleden verbergen
          </label>
          <select
            aria-label="Team"
            value={filters.team ?? 'alle'}
            onChange={(e) => setFilters((f) => ({ ...f, team: e.target.value, pagina: 1 }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="alle">Alle teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {teamLabel(t)}
              </option>
            ))}
          </select>
          <select
            aria-label="Medewerker"
            value={filters.toegewezenAan ?? 'alle'}
            onChange={(e) => setFilters((f) => ({ ...f, toegewezenAan: e.target.value, pagina: 1 }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="alle">Kantoorbreed</option>
            <option value={TEAMBAK}>Nog niemand</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.naam}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Verbergen mag, stil verbergen niet. Deze melding staat er zolang het
          vinkje aan staat, met het aantal erbij en één klik terug. */}
      {achterstandVerborgen && achterstand > 0 && (
        <div
          role="status"
          aria-label="Verborgen achterstand"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-2"
        >
          <span className="text-sm font-medium text-red-800">
            {achterstand} te late {taakWoord(achterstand)} verborgen
          </span>
          <button
            type="button"
            onClick={() => zetAchterstandVerborgen(false)}
            className="rounded-md border border-red-300 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100"
          >
            Toon ze weer
          </button>
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        // Leesbaar en aankondigbaar: "Laden" mag niet op "je bent klaar"
        // lijken, en een schermlezer hoort het mee te krijgen.
        <p role="status" className="text-sm text-slate-600">
          Taken laden…
        </p>
      ) : grouped.length === 0 ? (
        // Vroeger "Geen taken binnen bereik" — maar er is op dit scherm geen
        // bereik te zien dat je kan verruimen. Als eerste scherm na het
        // inloggen moet de lege stand zeggen wat ze betekent en waar het werk
        // dan wél staat.
        <EmptyState
          title={
            achterstandVerborgen
              ? 'Geen openstaande taken vanaf vandaag.'
              : filters.toegewezenAan && filters.toegewezenAan !== 'alle'
                ? 'Geen openstaande taken voor deze medewerker.'
                : 'Geen openstaande taken.'
          }
          description="Afgewerkte en geannuleerde taken staan niet in de kalender; die vind je in het klantdossier."
        />
      ) : (
        <>
          <Paginering
            pagina={pagina}
            paginaGrootte={PAGINA_GROOTTE}
            aantalOpPagina={tasks.length}
            totaal={totaal}
            onPagina={zetPagina}
          />
          <div className="space-y-4">
            {grouped.map(([month, monthTasks], index) => (
              <div key={month} className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
                  <h2 className="text-sm font-semibold text-slate-800">
                    {new Date(`${month}-01T00:00:00`).toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' })}
                  </h2>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                    {monthTasks.length} {taakWoord(monthTasks.length)}
                    {blokLooptDoor(index) ? ' op deze pagina' : ''}
                  </span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {monthTasks.map((t) => (
                    <li key={t.id} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-slate-50" onClick={() => setOpenTask(t)}>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="w-16 shrink-0 text-slate-400">{formatDate(t.due_date)}</span>
                        <span className="truncate font-medium text-slate-800">{t.client?.naam}</span>
                        <span className="truncate text-slate-500">{t.obligation_type?.naam ?? t.title}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <UrgencyBadge dueDate={t.due_date} status={t.status} categorie={t.obligation_type?.categorie} />
                        <StatusBadge status={t.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
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
