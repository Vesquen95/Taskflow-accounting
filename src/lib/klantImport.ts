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
 *  - de btw-verplichtingen aanvinken: die volgen automatisch uit het
 *    btw-regime (trigger sync_btw_obligations, migratie 0004). Een kolom
 *    ervoor zou beloven dat je ze los kunt zetten, en dat kan niet.
 *  - de neerlegging bij de NBB: die taak hangt aan de algemene vergadering en
 *    wordt door de motor mee aangemaakt zodra een klant een AV heeft (de
 *    voorlopige datum is AV + 30 dagen, en wordt echt berekend zodra de AV
 *    afgerond is). Een eigen kolom zou een vinkje zijn dat niets doet.
 *  - vertrouwelijkheid en de standaard verantwoordelijke, zie hierboven.
 *
 * De instellingen per verplichting (de statutaire AV-datum, de doorlooptijd
 * van de jaarafsluiting, de rapporteringsfrequentie) staan wél in het bestand,
 * elk in een eigen kolom. Ze zijn per dossier verschillend, en zonder die
 * kolommen moet elk geïmporteerd dossier daarna alsnog één voor één
 * opengezet worden -- precies wat een import moet vermijden. Een lege cel
 * betekent overal: de standaardwaarde van het klantformulier.
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

/** De verplichtingen die per kolom aan of uit gezet kunnen worden. De sleutel
 *  is de code uit obligation_types: zo kan er geen vertaaltabel tussen het
 *  sjabloon en de databank scheef gaan staan.
 *
 *  Niet in deze lijst: btw_aangifte en btw_klantenlisting (volgen uit het
 *  btw-regime) en neerlegging_jaarrekening (hangt aan de AV). Zie de
 *  toelichting bovenaan dit bestand. */
export type VerplichtingSleutel =
  | 'algemene_vergadering'
  | 'jaarafsluiting'
  | 'aangifte_venb_pb'
  | 'aangifte_rpb'
  | 'va_venb'
  | 'rapportering'
  | 'fiche_281_20'
  | 'fiche_281_45'
  | 'fiche_281_50'

/** De kolommen die de instellingen van een verplichting dragen. Ze staan los
 *  van het Ja/Nee-vinkje: een parameter invullen zonder de verplichting aan te
 *  vinken is een fout, geen stille instelling die nergens werkt. */
export type ParameterSleutel =
  | 'av_datum'
  | 'jaarafsluiting_deadline'
  | 'rapportering_frequentie'
  | 'rapportering_termijn'

export type KolomSleutel =
  | 'naam'
  | 'ondernemingsnummer'
  | 'rechtsvorm'
  | 'boekjaar_einde_maand'
  | 'boekjaar_einde_dag'
  | 'btw_regime'
  | 'btw_aangifte_frequentie'
  | 'mandataris'
  | VerplichtingSleutel
  | ParameterSleutel

export interface Kolom {
  sleutel: KolomSleutel
  /** Gezet op de kolommen die een verplichting aan- of uitzetten. Ja/Nee, en
   *  leeg telt als Nee. */
  verplichting?: true
  /** Gezet op de kolommen die een instelling van zo'n verplichting dragen. */
  instelling?: true
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

/** Een kolom per verplichting, zodat een geïmporteerde klant niet daarna nog
 *  één voor één geopend moet worden. Ja/Nee; leeg telt als Nee.
 *
 *  De parameters krijgen dezelfde standaardwaarden als wanneer je het vakje in
 *  het klantformulier aanvinkt. Voor de algemene vergadering betekent dat:
 *  geen statutaire datum, en dan rekent de motor met de wettelijke uiterste
 *  datum (boekjaareinde + zes maanden). Dat is een echte datum, maar zelden de
 *  dag waarop de vergadering werkelijk plaatsvindt — vandaar de uitleg in het
 *  sjabloon. */
const VERPLICHTING_KOLOMMEN: readonly Kolom[] = [
  {
    sleutel: 'algemene_vergadering',
    kop: 'Algemene vergadering',
    vereist: false,
    verplichting: true,
    uitleg:
      'Ja of Nee. De neerlegging bij de NBB komt hier vanzelf bij: die taak hangt aan de algemene vergadering. Zonder statutaire datum rekent Taskflow met de wettelijke uiterste datum (zes maanden na het boekjaareinde); vul de statuten daarna in het klantdossier in.',
    synoniemen: ['av', 'algemenevergaderingav', 'jaarvergadering'],
    breedte: 22,
  },
  {
    sleutel: 'jaarafsluiting',
    kop: 'Jaarafsluiting',
    vereist: false,
    verplichting: true,
    uitleg: 'Ja of Nee. Standaard klaar binnen 3 maanden na het boekjaareinde; per klant aan te passen in het dossier.',
    synoniemen: ['afsluiting', 'jaarrekening'],
    breedte: 16,
  },
  {
    sleutel: 'aangifte_venb_pb',
    kop: 'Aangifte VenB',
    vereist: false,
    verplichting: true,
    uitleg: 'Ja of Nee.',
    synoniemen: ['venb', 'aangiftevenbpb', 'vennootschapsbelasting'],
    breedte: 16,
  },
  {
    sleutel: 'aangifte_rpb',
    kop: 'Aangifte RPB',
    vereist: false,
    verplichting: true,
    uitleg:
      'Ja of Nee. De rechtspersonenbelasting, voor VZW\'s, IVZW\'s en stichtingen. Een klant valt onder de vennootschapsbelasting óf onder de rechtspersonenbelasting, dus niet samen met "Aangifte VenB".',
    synoniemen: ['rpb', 'aangifterpb', 'rechtspersonenbelasting'],
    breedte: 16,
  },
  {
    sleutel: 'va_venb',
    kop: 'Voorafbetalingen',
    vereist: false,
    verplichting: true,
    uitleg: 'Ja of Nee. Levert VA1 tot en met VA4 per boekjaar op.',
    synoniemen: ['va', 'vas', 'voorafbetaling', 'vavenb'],
    breedte: 18,
  },
  {
    sleutel: 'rapportering',
    kop: 'Rapportering',
    vereist: false,
    verplichting: true,
    uitleg: 'Ja of Nee. Standaard per kwartaal, 10 dagen na de periode; per klant aan te passen in het dossier.',
    synoniemen: ['periodiekerapportering'],
    breedte: 16,
  },
  {
    sleutel: 'fiche_281_20',
    kop: 'Fiche 281.20',
    vereist: false,
    verplichting: true,
    uitleg: 'Ja of Nee. Bezoldigingen van bedrijfsleiders; uiterlijk eind februari van het jaar erna.',
    synoniemen: ['28120', 'fiche28120', 'bedrijfsleiders'],
    breedte: 15,
  },
  {
    sleutel: 'fiche_281_45',
    kop: 'Fiche 281.45',
    vereist: false,
    verplichting: true,
    uitleg: 'Ja of Nee. Auteursrechten; uiterlijk eind februari van het jaar erna.',
    synoniemen: ['28145', 'fiche28145', 'auteursrechten'],
    breedte: 15,
  },
  {
    sleutel: 'fiche_281_50',
    kop: 'Fiche 281.50',
    vereist: false,
    verplichting: true,
    uitleg: 'Ja of Nee. Commissies, makelaarslonen en erelonen; uiterlijk 30 juni van het jaar erna.',
    synoniemen: ['28150', 'fiche28150', 'erelonen', 'commissies'],
    breedte: 15,
  },
]

/** De instellingen per verplichting. Ze staan als eigen kolommen naast het
 *  vinkje en niet ín het vinkje ("Ja" versus "3 maanden"): een kolom die soms
 *  een ja/nee en soms een instelling bevat is in een lijst van honderd rijen
 *  niet meer te lezen, en al helemaal niet te sorteren of te filteren.
 *
 *  Een lege cel betekent overal: de standaardwaarde, dezelfde die het
 *  klantformulier invult bij het aanvinken. */
const PARAMETER_KOLOMMEN: readonly Kolom[] = [
  {
    sleutel: 'av_datum',
    kop: 'AV statutaire datum',
    vereist: false,
    instelling: true,
    uitleg:
      'Optioneel, alleen bij een aangevinkte algemene vergadering. Een vaste datum ("15/05", "15 mei") of een n-de weekdag ("eerste maandag van juni", "laatste vrijdag van mei"). Leeg laten mag: dan rekent Taskflow met de wettelijke uiterste datum, zes maanden na het boekjaareinde.',
    synoniemen: ['avdatum', 'statutairedatum', 'datumav', 'avstatuten'],
    breedte: 28,
  },
  {
    sleutel: 'jaarafsluiting_deadline',
    kop: 'Jaarafsluiting deadline',
    vereist: false,
    instelling: true,
    uitleg:
      'Optioneel, alleen bij een aangevinkte jaarafsluiting. Ofwel een aantal maanden na het boekjaareinde ("3", "3 maanden na boekjaareinde", 1 t.e.m. 12), ofwel voor de algemene vergadering ("1 maand voor AV", "voor AV", 1 t.e.m. 6). Leeg = 3 maanden na het boekjaareinde.',
    synoniemen: ['jaarafsluitingtermijn', 'afsluitingdeadline', 'jaarafsluitingberekening'],
    breedte: 30,
  },
  {
    sleutel: 'rapportering_frequentie',
    kop: 'Rapportering frequentie',
    vereist: false,
    instelling: true,
    uitleg: 'Optioneel, alleen bij aangevinkte rapportering. Maand / Kwartaal / Jaar. Leeg = Kwartaal.',
    synoniemen: ['frequentierapportering', 'rapporteringsfrequentie'],
    breedte: 22,
  },
  {
    sleutel: 'rapportering_termijn',
    kop: 'Rapportering termijn (dagen)',
    vereist: false,
    instelling: true,
    uitleg: 'Optioneel, alleen bij aangevinkte rapportering. Aantal dagen na de periode, 1 t.e.m. 90. Leeg = 10.',
    synoniemen: ['termijnrapportering', 'rapporteringtermijn', 'dagenrapportering'],
    breedte: 26,
  },
]

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
    kop: 'Fiscaal mandaat',
    vereist: false,
    uitleg: 'Ja of Nee. Leeg telt als Nee. Houdt het kantoor een fiscaal mandaat voor deze klant?',
    // 'mandataris' blijft herkend: bestanden die met het vorige sjabloon
    // gemaakt zijn moeten blijven werken, ook al heet de kolom nu anders.
    synoniemen: ['mandataris', 'mandaat', 'fiscaalmandaat'],
    breedte: 18,
  },
  ...VERPLICHTING_KOLOMMEN,
  ...PARAMETER_KOLOMMEN,
]

/**
 * De ingevulde voorbeeldrijen van het sjabloon. Twee, omdat één rij niet laat
 * zien dat de aangiftefrequentie leeg hoort te blijven zodra het regime geen
 * periodieke aangever is — precies de fout die de databank achteraf weigert.
 * De tweede rij toont meteen ook dat een verplichtingskolom leeg mag blijven:
 * dat telt als Nee.
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
    algemene_vergadering: 'Ja',
    jaarafsluiting: 'Ja',
    aangifte_venb_pb: 'Ja',
    aangifte_rpb: 'Nee',
    va_venb: 'Ja',
    rapportering: 'Ja',
    fiche_281_20: 'Ja',
    fiche_281_45: 'Nee',
    fiche_281_50: 'Ja',
    av_datum: '15/05',
    jaarafsluiting_deadline: '1 maand voor AV',
    rapportering_frequentie: 'Kwartaal',
    rapportering_termijn: '10',
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
    algemene_vergadering: 'Ja',
    jaarafsluiting: 'Ja',
    aangifte_venb_pb: 'Nee',
    aangifte_rpb: 'Ja',
    va_venb: 'Nee',
    rapportering: '',
    fiche_281_20: 'Nee',
    fiche_281_45: 'Nee',
    fiche_281_50: 'Nee',
    av_datum: 'eerste maandag van december',
    jaarafsluiting_deadline: '3',
    rapportering_frequentie: '',
    rapportering_termijn: '',
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

/** Eén aangevinkte verplichting, met wat het bestand erover zei. `parameters`
 *  bevat alléén wat er echt ingevuld stond; de standaardwaarden komen er bij
 *  het opslaan bij, langs dezelfde weg als in het klantformulier. Ze hier al
 *  invullen zou betekenen dat de import haar eigen standaarden bijhoudt naast
 *  die van het formulier, en dan lopen die twee vroeg of laat uiteen. */
export interface VerplichtingKeuze {
  code: VerplichtingSleutel
  parameters: Record<string, unknown>
}

export interface ImportRij {
  /** Het rijnummer zoals de gebruiker het in Excel ziet (1-gebaseerd). */
  excelRij: number
  /** Wat er in de cellen stond, voor de voorbeeldtabel. */
  ruw: Record<KolomSleutel, string>
  /** De klant die opgeslagen wordt, of null wanneer de rij fouten heeft. */
  klant: NieuweKlant | null
  /** De verplichtingen die aangevinkt staan, met de instellingen die het
   *  bestand meegaf. Los van `klant` gehouden: dat object bevat precies de
   *  kolommen van de tabel clients en niets anders. */
  verplichtingen: VerplichtingKeuze[]
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

/** Ja/Nee uit een cel. Leeg telt als Nee; alles wat geen van beide is, is een
 *  fout en geen stille Nee -- "Jz" mag niet als "die klant doet dit niet"
 *  doorgaan. */
function leesJaNee(ruw: string, kolomKop: string, fouten: string[]): boolean | null {
  if (ruw === '') return false
  const genormaliseerd = normaliseerKop(ruw)
  if (JA_WAARDEN.includes(genormaliseerd)) return true
  if (NEE_WAARDEN.includes(genormaliseerd)) return false
  fouten.push(`${kolomKop} "${kort(ruw, 20)}" is geen geldige waarde. Vul Ja of Nee in, of laat leeg voor Nee.`)
  return null
}

// -------------------------------------------------- instellingen

const RANGEN = ['eerste', 'tweede', 'derde', 'vierde', 'laatste']
const WEEKDAGEN = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']

const RAPPORTERING_LABELS: Record<string, string> = {
  maand: 'Maand',
  kwartaal: 'Kwartaal',
  jaar: 'Jaar',
}

const RAPPORTERING_VAN_TEKST: Record<string, string> = {
  maand: 'maand',
  maandelijks: 'maand',
  permaand: 'maand',
  kwartaal: 'kwartaal',
  perkwartaal: 'kwartaal',
  driemaandelijks: 'kwartaal',
  jaar: 'jaar',
  jaarlijks: 'jaar',
  perjaar: 'jaar',
}

/**
 * De statutaire AV-datum uit de parameters, zoals av_datum() in de databank
 * hem berekent (migratie 0020).
 *
 * Dit rekenwerk staat hier alleen om vóóraf te kunnen zeggen wat de databank
 * straks zal antwoorden: enforce_av_parameters() weigert een datum die niet
 * bestaat of die buiten de wettelijke zes maanden na het boekjaareinde valt.
 * De databank blijft de baas -- zou dit ooit iets anders zeggen, dan faalt de
 * rij alsnog bij het opslaan, met de melding van de databank erbij.
 */
function berekenAvDatum(
  boekjaarEinde: { jaar: number; maand: number; dag: number },
  parameters: Record<string, unknown>
): Date | null {
  const vorm = parameters.av_vorm as string | undefined
  const maand = parameters.av_maand as number | undefined
  if (!vorm || !maand) return null
  const be = new Date(boekjaarEinde.jaar, boekjaarEinde.maand - 1, boekjaarEinde.dag)

  // Twee pogingen: de maand in het jaar van het boekjaareinde, en zo nodig
  // dezelfde maand een jaar later. De AV valt per definitie ná het
  // boekjaareinde.
  for (const extra of [0, 1]) {
    const jaar = boekjaarEinde.jaar + extra
    let kandidaat: Date | null = null

    if (vorm === 'vaste_datum') {
      const dag = parameters.av_dag as number | undefined
      if (!dag) return null
      const laatsteDag = new Date(jaar, maand, 0).getDate()
      if (dag > laatsteDag) return null
      kandidaat = new Date(jaar, maand - 1, dag)
    } else {
      const rang = parameters.av_rang as string | undefined
      const weekdagIndex = WEEKDAGEN.indexOf((parameters.av_weekdag as string) ?? '')
      if (!rang || weekdagIndex === -1) return null
      // isodow: maandag = 1 ... zondag = 7.
      const doel = weekdagIndex + 1
      if (rang === 'laatste') {
        const laatste = new Date(jaar, maand, 0)
        const isodow = laatste.getDay() === 0 ? 7 : laatste.getDay()
        kandidaat = new Date(jaar, maand - 1, laatste.getDate() - ((isodow - doel + 7) % 7))
      } else {
        const eerste = new Date(jaar, maand - 1, 1)
        const isodow = eerste.getDay() === 0 ? 7 : eerste.getDay()
        const stap = ['eerste', 'tweede', 'derde', 'vierde'].indexOf(rang)
        if (stap === -1) return null
        kandidaat = new Date(jaar, maand - 1, 1 + ((doel - isodow + 7) % 7) + stap * 7)
      }
    }

    if (kandidaat > be) return kandidaat
  }
  return null
}

/** De statutaire AV-datum uit de cel. Leeg mag: dan is er geen statutaire
 *  datum en valt de motor terug op de wettelijke uiterste datum -- dezelfde
 *  regel als in het klantformulier, waar een plausibel ogende standaarddatum
 *  bewust ontbreekt. */
function leesAvDatum(
  ruw: string,
  boekjaar: Boekjaareinde | null,
  fouten: string[]
): Record<string, unknown> | null {
  if (ruw === '') return null

  const parameters: Record<string, unknown> = {}
  const genormaliseerd = normaliseerKop(ruw)

  // "eerste maandag van juni", "laatste vrijdag mei"
  const rang = RANGEN.find((r) => genormaliseerd.startsWith(r))
  if (rang) {
    const rest = genormaliseerd.slice(rang.length)
    const weekdag = WEEKDAGEN.find((w) => rest.startsWith(w))
    const maandNaam = weekdag ? MAANDNAMEN.find((m) => rest.endsWith(m)) : undefined
    if (!weekdag || !maandNaam) {
      fouten.push(
        `AV statutaire datum "${kort(ruw, 40)}" is onvolledig. Schrijf bijvoorbeeld "eerste maandag van juni".`
      )
      return null
    }
    parameters.av_vorm = 'nde_weekdag'
    parameters.av_rang = rang
    parameters.av_weekdag = weekdag
    parameters.av_maand = MAANDNAMEN.indexOf(maandNaam) + 1
  } else {
    // "15/05", "15-5", "15 mei"
    const cijfers = ruw.match(/^\s*(\d{1,2})\s*[-/.\s]\s*(\d{1,2})\s*$/)
    const metNaam = ruw.match(/^\s*(\d{1,2})\s*[-/.\s]?\s*([a-zA-Z]+)\s*$/)
    let dag: number | null = null
    let maand: number | null = null
    if (cijfers) {
      dag = Number(cijfers[1])
      maand = Number(cijfers[2])
    } else if (metNaam) {
      dag = Number(metNaam[1])
      const index = MAANDNAMEN.indexOf(normaliseerKop(metNaam[2]))
      maand = index === -1 ? null : index + 1
    }
    if (dag === null || maand === null || maand < 1 || maand > 12 || dag < 1 || dag > 31) {
      fouten.push(
        `AV statutaire datum "${kort(ruw, 40)}" is geen datum. Schrijf "15/05", "15 mei" of "eerste maandag van juni".`
      )
      return null
    }
    if (dag > DAGEN_PER_MAAND[maand - 1]) {
      fouten.push(
        `AV statutaire datum ${dag}/${maand} bestaat niet: ${MAANDNAMEN[maand - 1]} heeft hoogstens ${DAGEN_PER_MAAND[maand - 1]} dagen.`
      )
      return null
    }
    parameters.av_vorm = 'vaste_datum'
    parameters.av_maand = maand
    parameters.av_dag = dag
  }

  // De wettelijke termijn, dezelfde controle als enforce_av_parameters().
  // Zonder deze zou de rij er geldig uitzien en pas bij het opslaan sneuvelen.
  if (boekjaar) {
    const jaar = new Date().getFullYear()
    const be = { jaar, maand: boekjaar.maand, dag: boekjaar.dag }
    const av = berekenAvDatum(be, parameters)
    if (av === null) {
      fouten.push(
        `AV statutaire datum "${kort(ruw, 40)}" levert geen bruikbare datum op voor een boekjaar dat op ${boekjaar.dag}/${boekjaar.maand} eindigt.`
      )
      return null
    }
    const uiterste = new Date(jaar, boekjaar.maand - 1 + 6, boekjaar.dag)
    if (av > uiterste) {
      fouten.push(
        `AV statutaire datum "${kort(ruw, 40)}" valt buiten de wettelijke termijn: de algemene vergadering moet binnen zes maanden na het boekjaareinde (${boekjaar.dag}/${boekjaar.maand}) gehouden worden.`
      )
      return null
    }
  }

  return parameters
}

/** De deadline van de jaarafsluiting: een aantal maanden na het boekjaareinde,
 *  of een aantal maanden vóór de algemene vergadering (migratie 0029). De
 *  grenzen zijn die van de databank: 1-12 na het boekjaareinde, 1-6 voor de
 *  AV, want de AV valt zelf uiterlijk zes maanden na het boekjaareinde. */
function leesJaarafsluitingDeadline(ruw: string, fouten: string[]): Record<string, unknown> | null {
  if (ruw === '') return null

  const genormaliseerd = normaliseerKop(ruw)
  const getal = ruw.match(/\d+/)
  const aantal = getal ? Number(getal[0]) : null
  const voorAv = genormaliseerd.includes('voor') && genormaliseerd.includes('av')

  if (voorAv) {
    const maanden = aantal ?? 1
    if (maanden < 1 || maanden > 6) {
      fouten.push(
        `Jaarafsluiting deadline "${kort(ruw, 40)}": het aantal maanden voor de algemene vergadering moet tussen 1 en 6 liggen. De AV valt zelf uiterlijk zes maanden na het boekjaareinde.`
      )
      return null
    }
    return { basis: 'voor_av', maanden_voor_av: maanden }
  }

  if (aantal === null) {
    fouten.push(
      `Jaarafsluiting deadline "${kort(ruw, 40)}" is niet te lezen. Schrijf een aantal maanden na het boekjaareinde ("3") of voor de vergadering ("1 maand voor AV").`
    )
    return null
  }
  if (aantal < 1 || aantal > 12) {
    fouten.push(
      `Jaarafsluiting deadline "${kort(ruw, 40)}": de doorlooptijd moet tussen 1 en 12 maanden na het boekjaareinde liggen.`
    )
    return null
  }
  return { basis: 'boekjaar', sla_maanden: aantal }
}

function leesRapporteringFrequentie(ruw: string, fouten: string[]): string | null {
  if (ruw === '') return null
  const frequentie = RAPPORTERING_VAN_TEKST[normaliseerKop(ruw)]
  if (!frequentie) {
    fouten.push(
      `Rapportering frequentie "${kort(ruw, 30)}" is geen geldige waarde. Kies uit: ${Object.values(RAPPORTERING_LABELS).join(', ')}.`
    )
    return null
  }
  return frequentie
}

function leesRapporteringTermijn(ruw: string, fouten: string[]): number | null {
  if (ruw === '') return null
  const dagen = Number(ruw.replace(',', '.'))
  if (!Number.isInteger(dagen) || dagen < 1 || dagen > 90) {
    fouten.push(
      `Rapportering termijn "${kort(ruw, 30)}" is geen aantal dagen. Vul een getal van 1 tot en met 90 in.`
    )
    return null
  }
  return dagen
}

/** De aangevinkte verplichtingen van deze rij, met hun instellingen. Een
 *  onleesbare cel is een fout op de rij: bij een compliancetaak is "we hebben
 *  het maar overgeslagen" de slechtste uitkomst. */
function leesVerplichtingen(
  ruw: Record<KolomSleutel, string>,
  boekjaar: Boekjaareinde | null,
  fouten: string[]
): VerplichtingKeuze[] {
  const keuzes: VerplichtingKeuze[] = []
  for (const kolom of VERPLICHTING_KOLOMMEN) {
    const aan = leesJaNee(ruw[kolom.sleutel], kolom.kop, fouten)
    if (aan) keuzes.push({ code: kolom.sleutel as VerplichtingSleutel, parameters: {} })
  }

  const bij = (code: VerplichtingSleutel) => keuzes.find((k) => k.code === code)

  // Een dossier valt onder de vennootschapsbelasting óf onder de
  // rechtspersonenbelasting. De databank weigert allebei (migratie 0034); het
  // hier al zeggen scheelt een rij die er in het voorbeeld geldig uitziet en
  // pas bij het opslaan sneuvelt.
  if (bij('aangifte_venb_pb') && bij('aangifte_rpb')) {
    fouten.push(
      'Aangifte VenB en Aangifte RPB staan allebei op Ja. Een klant valt onder de vennootschapsbelasting óf onder de rechtspersonenbelasting, niet onder allebei.'
    )
  }

  /** Een instelling zonder haar verplichting is een fout en geen stille
   *  waarde: wie de kolom invult verwacht dat ze iets doet. */
  function eisAangevinkt(sleutel: ParameterSleutel, code: VerplichtingSleutel): VerplichtingKeuze | null {
    if (ruw[sleutel] === '') return null
    const keuze = bij(code)
    if (!keuze) {
      const kop = PARAMETER_KOLOMMEN.find((k) => k.sleutel === sleutel)!.kop
      const verplichting = VERPLICHTING_KOLOMMEN.find((k) => k.sleutel === code)!.kop
      fouten.push(`${kop} is ingevuld terwijl "${verplichting}" op Nee staat. Zet de verplichting op Ja of maak de cel leeg.`)
      return null
    }
    return keuze
  }

  const avKeuze = eisAangevinkt('av_datum', 'algemene_vergadering')
  if (avKeuze) {
    const parameters = leesAvDatum(ruw.av_datum, boekjaar, fouten)
    if (parameters) avKeuze.parameters = parameters
  }

  const jaKeuze = eisAangevinkt('jaarafsluiting_deadline', 'jaarafsluiting')
  if (jaKeuze) {
    const parameters = leesJaarafsluitingDeadline(ruw.jaarafsluiting_deadline, fouten)
    if (parameters) jaKeuze.parameters = parameters
  }

  const rapFrequentie = eisAangevinkt('rapportering_frequentie', 'rapportering')
  if (rapFrequentie) {
    const frequentie = leesRapporteringFrequentie(ruw.rapportering_frequentie, fouten)
    if (frequentie) rapFrequentie.parameters.frequentie = frequentie
  }
  const rapTermijn = eisAangevinkt('rapportering_termijn', 'rapportering')
  if (rapTermijn) {
    const dagen = leesRapporteringTermijn(ruw.rapportering_termijn, fouten)
    if (dagen !== null) rapTermijn.parameters.termijn_dagen = dagen
  }

  return keuzes
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
  const mandataris = leesJaNee(ruw.mandataris, 'Fiscaal mandaat', fouten)
  const verplichtingen = leesVerplichtingen(ruw, boekjaar, fouten)

  const geldig =
    fouten.length === 0 && naam !== null && boekjaar !== null && regime !== null && mandataris !== null && frequentie !== 'fout'

  return {
    excelRij,
    ruw,
    fouten,
    waarschuwingen,
    verplichtingen,
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
