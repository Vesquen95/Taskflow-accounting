import type { BtwFrequentie, BtwRegime } from '../types'

/**
 * Klanten inlezen uit een Excel-bestand — de pure kant.
 *
 * Dit bestand kent geen scherm en geen Supabase: het krijgt de cellen van een
 * blad binnen (zoals read-excel-file ze teruggeeft) en zegt per rij of die
 * naar de databank kan. Zo is de moeilijkste logica los te testen, en blijft
 * het inleeswerk zelf (src/lib/klantImportBestand.ts) een dun laagje.
 *
 * Uitgangspunt: het scherm belooft niets wat de databank daarna weigert.
 * Elke controle hieronder staat er omdat de databank ze óók doet:
 *  - naam verplicht, hoogstens 200 tekens; rechtsvorm hoogstens 100
 *    (migratie 0003, table clients)
 *  - clients_btw_freq_only_when_periodiek: een aangiftefrequentie hoort
 *    precies bij 'periodieke_aangever' en anders nergens
 *  - unique (firm_id, ondernemingsnummer)
 *  - boekjaar_einde_maand 1-12, boekjaar_einde_dag 1-31
 *
 * En wat de import bewust NIET aanbiedt:
 *  - `vertrouwelijk` en `standaard_verantwoordelijke_id`:
 *    block_unaudited_confidentiality_change() (migratie 0009) laat die bij
 *    een INSERT enkel toe voor een kantoorbeheerder, en dan nog met een
 *    logregel per veld. Een importbestand is de verkeerde plek voor die
 *    beslissing; ze hoort in het klantformulier, na het aanmaken.
 *  - verplichtingen aanvinken: de btw-taken volgen automatisch uit het
 *    btw-regime (trigger sync_btw_obligations, migratie 0004); de rest blijft
 *    het klantformulier.
 */

/** Grens op wat we van buiten aanvaarden. Een klantenlijst van 500 rijen is
 *  ~40 kB; 2 MB is dus ruim, en houdt tegelijk het parseren (dat op de
 *  hoofdthread gebeurt) binnen een fractie van een seconde. */
export const MAX_BESTAND_BYTES = 2 * 1024 * 1024

/** Het kantoor telt 50 à 500 klanten. Meer dan dit in één bestand is geen
 *  import maar een ongeluk — en 50.000 rijen in een voorbeeldtabel zetten
 *  legt de browser plat. */
export const MAX_RIJEN = 1000

const MAX_NAAM_LENGTE = 200
const MAX_RECHTSVORM_LENGTE = 100

export type KolomSleutel =
  | 'naam'
  | 'ondernemingsnummer'
  | 'rechtsvorm'
  | 'boekjaar_einde_maand'
  | 'boekjaar_einde_dag'
  | 'btw_regime'
  | 'btw_aangifte_frequentie'
  | 'mandataris'

export interface Kolom {
  sleutel: KolomSleutel
  /** De kop zoals ze in het sjabloon staat. */
  kop: string
  /** Moet de kolom in het bestand staan? (Niet: moet elke cel gevuld zijn.) */
  vereist: boolean
  /** Uitleg voor het toelichtingsblad en het scherm. */
  uitleg: string
  /** Extra koppen die we ook herkennen (genormaliseerd, zie normaliseerKop). */
  synoniemen: string[]
  /** Breedte van de kolom in het sjabloon. */
  breedte: number
}

const REGIME_LABELS: Record<BtwRegime, string> = {
  geen: 'Geen',
  periodieke_aangever: 'Periodieke aangever',
  vrijgesteld_kleine_onderneming: 'Vrijgesteld (kleine onderneming)',
}

const FREQUENTIE_LABELS: Record<BtwFrequentie, string> = {
  maand: 'Maand',
  kwartaal: 'Kwartaal',
}

const REGIME_KEUZES = Object.values(REGIME_LABELS)
const FREQUENTIE_KEUZES = Object.values(FREQUENTIE_LABELS)

export const KOLOMMEN: readonly Kolom[] = [
  {
    sleutel: 'naam',
    kop: 'Naam',
    vereist: true,
    uitleg: `Verplicht. De naam van de klant, hoogstens ${MAX_NAAM_LENGTE} tekens.`,
    synoniemen: ['klantnaam', 'klant', 'benaming'],
    breedte: 32,
  },
  {
    sleutel: 'ondernemingsnummer',
    kop: 'Ondernemingsnummer',
    vereist: false,
    uitleg:
      'Optioneel. Belgisch ondernemingsnummer van 10 cijfers. Punten, spaties en "BE" mogen; ze worden weggelaten. Mag maar één keer voorkomen.',
    synoniemen: ['kbo', 'kbonummer', 'ondernemingsnr', 'btwnummer'],
    breedte: 20,
  },
  {
    sleutel: 'rechtsvorm',
    kop: 'Rechtsvorm',
    vereist: false,
    uitleg: `Optioneel. Bijvoorbeeld BV, NV, VZW, Eenmanszaak. Hoogstens ${MAX_RECHTSVORM_LENGTE} tekens.`,
    synoniemen: ['vennootschapsvorm'],
    breedte: 14,
  },
  {
    sleutel: 'boekjaar_einde_maand',
    kop: 'Boekjaareinde maand',
    vereist: false,
    uitleg: 'Cijfer 1-12 of de maandnaam. Laat maand én dag leeg voor het gebruikelijke 31/12.',
    synoniemen: ['boekjaarmaand', 'maandboekjaareinde'],
    breedte: 20,
  },
  {
    sleutel: 'boekjaar_einde_dag',
    kop: 'Boekjaareinde dag',
    vereist: false,
    uitleg: 'Cijfer 1-31, en de dag moet in die maand bestaan.',
    synoniemen: ['boekjaardag', 'dagboekjaareinde'],
    breedte: 18,
  },
  {
    sleutel: 'btw_regime',
    kop: 'BTW-regime',
    vereist: true,
    uitleg: `Verplicht. Eén van: ${REGIME_KEUZES.join(' / ')}.`,
    synoniemen: ['regime', 'btwstelsel'],
    breedte: 30,
  },
  {
    sleutel: 'btw_aangifte_frequentie',
    kop: 'Aangiftefrequentie',
    vereist: false,
    uitleg: `Enkel bij "${REGIME_LABELS.periodieke_aangever}", en dan verplicht: ${FREQUENTIE_KEUZES.join(' / ')}. Anders leeg laten.`,
    synoniemen: ['frequentie', 'btwfrequentie', 'btwaangiftefrequentie', 'aangifte'],
    breedte: 20,
  },
  {
    sleutel: 'mandataris',
    kop: 'Mandataris',
    vereist: false,
    uitleg: 'Ja of Nee. Leeg telt als Nee.',
    synoniemen: [],
    breedte: 12,
  },
]

/**
 * De ingevulde voorbeeldrijen van het sjabloon. Twee, omdat één rij niet laat
 * zien dat de aangiftefrequentie leeg hoort te blijven zodra het regime geen
 * periodieke aangever is — precies de fout die de databank achteraf weigert.
 */
export const VOORBEELDRIJEN: ReadonlyArray<Record<KolomSleutel, string>> = [
  {
    naam: 'Voorbeeld BV',
    ondernemingsnummer: 'BE0123.456.749',
    rechtsvorm: 'BV',
    boekjaar_einde_maand: '12',
    boekjaar_einde_dag: '31',
    btw_regime: REGIME_LABELS.periodieke_aangever,
    btw_aangifte_frequentie: FREQUENTIE_LABELS.kwartaal,
    mandataris: 'Ja',
  },
  {
    naam: 'Tweede Voorbeeld VZW',
    ondernemingsnummer: '',
    rechtsvorm: 'VZW',
    boekjaar_einde_maand: '6',
    boekjaar_einde_dag: '30',
    btw_regime: REGIME_LABELS.vrijgesteld_kleine_onderneming,
    btw_aangifte_frequentie: '',
    mandataris: 'Nee',
  },
]

/** De velden die per rij naar `clients` gaan. Bewust géén firm_id (die komt
 *  van de ingelogde medewerker), géén vertrouwelijk/verantwoordelijke en géén
 *  actief: een nieuwe klant is altijd actief. */
export interface NieuweKlant {
  naam: string
  ondernemingsnummer: string | null
  rechtsvorm: string | null
  boekjaar_einde_maand: number
  boekjaar_einde_dag: number
  btw_regime: BtwRegime
  btw_aangifte_frequentie: BtwFrequentie | null
  mandataris: boolean
}

export interface ImportRij {
  /** Het rijnummer zoals de gebruiker het in Excel ziet (1-gebaseerd). */
  excelRij: number
  /** Wat er in de cellen stond, voor de voorbeeldtabel. */
  ruw: Record<KolomSleutel, string>
  /** De klant die opgeslagen wordt, of null wanneer de rij fouten heeft. */
  klant: NieuweKlant | null
  fouten: string[]
  /** Aangepast maar wel opgeslagen: aannames die zichtbaar moeten zijn. */
  waarschuwingen: string[]
}

export interface ImportVoorbeeld {
  bladnaam: string
  rijen: ImportRij[]
  aantalGeldig: number
  legeRijenOvergeslagen: number
  onbekendeKolommen: string[]
}

export interface LeesOpties {
  /** Ondernemingsnummers die al in de databank staan, in eender welke
   *  schrijfwijze. Voorkomt dat de import belooft wat de unieke index
   *  (firm_id, ondernemingsnummer) daarna weigert. */
  bestaandeOndernemingsnummers?: string[]
}

/** Een bestand dat als geheel niet bruikbaar is (geen kopregel, te groot, te
 *  veel rijen, geen echt .xlsx). Rijfouten gebruiken deze klasse niet: die
 *  horen bij de rij, niet bij het bestand. */
export class KlantImportFout extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KlantImportFout'
  }
}

// ---------------------------------------------------------------- cellen

/** Eén cel als tekst. read-excel-file geeft string, number, boolean, Date of
 *  null terug; alles daarbuiten wordt zo goed mogelijk beschreven zodat het
 *  in de validatie opvalt in plaats van stil te verdwijnen. */
function celTekst(waarde: unknown): string {
  if (waarde === null || waarde === undefined) return ''
  if (typeof waarde === 'string') return waarde.trim()
  if (typeof waarde === 'number') return Number.isFinite(waarde) ? String(waarde) : ''
  if (typeof waarde === 'boolean') return waarde ? 'true' : 'false'
  if (waarde instanceof Date) return Number.isNaN(waarde.getTime()) ? '' : waarde.toISOString().slice(0, 10)
  return String(waarde).trim()
}

/** Celinhoud die in een melding of in de voorbeeldtabel terechtkomt, ingekort.
 *  Een cel uit een bestand van buiten kan duizenden tekens bevatten; die
 *  onverkort doorgeven maakt de foutenlijst onleesbaar en het scherm traag. */
export function kort(tekst: string, maxLengte = 80): string {
  return tekst.length <= maxLengte ? tekst : `${tekst.slice(0, maxLengte)}…`
}

/** Vergelijkingsvorm voor koppen en keuzewaarden: kleine letters, zonder
 *  accenten, spaties, koppeltekens of leestekens. Zo herkennen we
 *  "BTW-regime", "btw regime" en "btw_regime" als dezelfde kop. */
function normaliseerKop(tekst: string): string {
  return tekst
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

// -------------------------------------------------- ondernemingsnummer

/** Enkel de cijfers, met de nul terug die Excel van een getalcel afknipt.
 *  Een Belgisch ondernemingsnummer telt 10 cijfers en begint met 0 of 1; een
 *  cel met 9 cijfers is dus met zekerheid een verloren leidende nul en geen
 *  gok. */
function cijfersVanOndernemingsnummer(ruw: string): string | null {
  const zonderRuis = ruw.replace(/[\s.\-/]/g, '').toUpperCase()
  const zonderLandcode = zonderRuis.startsWith('BE') ? zonderRuis.slice(2) : zonderRuis
  if (!/^\d+$/.test(zonderLandcode)) return null
  const cijfers = zonderLandcode.length === 9 ? `0${zonderLandcode}` : zonderLandcode
  if (cijfers.length !== 10) return null
  // Een Belgisch ondernemingsnummer begint met 0 (onderneming) of 1 (sinds
  // de reeks 0 vol raakte). Alles daarbuiten is geen KBO-nummer.
  if (cijfers[0] !== '0' && cijfers[0] !== '1') return null
  return cijfers
}

/** De sleutel waarop we dubbels herkennen: enkel de cijfers, dus
 *  "0123456749" en "BE0123.456.749" botsen zoals het hoort. */
function ondernemingsnummerSleutel(ruw: string): string | null {
  return cijfersVanOndernemingsnummer(ruw)
}

/** Canonieke schrijfwijze: BE0123.456.749 (14 tekens, past in de kolom van
 *  20). Geeft null wanneer dit geen Belgisch ondernemingsnummer kan zijn —
 *  dan is normaliseren gokken, en weigeren we liever. */
export function normaliseerOndernemingsnummer(ruw: string): string | null {
  const cijfers = cijfersVanOndernemingsnummer(ruw)
  if (cijfers === null) return null
  return `BE${cijfers.slice(0, 4)}.${cijfers.slice(4, 7)}.${cijfers.slice(7, 10)}`
}

/** Modulo 97-controle van de KBO. Een fout controlegetal is bijna altijd een
 *  typfout, maar we blokkeren de rij er niet mee: het blijft een waarschuwing
 *  omdat de databank dit niet afdwingt en het kantoor het beter weet. */
function heeftGeldigControlegetal(nummer: string): boolean {
  const cijfers = cijfersVanOndernemingsnummer(nummer)
  if (cijfers === null) return false
  const basis = Number(cijfers.slice(0, 8))
  const controle = Number(cijfers.slice(8, 10))
  return 97 - (basis % 97) === controle
}

// -------------------------------------------------------------- waarden

const MAANDNAMEN = [
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december',
]

/** Feb op 29: een boekjaar dat op 29/02 eindigt bestaat in een schrikkeljaar,
 *  en de databank slaat enkel maand+dag op — geen jaar om tegen te toetsen. */
const DAGEN_PER_MAAND = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const JA_WAARDEN = ['ja', 'j', 'true', 'waar', '1', 'x', 'yes']
const NEE_WAARDEN = ['nee', 'neen', 'n', 'false', 'onwaar', '0', 'no']

const REGIME_VAN_TEKST: Record<string, BtwRegime> = {
  geen: 'geen',
  geenbtw: 'geen',
  nietbtwplichtig: 'geen',
  periodiekeaangever: 'periodieke_aangever',
  periodiekeaangifte: 'periodieke_aangever',
  vrijgesteldkleineonderneming: 'vrijgesteld_kleine_onderneming',
  vrijgesteld: 'vrijgesteld_kleine_onderneming',
  kleineonderneming: 'vrijgesteld_kleine_onderneming',
}

const FREQUENTIE_VAN_TEKST: Record<string, BtwFrequentie> = {
  maand: 'maand',
  maandelijks: 'maand',
  permaand: 'maand',
  kwartaal: 'kwartaal',
  kwartaalaangifte: 'kwartaal',
  perkwartaal: 'kwartaal',
  driemaandelijks: 'kwartaal',
}

// ------------------------------------------------------------ kopregel

interface Kopregel {
  /** Index in de bladmatrix (0-gebaseerd) van de rij met de koppen. */
  index: number
  /** Kolomindex per veld; ontbrekende kolommen staan er niet in. */
  posities: Partial<Record<KolomSleutel, number>>
  onbekendeKolommen: string[]
}

function isLegeCelrij(rij: unknown[] | undefined): boolean {
  if (!rij) return true
  return rij.every((cel) => celTekst(cel) === '')
}

function leesKopregel(data: unknown[][]): Kopregel {
  const index = data.findIndex((rij) => !isLegeCelrij(rij))
  if (index === -1) {
    throw new KlantImportFout('Het werkblad is leeg. Vul het sjabloon in en probeer opnieuw.')
  }

  const posities: Partial<Record<KolomSleutel, number>> = {}
  const onbekendeKolommen: string[] = []

  data[index].forEach((cel, kolomIndex) => {
    const tekst = celTekst(cel)
    if (tekst === '') return
    const genormaliseerd = normaliseerKop(tekst)
    const kolom = KOLOMMEN.find(
      (k) => normaliseerKop(k.kop) === genormaliseerd || k.synoniemen.includes(genormaliseerd)
    )
    if (!kolom || posities[kolom.sleutel] !== undefined) {
      onbekendeKolommen.push(kort(tekst, 40))
      return
    }
    posities[kolom.sleutel] = kolomIndex
  })

  const ontbreekt = KOLOMMEN.filter((k) => k.vereist && posities[k.sleutel] === undefined)
  if (ontbreekt.length > 0) {
    throw new KlantImportFout(
      `De kopregel mist ${ontbreekt.length === 1 ? 'de kolom' : 'de kolommen'} ${ontbreekt
        .map((k) => `"${k.kop}"`)
        .join(', ')}. Download het sjabloon en gebruik de koppen die daarin staan.`
    )
  }

  return { index, posities, onbekendeKolommen }
}

// ------------------------------------------------------------ één rij

function leesNaam(ruw: string, fouten: string[], waarschuwingen: string[]): string | null {
  if (ruw === '') {
    fouten.push('Naam is verplicht.')
    return null
  }
  if (ruw.length > MAX_NAAM_LENGTE) {
    fouten.push(`Naam mag hoogstens ${MAX_NAAM_LENGTE} tekens lang zijn (nu ${ruw.length}).`)
    return null
  }
  // De voorbeeldrijen van het sjabloon blijven staan als je ze vergeet te
  // wissen. Ze zijn geldig, dus dit blijft een waarschuwing -- maar zonder
  // melding staat er straks een klant "Voorbeeld BV" in het dossier.
  if (VOORBEELDRIJEN.some((v) => v.naam === ruw)) {
    waarschuwingen.push('Dit is een voorbeeldrij uit het sjabloon. Verwijder ze als het geen echte klant is.')
  }
  return ruw
}

function leesRechtsvorm(ruw: string, fouten: string[]): string | null {
  if (ruw === '') return null
  if (ruw.length > MAX_RECHTSVORM_LENGTE) {
    fouten.push(`Rechtsvorm mag hoogstens ${MAX_RECHTSVORM_LENGTE} tekens lang zijn (nu ${ruw.length}).`)
    return null
  }
  return ruw
}

function leesMaand(ruw: string, fouten: string[]): number | null {
  const naamIndex = MAANDNAMEN.indexOf(normaliseerKop(ruw))
  if (naamIndex !== -1) return naamIndex + 1
  const getal = Number(ruw.replace(',', '.'))
  if (!Number.isInteger(getal) || getal < 1 || getal > 12) {
    fouten.push(`Boekjaareinde maand "${kort(ruw, 20)}" is geen maand: vul een cijfer 1-12 of de maandnaam in.`)
    return null
  }
  return getal
}

function leesDag(ruw: string, fouten: string[]): number | null {
  const getal = Number(ruw.replace(',', '.'))
  if (!Number.isInteger(getal) || getal < 1 || getal > 31) {
    fouten.push(`Boekjaareinde dag "${kort(ruw, 20)}" is geen dag: vul een cijfer 1-31 in.`)
    return null
  }
  return getal
}

interface Boekjaareinde {
  maand: number
  dag: number
}

function leesBoekjaareinde(
  maandRuw: string,
  dagRuw: string,
  fouten: string[],
  waarschuwingen: string[]
): Boekjaareinde | null {
  if (maandRuw === '' && dagRuw === '') {
    waarschuwingen.push('Boekjaareinde niet ingevuld — 31/12 aangenomen.')
    return { maand: 12, dag: 31 }
  }
  if (maandRuw === '' || dagRuw === '') {
    fouten.push('Vul bij het boekjaareinde zowel de maand als de dag in, of laat ze allebei leeg voor 31/12.')
    return null
  }

  const maand = leesMaand(maandRuw, fouten)
  const dag = leesDag(dagRuw, fouten)
  if (maand === null || dag === null) return null

  if (dag > DAGEN_PER_MAAND[maand - 1]) {
    fouten.push(
      `Boekjaareinde ${dag}/${maand} bestaat niet: ${MAANDNAMEN[maand - 1]} heeft hoogstens ${DAGEN_PER_MAAND[maand - 1]} dagen.`
    )
    return null
  }
  return { maand, dag }
}

function leesRegime(ruw: string, fouten: string[]): BtwRegime | null {
  if (ruw === '') {
    fouten.push(`BTW-regime is verplicht. Kies uit: ${REGIME_KEUZES.join(', ')}.`)
    return null
  }
  const regime = REGIME_VAN_TEKST[normaliseerKop(ruw)]
  if (!regime) {
    fouten.push(`BTW-regime "${kort(ruw)}" is geen geldige waarde. Kies uit: ${REGIME_KEUZES.join(', ')}.`)
    return null
  }
  return regime
}

/** De frequentie hangt vast aan het regime; clients_btw_freq_only_when_
 *  periodiek weigert elke andere combinatie. `regime === null` betekent dat
 *  het regime zelf al fout was — dan zwijgen we hier over de frequentie. */
function leesFrequentie(
  ruw: string,
  regime: BtwRegime | null,
  fouten: string[]
): BtwFrequentie | null | 'fout' {
  if (regime !== 'periodieke_aangever') {
    if (ruw !== '' && regime !== null) {
      fouten.push(
        `Aangiftefrequentie is enkel toegelaten bij "${REGIME_LABELS.periodieke_aangever}". Laat de cel leeg bij "${REGIME_LABELS[regime]}".`
      )
      return 'fout'
    }
    return null
  }
  if (ruw === '') {
    fouten.push(`Een periodieke aangever heeft een aangiftefrequentie nodig: ${FREQUENTIE_KEUZES.join(' of ')}.`)
    return 'fout'
  }
  const frequentie = FREQUENTIE_VAN_TEKST[normaliseerKop(ruw)]
  if (!frequentie) {
    fouten.push(`Aangiftefrequentie "${kort(ruw)}" is geen geldige waarde. Kies uit: ${FREQUENTIE_KEUZES.join(', ')}.`)
    return 'fout'
  }
  return frequentie
}

function leesMandataris(ruw: string, fouten: string[]): boolean | null {
  if (ruw === '') return false
  const genormaliseerd = normaliseerKop(ruw)
  if (JA_WAARDEN.includes(genormaliseerd)) return true
  if (NEE_WAARDEN.includes(genormaliseerd)) return false
  fouten.push(`Mandataris "${kort(ruw, 20)}" is geen geldige waarde. Vul Ja of Nee in, of laat leeg voor Nee.`)
  return null
}

interface DubbelControle {
  /** Ondernemingsnummers die al in de databank staan. */
  bestaand: Set<string>
  /** Nummers eerder in dít bestand, met het rijnummer erbij. */
  gezien: Map<string, number>
}

function leesOndernemingsnummer(
  ruw: string,
  excelRij: number,
  dubbels: DubbelControle,
  fouten: string[],
  waarschuwingen: string[]
): string | null {
  if (ruw === '') return null

  const genormaliseerd = normaliseerOndernemingsnummer(ruw)
  if (genormaliseerd === null) {
    fouten.push(
      `Ondernemingsnummer "${kort(ruw, 30)}" is geen Belgisch ondernemingsnummer: verwacht 10 cijfers, bijvoorbeeld BE0123.456.749.`
    )
    return null
  }

  const sleutel = ondernemingsnummerSleutel(genormaliseerd) as string
  const eerdereRij = dubbels.gezien.get(sleutel)
  if (eerdereRij !== undefined) {
    fouten.push(`Ondernemingsnummer ${genormaliseerd} staat ook al op rij ${eerdereRij} van dit bestand.`)
    return null
  }
  if (dubbels.bestaand.has(sleutel)) {
    fouten.push(`Er bestaat al een klant met ondernemingsnummer ${genormaliseerd}.`)
    return null
  }
  dubbels.gezien.set(sleutel, excelRij)

  if (!heeftGeldigControlegetal(genormaliseerd)) {
    waarschuwingen.push(`Het controlegetal van ${genormaliseerd} klopt niet — controleer het nummer op een typfout.`)
  }
  return genormaliseerd
}

function leesRij(ruw: Record<KolomSleutel, string>, excelRij: number, dubbels: DubbelControle): ImportRij {
  const fouten: string[] = []
  const waarschuwingen: string[] = []

  const naam = leesNaam(ruw.naam, fouten, waarschuwingen)
  const ondernemingsnummer = leesOndernemingsnummer(ruw.ondernemingsnummer, excelRij, dubbels, fouten, waarschuwingen)
  const rechtsvorm = leesRechtsvorm(ruw.rechtsvorm, fouten)
  const boekjaar = leesBoekjaareinde(ruw.boekjaar_einde_maand, ruw.boekjaar_einde_dag, fouten, waarschuwingen)
  const regime = leesRegime(ruw.btw_regime, fouten)
  const frequentie = leesFrequentie(ruw.btw_aangifte_frequentie, regime, fouten)
  const mandataris = leesMandataris(ruw.mandataris, fouten)

  const geldig =
    fouten.length === 0 && naam !== null && boekjaar !== null && regime !== null && mandataris !== null && frequentie !== 'fout'

  return {
    excelRij,
    ruw,
    fouten,
    waarschuwingen,
    klant: geldig
      ? {
          naam: naam as string,
          ondernemingsnummer,
          rechtsvorm,
          boekjaar_einde_maand: (boekjaar as Boekjaareinde).maand,
          boekjaar_einde_dag: (boekjaar as Boekjaareinde).dag,
          btw_regime: regime as BtwRegime,
          btw_aangifte_frequentie: frequentie as BtwFrequentie | null,
          mandataris: mandataris as boolean,
        }
      : null,
  }
}

// --------------------------------------------------------------- blad

export interface Werkblad {
  sheet: string
  data: unknown[][]
}

/** Welk blad we inlezen. Het sjabloon heeft een tweede blad met uitleg, en
 *  gebruikers verplaatsen bladen; daarom eerst op naam zoeken en pas daarna
 *  terugvallen op het eerste blad. */
export function kiesBlad(bladen: Werkblad[]): Werkblad {
  if (bladen.length === 0) {
    throw new KlantImportFout('Dit werkboek bevat geen enkel blad.')
  }
  return bladen.find((b) => normaliseerKop(b.sheet) === 'klanten') ?? bladen[0]
}

/**
 * Leest de cellen van één werkblad en zegt per rij of ze naar de databank kan.
 * Gooit een KlantImportFout wanneer het bestand als geheel niet bruikbaar is.
 */
export function leesKlantRijen(data: unknown[][], opties: LeesOpties = {}, bladnaam = 'Klanten'): ImportVoorbeeld {
  const kopregel = leesKopregel(data)

  const dubbels: DubbelControle = {
    bestaand: new Set(
      (opties.bestaandeOndernemingsnummers ?? [])
        .map((n) => ondernemingsnummerSleutel(celTekst(n)))
        .filter((n): n is string => n !== null)
    ),
    gezien: new Map(),
  }

  const rijen: ImportRij[] = []
  let legeRijenOvergeslagen = 0

  for (let index = kopregel.index + 1; index < data.length; index++) {
    const cellen = data[index] ?? []
    const ruw = Object.fromEntries(
      KOLOMMEN.map((kolom) => {
        const positie = kopregel.posities[kolom.sleutel]
        return [kolom.sleutel, positie === undefined ? '' : celTekst(cellen[positie])]
      })
    ) as Record<KolomSleutel, string>

    // Een lege rij onderaan (of tussenin) is de regel in Excel, geen fout.
    if (KOLOMMEN.every((kolom) => ruw[kolom.sleutel] === '')) {
      legeRijenOvergeslagen++
      continue
    }

    // Vroeg stoppen: bij een bestand van 50.000 rijen mag het scherm niet
    // eerst 50.000 rijobjecten bouwen om daarna te weigeren.
    if (rijen.length >= MAX_RIJEN) {
      throw new KlantImportFout(
        `Dit bestand bevat meer dan ${MAX_RIJEN} klanten. Splits het op in kleinere bestanden en importeer ze na elkaar.`
      )
    }

    rijen.push(leesRij(ruw, index + 1, dubbels))
  }

  return {
    bladnaam,
    rijen,
    aantalGeldig: rijen.filter((r) => r.klant !== null).length,
    legeRijenOvergeslagen,
    onbekendeKolommen: kopregel.onbekendeKolommen,
  }
}
