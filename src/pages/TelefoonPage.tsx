import { useMemo, useState } from 'react'
import { useTaskInstances } from '../hooks/useTaskInstances'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { useEmployees } from '../hooks/useEmployees'
import { TaakKaart } from '../components/TaakKaart'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'
import { Paginering } from '../components/Paginering'
import { isoDatum, vensterTot } from '../lib/werkstromen'
import type { TaskInstanceWithRelations } from '../types'

/** Ruim genoeg voor een maand vooruit, en tegelijk de bovengrens van wat de
 *  query ophaalt. Op een telefoonverbinding is een onbegrensde lijst geen
 *  lijst maar een wachttijd. */
const PAGINA_GROOTTE = 50

/**
 * Het werkscherm op een telefoon.
 *
 * Dit is geen ingekrompen kalender maar een ander scherm, voor de twee dingen
 * die het kantoor onderweg doet: opzoeken wanneer iets moet, en een status
 * verzetten. Alles wat daar niet bij hoort -- bulkacties, toewijzen, de
 * werklastverdeling -- staat achter het menu en niet in de weg.
 *
 * Drie keuzes die het scherm sturen:
 *
 *  1. De lijst loopt tot het einde van deze week, met één tik tot het einde
 *     van de maand. Verder vooruit kijken doe je aan een bureau; hier gaat het
 *     over wat er nú op je afkomt.
 *
 *  2. Wat te laat is staat altijd bovenaan en valt nooit weg te filteren. Dat
 *     is dezelfde regel als in de werkstromen: een gemiste wettelijke deadline
 *     verdwijnt niet uit beeld omdat het scherm klein is.
 *
 *  3. Zoeken laat het deadlinevenster los. "Wanneer valt de AV van klant X?"
 *     is precies de vraag die je op een telefoon stelt, en het antwoord ligt
 *     bijna nooit binnen deze week.
 */
export function TelefoonPage() {
  const { employee } = useCurrentEmployee()
  // Ook al wijs je op een telefoon zelden iets toe: het detailvenster toont een
  // keuzelijst met verantwoordelijken, en die leeg meegeven levert een
  // besturingselement op dat kapot lijkt.
  const { employees } = useEmployees()
  const vandaag = useMemo(() => isoDatum(new Date()), [])
  const eindeWeek = useMemo(() => vensterTot('deze_week'), [])
  // Bewust een rollende horizon en niet "deze maand". Op 31 augustus loopt
  // "deze maand" tot vandaag: het venster is dan leeg terwijl het eerste werk
  // twee weken verderop staat. Dat viel bij het uitproberen op een telefoon
  // meteen op -- twee lege vensters na elkaar, en geen enkele aanwijzing dat
  // er wel degelijk taken aankomen. Dertig dagen vooruit kent die kuil niet.
  const dertigDagen = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + 30)
    return isoDatum(d)
  }, [])

  const [ruimVenster, setRuimVenster] = useState(false)
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)
  const [statusFout, setStatusFout] = useState<string | null>(null)

  const {
    tasks,
    totaal,
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
    dueTot: eindeWeek,
  })

  const zoekterm = filters.zoekterm ?? ''
  const zoekt = zoekterm.trim().length > 0
  const pagina = filters.pagina ?? 1
  const alleenVanMij = filters.toegewezenAan !== undefined && filters.toegewezenAan !== 'alle'

  function zetVenster(ruim: boolean) {
    setRuimVenster(ruim)
    setFilters((f) => ({ ...f, dueTot: ruim ? dertigDagen : eindeWeek, pagina: 1 }))
  }

  function zetZoekterm(term: string) {
    // Zoeken kijkt over het hele dossier, niet enkel in deze week: anders
    // levert "AV" van een klant met een boekjaar in juni niets op en lijkt de
    // taak te ontbreken.
    const zoektNu = term.trim().length > 0
    setFilters((f) => ({
      ...f,
      zoekterm: term,
      dueTot: zoektNu ? undefined : ruimVenster ? dertigDagen : eindeWeek,
      pagina: 1,
    }))
  }

  function zetAlleenVanMij(aan: boolean) {
    setFilters((f) => ({ ...f, toegewezenAan: aan && employee ? employee.id : 'alle', pagina: 1 }))
  }

  // Groeperen op wat je eerst moet weten. Bij het zoeken vervalt die indeling:
  // dan is de vraag "waar staat deze taak", niet "wanneer moet ze".
  const groepen = useMemo(() => {
    if (zoekt) return [{ id: 'resultaten', titel: 'Resultaten', dringend: false, taken: tasks }]
    const teLaat: TaskInstanceWithRelations[] = []
    const nu: TaskInstanceWithRelations[] = []
    const week: TaskInstanceWithRelations[] = []
    const later: TaskInstanceWithRelations[] = []
    for (const taak of tasks) {
      if (taak.due_date < vandaag) teLaat.push(taak)
      else if (taak.due_date === vandaag) nu.push(taak)
      else if (eindeWeek && taak.due_date <= eindeWeek) week.push(taak)
      else later.push(taak)
    }
    return [
      { id: 'te-laat', titel: 'Te laat', dringend: true, taken: teLaat },
      { id: 'vandaag', titel: 'Vandaag', dringend: false, taken: nu },
      { id: 'week', titel: 'Deze week', dringend: false, taken: week },
      { id: 'later', titel: 'Later', dringend: false, taken: later },
    ].filter((groep) => groep.taken.length > 0)
  }, [tasks, zoekt, vandaag, eindeWeek])

  const knopKlasse = (actief: boolean) =>
    `rounded-full border px-3 py-1.5 text-sm font-medium transition ${
      actief
        ? 'border-brand-600 bg-brand-600 text-white'
        : 'border-slate-300 bg-white text-slate-700'
    }`

  return (
    <div className="p-4">
      <div className="mb-3 space-y-3">
        <input
          type="search"
          value={zoekterm}
          onChange={(e) => zetZoekterm(e.target.value)}
          placeholder="Zoek een klant of verplichting…"
          aria-label="Zoeken"
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => zetVenster(false)} className={knopKlasse(!ruimVenster)}>
            Deze week
          </button>
          <button type="button" onClick={() => zetVenster(true)} className={knopKlasse(ruimVenster)}>
            30 dagen
          </button>
          <button
            type="button"
            onClick={() => zetAlleenVanMij(!alleenVanMij)}
            aria-pressed={alleenVanMij}
            className={knopKlasse(alleenVanMij)}
          >
            Van mij
          </button>
        </div>
        {zoekt && (
          // Anders lijkt het venster stuk: je zoekt binnen deze week en krijgt
          // een taak van volgend jaar terug.
          <p className="text-xs text-slate-500">
            Zoeken kijkt over alle deadlines heen, niet enkel binnen het gekozen venster.
          </p>
        )}
      </div>

      {statusFout && (
        <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {statusFout}
        </p>
      )}

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p role="status" className="text-sm text-slate-600">
          Taken laden…
        </p>
      ) : groepen.length === 0 ? (
        // Een lege lijst mag geen doodlopend eind zijn. Bij het testen stond
        // hier "Niets te doen" terwijl er vier taken later die maand
        // openstonden -- waar en toch misleidend. Wie niets ziet, hoort te
        // weten waar hij verder moet kijken.
        <div className="space-y-3">
          <EmptyState
            title={
              zoekt
                ? 'Niets gevonden voor deze zoekterm.'
                : ruimVenster
                  ? 'Niets te doen in de komende 30 dagen.'
                  : 'Niets te doen deze week.'
            }
          />
          {!zoekt && !ruimVenster && (
            <button
              type="button"
              onClick={() => zetVenster(true)}
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700"
            >
              Kijk 30 dagen vooruit
            </button>
          )}
          {!zoekt && ruimVenster && (
            <p className="text-center text-sm text-slate-500">
              Verder vooruit kijken doe je in een werkstroom, via het menu.
            </p>
          )}
          {!zoekt && alleenVanMij && (
            // Het filter staat aan en verbergt dan misschien juist het werk
            // dat er wel is. Dat hoort het scherm zelf te zeggen.
            <button
              type="button"
              onClick={() => zetAlleenVanMij(false)}
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700"
            >
              Toon ook de taken van collega's
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Past alles op één pagina, dan is een balk die "Taken 1-4 van 4"
              zegt een regel die niets toevoegt. Op een telefoon telt elke
              regel; zodra er wel geblader is, staat ze er weer. */}
          {(totaal === null || totaal > PAGINA_GROOTTE) && (
            <Paginering
              pagina={pagina}
              paginaGrootte={PAGINA_GROOTTE}
              aantalOpPagina={tasks.length}
              totaal={totaal}
              onPagina={(nieuwe) => setFilters((f) => ({ ...f, pagina: nieuwe }))}
            />
          )}
          <div className="space-y-4">
            {groepen.map((groep) => (
              <section key={groep.id}>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <h2
                    className={`text-sm font-semibold ${groep.dringend ? 'text-red-700' : 'text-slate-800'}`}
                  >
                    {groep.titel}
                  </h2>
                  <span className="text-xs text-slate-500">{groep.taken.length}</span>
                </div>
                <ul className="space-y-2">
                  {groep.taken.map((taak) => (
                    <TaakKaart
                      key={taak.id}
                      task={taak}
                      onOpen={setOpenTask}
                      currentEmployee={employee}
                      onStatusChange={updateStatus}
                      onStatusFout={setStatusFout}
                    />
                  ))}
                </ul>
              </section>
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
