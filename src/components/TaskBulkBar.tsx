import { useState } from 'react'
import type { Employee, TaskInstanceWithRelations, TaskStatus } from '../types'
import type { BulkResultaat } from '../lib/bulkActie'
import { reportError } from '../lib/errorMessage'
import { taakOmschrijving } from '../lib/taakLabel'
import { bulkStatusUitleg, gemeenschappelijkeBulkStatussen, STATUS_LABEL, statusContext } from '../lib/taskStatus'

interface TaskBulkBarProps {
  /** De aangevinkte taken, in lijstvolgorde. */
  geselecteerd: TaskInstanceWithRelations[]
  employees: Employee[]
  /** Bepaalt mee welke statusstap mag (`mag_goedkeuren`). */
  currentEmployee?: Employee | null
  onBulkReassign?: (taskIds: string[], employeeId: string) => Promise<BulkResultaat>
  onBulkStatus?: (taskIds: string[], status: TaskStatus) => Promise<BulkResultaat>
  /**
   * Wat er na de actie nog aangevinkt blijft: enkel de taken die niet
   * doorgingen. Zo staat de selectie klaar voor een tweede poging in plaats
   * van dat het kantoor ze uit het verslag moet terugzoeken.
   */
  onNaActie: (nogGeselecteerd: string[]) => void
}

interface MislukteTaak {
  /** De omschrijving op het moment van de actie — de rij kan intussen weg zijn. */
  label: string
  reden: string
}

interface BulkVerslag {
  samenvatting: string
  mislukt: MislukteTaak[]
  /** De actie zelf liep stuk (netwerk/onverwacht): er is niets toegepast. */
  volledigMislukt: boolean
}

/** Eén regel per reden, met de taken erbij: tientallen taken falen meestal om dezelfde reden. */
function groepeerPerReden(mislukt: MislukteTaak[]): Array<{ reden: string; labels: string[] }> {
  const groepen = new Map<string, string[]>()
  for (const taak of mislukt) {
    const bestaand = groepen.get(taak.reden)
    if (bestaand) bestaand.push(taak.label)
    else groepen.set(taak.reden, [taak.label])
  }
  return Array.from(groepen, ([reden, labels]) => ({ reden, labels }))
}

/**
 * De bulkbalk boven de takenlijst, plus het verslag van de laatste bulkactie.
 *
 * Twee beloften, allebei uit dezelfde bron als de statusbediening per taak
 * (src/lib/taskStatus.ts):
 *  1. de keuzelijst "Zet status op" bevat enkel statussen die op élke
 *     geselecteerde taak toegelaten zijn — een bulkupdate is één statement,
 *     dus één geweigerde rij betekent dat er niets gebeurt;
 *  2. na afloop staat er per taak op het scherm wat er gebeurd is. Ook een
 *     correcte lijst kan namelijk nog geweigerd worden: een collega kan de
 *     taak intussen verzet hebben.
 *
 * Het verslag blijft staan nadat de selectie leeggemaakt is; daarom staat de
 * balk en het verslag in één component en niet in de selectiebranche van
 * TaskTable.
 */
export function TaskBulkBar({
  geselecteerd,
  employees,
  currentEmployee,
  onBulkReassign,
  onBulkStatus,
  onNaActie,
}: TaskBulkBarProps) {
  const [verslag, setVerslag] = useState<BulkVerslag | null>(null)
  const [busy, setBusy] = useState(false)

  const ids = geselecteerd.map((t) => t.id)
  const contexten = geselecteerd.map((t) => statusContext(t, currentEmployee))
  const statussen = gemeenschappelijkeBulkStatussen(contexten)

  async function verwerk(
    uitvoeren: () => Promise<BulkResultaat>,
    samenvatting: (aantalGelukt: number, totaal: number) => string
  ) {
    // De omschrijvingen nu vastleggen: na het herladen kan een taak uit deze
    // lijst verdwenen zijn (ze voldoet niet meer aan de filters).
    const labels = new Map(geselecteerd.map((t) => [t.id, taakOmschrijving(t)]))
    const totaal = ids.length
    setBusy(true)
    setVerslag(null)
    try {
      const resultaat = await uitvoeren()
      setVerslag({
        samenvatting: samenvatting(resultaat.gelukt.length, totaal),
        mislukt: resultaat.mislukt.map((fout) => ({
          label: labels.get(fout.taskId) ?? fout.taskId,
          reden: fout.reden,
        })),
        volledigMislukt: false,
      })
      onNaActie(resultaat.mislukt.map((fout) => fout.taskId))
    } catch (err) {
      setVerslag({
        samenvatting: reportError(err, 'De bulkactie is niet uitgevoerd'),
        mislukt: [],
        volledigMislukt: true,
      })
      // Niets doorgegaan: de selectie blijft staan voor een tweede poging.
      onNaActie(ids)
    } finally {
      setBusy(false)
    }
  }

  const heeftFouten = verslag !== null && (verslag.volledigMislukt || verslag.mislukt.length > 0)

  return (
    <>
      {verslag && (
        <div
          role={heeftFouten ? 'alert' : 'status'}
          className={`border-b px-4 py-2 text-sm ${
            heeftFouten ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <p>{verslag.samenvatting}</p>
            <button
              type="button"
              onClick={() => setVerslag(null)}
              className="shrink-0 text-xs underline"
              aria-label="Verslag sluiten"
            >
              Sluiten
            </button>
          </div>
          {verslag.mislukt.length > 0 && (
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-xs">
              {groepeerPerReden(verslag.mislukt).map((groep) => (
                <li key={groep.reden}>
                  <span className="font-medium">{groep.reden}</span>
                  <span className="text-amber-800"> — {groep.labels.join('; ')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {geselecteerd.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-brand-50 px-4 py-2 text-sm">
          <span className="font-medium text-brand-800">{geselecteerd.length} geselecteerd</span>
          {onBulkReassign && (
            <label className="flex items-center gap-1 text-slate-600">
              Herverdeel naar
              <select
                className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                defaultValue=""
                disabled={busy}
                onChange={async (e) => {
                  const employeeId = e.target.value
                  if (!employeeId) return
                  e.target.value = ''
                  const naam = employees.find((emp) => emp.id === employeeId)?.naam ?? 'de gekozen medewerker'
                  await verwerk(
                    () => onBulkReassign(ids, employeeId),
                    (gelukt, totaal) => `${gelukt} van de ${totaal} taken herverdeeld naar ${naam}.`
                  )
                }}
              >
                <option value="" disabled>
                  Kies medewerker…
                </option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.naam}
                  </option>
                ))}
              </select>
            </label>
          )}
          {onBulkStatus &&
            (statussen.length > 0 ? (
              <label className="flex items-center gap-1 text-slate-600">
                Zet status op
                <select
                  className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                  defaultValue=""
                  disabled={busy}
                  onChange={async (e) => {
                    const status = e.target.value as TaskStatus | ''
                    if (!status) return
                    e.target.value = ''
                    await verwerk(
                      () => onBulkStatus(ids, status),
                      (gelukt, totaal) => `${gelukt} van de ${totaal} taken op "${STATUS_LABEL[status]}" gezet.`
                    )
                  }}
                >
                  <option value="" disabled>
                    Kies status…
                  </option>
                  {statussen.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              // Geen lege keuzelijst: zeggen waaróm er niets te kiezen valt.
              <p className="text-xs text-amber-800">{bulkStatusUitleg(contexten)}</p>
            ))}
        </div>
      )}
    </>
  )
}
