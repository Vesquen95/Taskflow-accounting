import type { Sheet } from 'write-excel-file/browser'
import {
  KOLOMMEN,
  KlantImportFout,
  MAX_BESTAND_BYTES,
  MAX_RIJEN,
  VOORBEELDRIJEN,
  kiesBlad,
  leesKlantRijen,
  type ImportVoorbeeld,
  type LeesOpties,
  type Werkblad,
} from './klantImport'

/**
 * De enige plek die echte .xlsx-bytes aanraakt.
 *
 * Waarom `await import(...)` en geen gewone import bovenaan: read-excel-file
 * en write-excel-file wegen samen ~4 MB aan broncode. Ze horen niet in de
 * hoofdbundel van een app waarin de meeste mensen nooit iets importeren; met
 * een dynamische import maakt Vite er een aparte chunk van die pas over de
 * lijn komt wanneer iemand het importscherm opent of het sjabloon downloadt.
 *
 * Waarom deze twee bibliotheken: SheetJS (`xlsx`) heeft twee adviezen met
 * ernst "hoog" in de npm-databank waarvoor geen gepatchte versie op npm staat
 * — onaanvaardbaar voor code die bestanden van buiten parseert. `exceljs` is
 * 20,8 MB en ligt sinds december 2024 stil.
 *
 * Alles wat hier binnenkomt is niet te vertrouwen: het bestand komt van een
 * gebruiker en gaat door een parser. Vandaar de grens op de bestandsgrootte
 * (vóór het parseren, want daarna is het geld al uitgegeven) en de grens op
 * het aantal rijen in leesKlantRijen().
 */

export const SJABLOON_BESTANDSNAAM = 'taskflow-klanten-sjabloon.xlsx'

const KOP_ACHTERGROND = '#F1F5F9'

type SjabloonCel = { value: string; type: StringConstructor; fontWeight?: 'bold'; backgroundColor?: string; wrap?: boolean }

function kopCel(tekst: string): SjabloonCel {
  return { value: tekst, type: String, fontWeight: 'bold', backgroundColor: KOP_ACHTERGROND }
}

function cel(tekst: string): SjabloonCel {
  return { value: tekst, type: String }
}

/** Blad 1: de kopregel plus de ingevulde voorbeeldrijen. */
function klantenBlad(): Sheet<Blob> {
  return {
    sheet: 'Klanten',
    columns: KOLOMMEN.map((k) => ({ width: k.breedte })),
    data: [
      KOLOMMEN.map((k) => kopCel(k.kop)),
      ...VOORBEELDRIJEN.map((rij) => KOLOMMEN.map((k) => cel(rij[k.sleutel]))),
    ],
  }
}

/** Blad 2: wat er per kolom verwacht wordt, en wat deze import niet doet. */
function toelichtingBlad(): Sheet<Blob> {
  return {
    sheet: 'Toelichting',
    columns: [{ width: 26 }, { width: 12 }, { width: 90 }],
    data: [
      [kopCel('Kolom'), kopCel('Verplicht'), kopCel('Wat er verwacht wordt')],
      ...KOLOMMEN.map((k) => [cel(k.kop), cel(k.vereist ? 'Ja' : 'Nee'), cel(k.uitleg)]),
      [],
      [cel('Vul enkel het blad "Klanten" in. De twee voorbeeldrijen mogen blijven staan of overschreven worden.')],
      [cel(`Hoogstens ${MAX_RIJEN} klanten per bestand, en hoogstens ${MAX_BESTAND_BYTES / (1024 * 1024)} MB groot.`)],
      [cel('Lege rijen worden overgeslagen. Elke rij wordt eerst getoond in een voorbeeld; er wordt niets opgeslagen voor je dat bevestigt.')],
      [
        cel(
          'Niet in dit bestand: "vertrouwelijk" en de standaard verantwoordelijke. Die zet een kantoorbeheerder na het aanmaken in het klantdossier — de databank staat ze bij het aanmaken niet toe.'
        ),
      ],
      [cel('Ook niet in dit bestand: de verplichtingen per klant. De btw-taken volgen automatisch uit het btw-regime; de rest vul je in het klantformulier aan.')],
    ],
  }
}

/** De bladen van het sjabloon, klaar voor write-excel-file. */
function sjabloonBladen(): Sheet<Blob>[] {
  return [klantenBlad(), toelichtingBlad()]
}

/** Het sjabloon als Blob (gebruikt door de tests en door de downloadknop). */
export async function bouwSjabloonBlob(): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  return writeXlsxFile(sjabloonBladen(), { fontFamily: 'Calibri', fontSize: 11 }).toBlob()
}

/** Zet het sjabloon in de downloadmap van de gebruiker. */
export async function downloadSjabloon(): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  await writeXlsxFile(sjabloonBladen(), { fontFamily: 'Calibri', fontSize: 11 }).toFile(SJABLOON_BESTANDSNAAM)
}

function beschrijfGrootte(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Leest een aangeleverd .xlsx en geeft het voorbeeld terug dat het kantoor te
 * zien krijgt. Slaat niets op.
 */
export async function leesKlantenBestand(bestand: File | Blob, opties: LeesOpties = {}): Promise<ImportVoorbeeld> {
  if (bestand.size === 0) {
    throw new KlantImportFout('Dit bestand is leeg.')
  }
  if (bestand.size > MAX_BESTAND_BYTES) {
    throw new KlantImportFout(
      `Dit bestand is ${beschrijfGrootte(bestand.size)} groot; er wordt hoogstens ${beschrijfGrootte(
        MAX_BESTAND_BYTES
      )} ingelezen. Een klantenlijst van ${MAX_RIJEN} rijen blijft ruim onder die grens.`
    )
  }

  const buffer = await bestand.arrayBuffer()
  const { default: readXlsxFile } = await import('read-excel-file/browser')

  let bladen: Werkblad[]
  try {
    bladen = (await readXlsxFile(buffer)) as unknown as Werkblad[]
  } catch (err) {
    // Alles wat de parser gooit (geen zip, kapotte zip, geen spreadsheet) komt
    // hier samen: voor de gebruiker is het één en hetzelfde probleem.
    console.error('[Taskflow] Kon het Excel-bestand niet lezen', err)
    throw new KlantImportFout(
      'Dit bestand kon niet gelezen worden als Excel-bestand (.xlsx). Sla het in Excel op als "Excel-werkmap (*.xlsx)" — een .xls of .csv werkt niet.'
    )
  }

  const blad = kiesBlad(bladen)
  return leesKlantRijen(blad.data, opties, blad.sheet)
}
