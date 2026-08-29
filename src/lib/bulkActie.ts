import { errorMessage } from './errorMessage'

/**
 * Bulkacties op taken, met een verslag per taak.
 *
 * Waarom dit bestaat: `update(...).in('id', ids)` is één SQL-statement en dus
 * alles-of-niets. Weigert `enforce_task_instance_transition` (migratie 0011)
 * er één rij van, dan rolt Postgres het hele statement terug: het kantoor
 * kreeg één foutmelding, zag niets veranderen en wist niet welke taak de
 * dwarsligger was.
 *
 * De afweging (bewust gemaakt, niet per ongeluk):
 *  - N losse opdrachten geven altijd een exact verslag, maar kosten N
 *    verzoeken; een maandblok telt makkelijk tientallen taken en die weg
 *    zou de normale, geslaagde bulkactie tientallen keren trager maken.
 *  - Eén opdracht is snel, maar zwijgt over wélke rij de boel tegenhield.
 * Daarom: eerst de snelle weg, en alléén wanneer die faalt per taak
 * uitzoeken wat er misging. De prijs van N verzoeken wordt zo betaald op het
 * moment dat er ook echt iets uit te leggen valt. Dat is veilig omdat het
 * afgebroken statement gegarandeerd niets heeft toegepast — er wordt dus
 * niets dubbel geschreven.
 *
 * De UI filtert vooraf al op wat op élke geselecteerde taak kan
 * (`gemeenschappelijkeBulkStatussen`); deze terugval dekt wat daarna nog kan
 * misgaan — een collega die de taak intussen verzette, of een rij die deze
 * medewerker niet mag schrijven.
 */

export interface BulkFout {
  taskId: string
  /** Waarom deze taak niet doorging, in mensentaal (via errorMessage). */
  reden: string
}

export interface BulkResultaat {
  gelukt: string[]
  mislukt: BulkFout[]
}

/**
 * Postgres geeft geen fout wanneer RLS een rij gewoon buiten de update
 * houdt: het statement slaagt en raakt die rij niet aan. Zonder deze
 * controle zou het verslag "gelukt" melden voor een taak waar niets mee
 * gebeurde — precies de stille leugen die we hier uitroeien.
 */
export const NIET_BIJGEWERKT_REDEN =
  'De databank heeft deze taak niet bijgewerkt. Ze is niet (meer) zichtbaar voor jou of je hebt er geen schrijfrecht op.'

/**
 * @param samen   Eén opdracht voor alle ids. Geeft de ids terug die de
 *                databank effectief bijgewerkt heeft; gooit bij een fout.
 * @param perTaak Eén opdracht voor één id. `false` = de rij werd niet
 *                aangeraakt; gooit bij een fout.
 */
export async function voerBulkUit(
  taskIds: string[],
  samen: (ids: string[]) => Promise<string[]>,
  perTaak: (id: string) => Promise<boolean>
): Promise<BulkResultaat> {
  if (taskIds.length === 0) return { gelukt: [], mislukt: [] }

  try {
    const bijgewerkt = new Set(await samen(taskIds))
    return {
      gelukt: taskIds.filter((id) => bijgewerkt.has(id)),
      mislukt: taskIds
        .filter((id) => !bijgewerkt.has(id))
        .map((id) => ({ taskId: id, reden: NIET_BIJGEWERKT_REDEN })),
    }
  } catch {
    // De ene opdracht is afgebroken en heeft dus niets toegepast. Hieronder
    // zoeken we uit welke taken het waren; de fout zelf komt per taak terug
    // met de rij erbij waar ze over gaat.
  }

  const gelukt: string[] = []
  const mislukt: BulkFout[] = []
  // Bewust na elkaar: de logregels van de trigger blijven zo in de volgorde
  // van de lijst staan, en we zetten geen tientallen gelijktijdige verzoeken
  // op een databank die er net één van geweigerd heeft.
  for (const id of taskIds) {
    try {
      if (await perTaak(id)) gelukt.push(id)
      else mislukt.push({ taskId: id, reden: NIET_BIJGEWERKT_REDEN })
    } catch (err) {
      mislukt.push({ taskId: id, reden: errorMessage(err) })
    }
  }
  return { gelukt, mislukt }
}
