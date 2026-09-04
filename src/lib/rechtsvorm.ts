/**
 * De rechtsvorm van een klant, voor zover we die kunnen herkennen.
 *
 * `clients.rechtsvorm` is vrije tekst met een suggestielijst, en dat blijft zo:
 * er bestaan meer vormen dan een keuzelijst ooit bijhoudt, en een klant met een
 * buitenlandse of ongebruikelijke vorm mag daar niet op stranden.
 *
 * Daarom drie uitkomsten en niet twee. "Onbekend" is een echt antwoord: het
 * betekent dat het systeem het niet weet, en dan is niets weigeren beter dan
 * gokken. Een verplichting blokkeren op onwetendheid zou een taks kunnen
 * verbergen die de klant wél verschuldigd is.
 */
export type RechtsvormSoort = 'vereniging' | 'vennootschap' | 'onbekend'

/** Vergelijkingsvorm: kleine letters, zonder accenten, punten of spaties. Zo
 *  vallen "VZW", "vzw" en "V.Z.W." samen. */
function normaliseer(tekst: string): string {
  return tekst
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** Verenigingen en stichtingen: dit zijn de vormen die onderworpen zijn aan de
 *  patrimoniumtaks. Een feitelijke vereniging staat er bewust niet bij — die
 *  heeft geen rechtspersoonlijkheid en valt er dus buiten. */
const VERENIGINGEN = ['vzw', 'ivzw', 'stichting', 'privatestichting', 'vereniging', 'asbl', 'aisbl']

/** Vennootschapsvormen. Deze lijst dient enkel om met zekerheid te kunnen
 *  zeggen "dit is géén vereniging"; wat er niet in staat blijft onbekend. */
const VENNOOTSCHAPPEN = [
  'bv', 'bvba', 'nv', 'commv', 'commva', 'vof', 'cv', 'cvba', 'cvoa',
  'se', 'sce', 'eenmanszaak', 'ebvba', 'lv', 'vzwvennootschap',
]

export function rechtsvormSoort(rechtsvorm: string | null | undefined): RechtsvormSoort {
  const genormaliseerd = normaliseer(rechtsvorm ?? '')
  if (genormaliseerd === '') return 'onbekend'
  // Een exacte treffer weegt zwaarder dan een deeltreffer: "vzwvennootschap"
  // bestaat niet, maar een vorm die toevallig "cv" bevat wel.
  if (VERENIGINGEN.includes(genormaliseerd)) return 'vereniging'
  if (VENNOOTSCHAPPEN.includes(genormaliseerd)) return 'vennootschap'
  if (VERENIGINGEN.some((v) => genormaliseerd.includes(v))) return 'vereniging'
  return 'onbekend'
}

/** Is de patrimoniumtaks hier aan de orde?
 *
 *  Alleen verenigingen en stichtingen betalen ze. Bij een onbekende rechtsvorm
 *  zeggen we ja: het systeem weet het dan niet, en een taks verbergen omdat
 *  het veld leeg is, is erger dan er een aanbieden die niet nodig blijkt. */
export function kanPatrimoniumtaksHebben(rechtsvorm: string | null | undefined): boolean {
  return rechtsvormSoort(rechtsvorm) !== 'vennootschap'
}

/** Vormen zonder rechtspersoonlijkheid: de ondernemer ís de natuurlijke
 *  persoon. Ze staan wel in VENNOOTSCHAPPEN hierboven -- die lijst dient om
 *  "dit is géén vereniging" te kunnen zeggen -- maar voor het UBO-register
 *  maakt het verschil wél uit. */
const ZONDER_RECHTSPERSOONLIJKHEID = ['eenmanszaak', 'feitelijkevereniging']

/**
 * Is deze klant informatieplichtig voor het UBO-register?
 *
 * De wet noemt: vennootschappen, (i)vzw's en stichtingen, trusts en
 * fiducieën. Een eenmanszaak niet -- daar is geen entiteit om achter te
 * kijken. Een natuurlijke persoon evenmin.
 *
 * Bij een onbekende rechtsvorm zeggen we ja, om dezelfde reden als bij de
 * patrimoniumtaks: het systeem weet het dan niet, en een wettelijke
 * verplichting verbergen omdat een veld leeg is, is erger dan er een
 * aanbieden die achteraf niet nodig blijkt. Zo goed als elke rechtspersoon is
 * hier trouwens informatieplichtig.
 */
export function heeftUboVerplichting(
  klantsoort: 'rechtspersoon' | 'natuurlijk_persoon',
  rechtsvorm: string | null | undefined
): boolean {
  if (klantsoort === 'natuurlijk_persoon') return false
  return !ZONDER_RECHTSPERSOONLIJKHEID.includes(normaliseer(rechtsvorm ?? ''))
}
