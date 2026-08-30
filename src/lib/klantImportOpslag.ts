import { errorMessage } from './errorMessage'
import type { ImportRij, NieuweKlant } from './klantImport'

/**
 * De import wegschrijven, met een verslag per rij.
 *
 * Waarom niet `voerBulkUit` uit src/lib/bulkActie.ts hergebruiken: dat patroon
 * doet eerst één snelle opdracht voor alles en zoekt pas per rij uit wat er
 * misging wanneer die faalt. Voor taken klopt die afweging — de normale
 * bulkactie slaagt en kost dan één verzoek. Hier niet:
 *
 *  - Eén `insert([...])` met honderd klanten is één statement. Één rij die de
 *    unieke index op (firm_id, ondernemingsnummer) raakt, rolt de hele import
 *    terug. Bij een import van honderd klanten is dat de normale gang van
 *    zaken, niet de uitzondering.
 *  - Een gedeeltelijk geslaagde import moet per rij te verantwoorden zijn, en
 *    de sleutel is hier het rijnummer uit Excel — er zijn nog geen id's.
 *  - Elke insert zet triggers in gang (sync_btw_obligations maakt de
 *    btw-verplichtingen aan, block_unaudited_confidentiality_change kijkt mee).
 *    Rij per rij houdt die kettingreactie klein en toewijsbaar.
 *
 * Daarom: altijd één opdracht per rij, in de volgorde van het bestand.
 */

/** Na zoveel mislukkingen na elkaar stoppen we. Dat is geen kieskeurigheid:
 *  valt de verbinding weg of blijkt de medewerker geen schrijfrecht te hebben,
 *  dan levert doorgaan 500 keer dezelfde fout op — traag, en het verslag
 *  wordt onleesbaar. De rest komt als "niet geprobeerd" terug, zodat het
 *  kantoor weet dat die klanten nog moeten. */
export const MAX_OPEENVOLGENDE_FOUTEN = 5

const NIET_GEPROBEERD_REDEN =
  'Niet geprobeerd: de import is gestopt nadat het meermaals na elkaar misging.'

export interface ImportUitkomst {
  /** Het rijnummer uit Excel, zoals in het voorbeeldscherm. */
  excelRij: number
  naam: string
  /** Waarom deze rij niet doorging, in mensentaal. Null bij succes. */
  reden: string | null
  /** De klant staat er, maar er viel iets op (bv. zijn taken raakten niet
   *  gegenereerd). Null wanneer alles vlot ging. */
  waarschuwing: string | null
  clientId: string | null
}

export interface ImportVerslag {
  gelukt: ImportUitkomst[]
  mislukt: ImportUitkomst[]
  nietGeprobeerd: ImportUitkomst[]
  /** Gestopt vóór het einde van de lijst (zie MAX_OPEENVOLGENDE_FOUTEN). */
  afgebroken: boolean
}

/**
 * @param rijen     Het volledige voorbeeld; rijen met fouten worden
 *                  overgeslagen (die stonden al als ongeldig in het voorbeeld).
 * @param maakKlant Maakt één klant aan en geeft het nieuwe id terug; gooit bij
 *                  een fout.
 * @param genereerTaken Optioneel: zet de taken van de nieuwe klant klaar
 *                  (sync_client_tasks). De trigger sync_btw_obligations maakt
 *                  wel de btw-verplichtingen aan, maar niet de taakinstanties;
 *                  zonder deze stap staat een geïmporteerde klant met een lege
 *                  kalender tot de maandelijkse horizonronde langskomt.
 *                  Mislukt dit, dan blijft de klant "aangemaakt" — hij staat er
 *                  immers — met een waarschuwing erbij.
 */
export async function voerKlantImportUit(
  rijen: ImportRij[],
  maakKlant: (klant: NieuweKlant) => Promise<string>,
  genereerTaken?: (clientId: string) => Promise<void>
): Promise<ImportVerslag> {
  const teDoen = rijen.filter((rij): rij is ImportRij & { klant: NieuweKlant } => rij.klant !== null)

  const gelukt: ImportUitkomst[] = []
  const mislukt: ImportUitkomst[] = []
  const nietGeprobeerd: ImportUitkomst[] = []
  let opeenvolgendeFouten = 0

  for (const [index, rij] of teDoen.entries()) {
    if (opeenvolgendeFouten >= MAX_OPEENVOLGENDE_FOUTEN) {
      nietGeprobeerd.push(
        ...teDoen.slice(index).map((rest) => ({
          excelRij: rest.excelRij,
          naam: rest.klant.naam,
          reden: NIET_GEPROBEERD_REDEN,
          waarschuwing: null,
          clientId: null,
        }))
      )
      break
    }

    try {
      const clientId = await maakKlant(rij.klant)

      let waarschuwing: string | null = null
      if (genereerTaken) {
        try {
          await genereerTaken(clientId)
        } catch (err) {
          // Telt bewust niet mee voor het afbreken: de klanten worden wél
          // aangemaakt, dus doorgaan is hier de juiste keuze.
          waarschuwing = errorMessage(
            err,
            'De klant is aangemaakt, maar zijn taken konden niet gegenereerd worden. Open het klantdossier en sla het op om dat alsnog te doen'
          )
        }
      }

      gelukt.push({ excelRij: rij.excelRij, naam: rij.klant.naam, reden: null, waarschuwing, clientId })
      opeenvolgendeFouten = 0
    } catch (err) {
      mislukt.push({
        excelRij: rij.excelRij,
        naam: rij.klant.naam,
        reden: errorMessage(err),
        waarschuwing: null,
        clientId: null,
      })
      opeenvolgendeFouten++
    }
  }

  return { gelukt, mislukt, nietGeprobeerd, afgebroken: nietGeprobeerd.length > 0 }
}
