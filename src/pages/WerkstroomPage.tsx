import { useEffect, useMemo, useState } from 'react'
import { TEAMBAK, useTaskInstances } from '../hooks/useTaskInstances'
import { useEmployees } from '../hooks/useEmployees'
import { useTeams } from '../hooks/useTeams'
import { teamLabel } from '../lib/teams'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { useObligationTypes } from '../hooks/useObligationTypes'
import { TaskBlocks } from '../components/TaskBlocks'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { ErrorState } from '../components/ErrorState'
import type { TaskInstanceWithRelations } from '../types'
import {
  VENSTERS,
  typesInWerkstroom,
  vensterTot,
  type IngangDefinitie,
  type VensterKey,
} from '../lib/werkstromen'

/**
 * Eén werkstroom op het scherm — de manier waarop het kantoor werkt.
 *
 * "Ik wil alle btw aangiftes afwerken deze week, dus ik wil enkel de BTW
 * aangiftes zien." Bij ~100 dossiers is één lijst met alles onwerkbaar: je
 * scrolt door honderd regels voor je bij het werk van vandaag komt.
 *
 * Er wordt op deadline gefilterd en niet op periode: het kantoor plant naar de
 * datum waarop iets binnen moet zijn, niet naar het kwartaal waar het over
 * gaat.
 */
export function WerkstroomPage({ ingang }: { ingang: IngangDefinitie }) {
  const { employees } = useEmployees()
  const { teams } = useTeams()
  // Nodig om te weten welke statusstap deze persoon mag zetten; zonder haar
  // blijft de status in de tabel een label in plaats van een knop.
  const { employee } = useCurrentEmployee()
  const { obligationTypes, loading: typesLaden, error: typesFout } = useObligationTypes()
  const [venster, setVenster] = useState<VensterKey>('deze_maand')
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)

  const adhoc = ingang.key === 'adhoc'
  const typeIds = useMemo(
    () =>
      ingang.key === 'adhoc'
        ? []
        : typesInWerkstroom(obligationTypes, ingang.key).map((t) => t.id),
    [obligationTypes, ingang.key]
  )

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
  } = useTaskInstances({
    // Meteen smal beginnen: zonder deze startfilters zou de eerste ronde alle
    // taken van het hele kantoor ophalen voor het scherm weet welke ingang het
    // toont.
    adhocOnly: ingang.key === 'adhoc',
    obligationTypeIds: ingang.key === 'adhoc' ? undefined : [],
    dueTot: vensterTot('deze_maand'),
    // Een werkstroom kent haar verplichtingstypes pas als de catalogus binnen
    // is; ad-hoc heeft die niet nodig en kan meteen door.
    paused: ingang.key !== 'adhoc',
  })

  // De catalogus komt na de eerste render binnen; tot dan is de typelijst leeg
  // en zou het scherm ten onrechte "geen taken" tonen.
  const klaar = adhoc || !typesLaden

  // De ingang en het venster sturen de query. Als sleutel een string, niet de
  // array zelf: de hook herlaadt op elke nieuwe objectreferentie, en dan zou
  // elke render een nieuwe ronde naar de database opleveren.
  const typeIdsSleutel = typeIds.join(',')
  const dueTot = vensterTot(venster)
  useEffect(() => {
    if (!klaar) return
    const ids = adhoc ? undefined : typeIdsSleutel === '' ? [] : typeIdsSleutel.split(',')
    setFilters((f) => {
      // Hetzelfde object teruggeven wanneer er niets veranderde: anders
      // herlaadt de hook op de nieuwe referentie en flikkert het scherm door
      // een tweede, identieke ronde naar de database.
      const zelfdeIds =
        (f.obligationTypeIds === undefined) === (ids === undefined) &&
        (f.obligationTypeIds ?? []).join(',') === (ids ?? []).join(',')
      if (!f.paused && f.adhocOnly === adhoc && zelfdeIds && f.dueTot === dueTot) return f
      return { ...f, adhocOnly: adhoc, obligationTypeIds: ids, dueTot, paused: false }
    })
  }, [klaar, adhoc, typeIdsSleutel, dueTot, setFilters])

  const foutmelding = typesFout ?? error

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">{ingang.label}</h1>
        <p className="text-sm text-slate-500">{ingang.omschrijving}</p>
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="venster">
            Deadlinevenster
          </label>
          <select
            id="venster"
            value={venster}
            onChange={(e) => setVenster(e.target.value as VensterKey)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          >
            {VENSTERS.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="werkstroom-team">
            Team
          </label>
          <select
            id="werkstroom-team"
            value={filters.team ?? 'alle'}
            onChange={(e) => setFilters((f) => ({ ...f, team: e.target.value, pagina: 1 }))}
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
          <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="medewerker">
            Medewerker
          </label>
          <select
            id="medewerker"
            value={filters.toegewezenAan ?? 'alle'}
            onChange={(e) => setFilters((f) => ({ ...f, toegewezenAan: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          >
            <option value="alle">Alle medewerkers</option>
            <option value={TEAMBAK}>Nog niemand (bak van het team)</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.naam}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="zoeken">
            Zoeken
          </label>
          <input
            id="zoeken"
            type="text"
            placeholder="Klant, verplichting…"
            value={filters.zoekterm ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, zoekterm: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          />
        </div>
        {/* Het venster is een einddatum en geen periode. Zonder die uitleg leest
            "Volgende maand" als "alleen volgende maand", en dan lijkt een blok
            van deze maand er ten onrechte bij te staan. */}
        <p className="ml-auto max-w-xs text-xs text-slate-500">
          Elk venster loopt tot en met die datum: “Volgende maand” toont dus ook
          deze maand. Achterstand blijft altijd zichtbaar.
        </p>
      </div>

      {foutmelding ? (
        <ErrorState message={foutmelding} onRetry={reload} />
      ) : loading || !klaar ? (
        // "Laden" moet leesbaar zijn en niet op "je bent klaar" lijken: geen
        // grijstint voor bijzaken, en een role="status" zodat een schermlezer
        // het meekrijgt.
        <p role="status" className="text-sm text-slate-600">
          Taken laden…
        </p>
      ) : (
        <TaskBlocks
          tasks={tasks}
          employees={employees}
          onOpenTask={setOpenTask}
          onBulkReassign={bulkReassign}
          onBulkStatus={bulkUpdateStatus}
          currentEmployee={employee}
          onStatusChange={updateStatus}
          emptyMessage={`Geen ${ingang.label.toLowerCase()}-taken in dit venster.`}
        />
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
