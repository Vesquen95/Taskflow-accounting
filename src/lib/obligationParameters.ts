import type { ObligationType } from '../types'
import type { ObligationSelection } from './clientObligations'

export type ObligationParameters = Record<string, unknown>

/**
 * Wat het scherm toont moet zijn wat er opgeslagen wordt.
 *
 * Het formulier toonde vroeger standaardwaarden met `??` op het moment van
 * weergeven ("eerste maandag van juni", "3 maanden", "kwartaal"). Die waarden
 * bestonden alleen op het scherm: zolang de gebruiker de keuzelijst niet
 * aanraakte kwam er niets in `parameters` terecht. Wie de getoonde waarde net
 * de juiste vond en ze dus liet staan, sloeg een leeg of onvolledig object op.
 *
 * Daarom staan de standaardwaarden hier op één plek, en worden ze echt in
 * `parameters` geschreven zodra de verplichting aangevinkt is.
 */

/** De waarden die de motor zelf hanteert wanneer de parameter ontbreekt
 *  (migratie 0006: `coalesce(sla_maanden, 3)`, `coalesce(frequentie,
 *  'kwartaal')`, `coalesce(termijn_dagen, 10)`). Ze tonen én bewaren is dus
 *  precies hetzelfde gedrag, alleen zichtbaar en aanpasbaar. */
export const STANDAARD_PARAMETERS: Record<string, ObligationParameters> = {
  rapportering: { frequentie: 'kwartaal', termijn_dagen: 10 },
}

/**
 * De jaarafsluiting rekent op twee manieren, en dat is geen detail van het
 * scherm maar een keuze per dossier (migratie 0029).
 *
 * `boekjaar`  boekjaareinde + `sla_maanden`      -- een afgesproken doorlooptijd
 * `voor_av`   AV-datum - `maanden_voor_av`       -- klaar voor de vergadering
 *
 * De tweede is waarom dit bestaat: de boeken worden op de algemene
 * vergadering goedgekeurd, dus ze moeten daarvoor klaar zijn. Met een vaste
 * doorlooptijd van drie maanden viel de afsluiting bij een AV halverwege
 * maart net erna -- een deadline die er correct uitzag en te laat was.
 *
 * Een verplichting zonder `basis` is een dossier van voor 0029 en rekent
 * vanaf het boekjaareinde; die mogen hier niet stil van deadline veranderen.
 */
export const JAARAFSLUITING_BASIS_BOEKJAAR = 'boekjaar'
export const JAARAFSLUITING_BASIS_VOOR_AV = 'voor_av'

/** Per basis: het veld dat erbij hoort en de standaardwaarde ervan. De motor
 *  hanteert dezelfde waarden wanneer de parameter ontbreekt (0029:
 *  `coalesce(sla_maanden, 3)`, `coalesce(maanden_voor_av, 1)`). */
const JAARAFSLUITING_VELD: Record<string, { sleutel: string; standaard: number }> = {
  [JAARAFSLUITING_BASIS_BOEKJAAR]: { sleutel: 'sla_maanden', standaard: 3 },
  [JAARAFSLUITING_BASIS_VOOR_AV]: { sleutel: 'maanden_voor_av', standaard: 1 },
}

/** Welke basis er opgeslagen staat. Alles wat geen herkende waarde is telt
 *  als de boekjaarbasis -- dat is wat de motor ook doet, en de twee mogen
 *  niet uit elkaar lopen. */
export function jaarafsluitingBasis(parameters: ObligationParameters): string {
  return parameters.basis === JAARAFSLUITING_BASIS_VOOR_AV
    ? JAARAFSLUITING_BASIS_VOOR_AV
    : JAARAFSLUITING_BASIS_BOEKJAAR
}

/** De parameters na het kiezen van een basis: het veld van die basis blijft
 *  (of krijgt de standaardwaarde), dat van de andere gaat weg. Een achtergebleven
 *  `sla_maanden` naast `basis: 'voor_av'` staat nergens meer op het scherm en
 *  wordt tóch weer gebruikt zodra iemand terugschakelt. */
export function jaarafsluitingParametersVoorBasis(
  huidig: ObligationParameters,
  basis: string
): ObligationParameters {
  const veld = JAARAFSLUITING_VELD[basis] ?? JAARAFSLUITING_VELD[JAARAFSLUITING_BASIS_BOEKJAAR]
  const volgend: ObligationParameters = {}
  for (const [sleutel, waarde] of Object.entries(huidig)) {
    if (sleutel === 'basis') continue
    if (sleutel === 'sla_maanden' || sleutel === 'maanden_voor_av') continue
    volgend[sleutel] = waarde
  }
  volgend.basis = basis
  volgend[veld.sleutel] = huidig[veld.sleutel] ?? veld.standaard
  return volgend
}

/** Dezelfde inhoud? Dan geeft de aanvuller het oorspronkelijke object terug,
 *  want het formulier vult aan vanuit een effect dat op referentie kijkt. */
function zelfdeParameters(a: ObligationParameters, b: ObligationParameters): boolean {
  const sleutelsA = Object.keys(a)
  const sleutelsB = Object.keys(b)
  return (
    sleutelsA.length === sleutelsB.length &&
    sleutelsA.every((sleutel) => Object.is(a[sleutel], b[sleutel]))
  )
}

/** `algemene_vergadering` staat bewust NIET in STANDAARD_PARAMETERS. De
 *  statutaire AV-datum is een juridisch feit uit de statuten van dat ene
 *  dossier; een plausibel ogende standaard die niemand bewust gekozen heeft
 *  zou een verkeerde deadline opleveren die er correct uitziet. Niets
 *  ingevuld betekent hier: geen statutaire datum, de motor valt terug op de
 *  wettelijke uiterste datum (migratie 0020, enforce_av_parameters). */
export const AV_GEEN_STATUTAIRE_DATUM = '' as const

/** De AV-velden die bij een vorm horen. Velden van de andere vorm worden
 *  gewist bij het wisselen: een parameter bewaren die nergens meer op het
 *  scherm staat is dezelfde soort onwaarheid, alleen omgekeerd. */
const AV_VELDEN_PER_VORM: Record<string, string[]> = {
  vaste_datum: ['av_maand', 'av_dag'],
  nde_weekdag: ['av_maand', 'av_rang', 'av_weekdag'],
}

/** Vult de ontbrekende standaardparameters aan, zonder ooit een waarde te
 *  overschrijven die al ingevuld is (een bestaande klant bewerken mag niets
 *  stilletjes wijzigen). */
export function metStandaardParameters(code: string, huidig: ObligationParameters): ObligationParameters {
  if (code === 'jaarafsluiting') {
    // Niet via STANDAARD_PARAMETERS: welke waarde ontbreekt hangt hier af van
    // de gekozen basis. Een vaste lijst zou een dossier dat op de AV rekent
    // opnieuw een doorlooptijd geven.
    const aangevuld = jaarafsluitingParametersVoorBasis(huidig, jaarafsluitingBasis(huidig))
    return zelfdeParameters(huidig, aangevuld) ? huidig : aangevuld
  }
  const standaard = STANDAARD_PARAMETERS[code]
  if (!standaard) return huidig
  const ontbreekt = Object.keys(standaard).filter((sleutel) => huidig[sleutel] === undefined)
  if (ontbreekt.length === 0) return huidig
  const aangevuld = { ...huidig }
  for (const sleutel of ontbreekt) aangevuld[sleutel] = standaard[sleutel]
  return aangevuld
}

/** Eén parameter zetten; een lege waarde verwijdert de sleutel in plaats van
 *  er een lege string of NaN in te schrijven. */
export function metParameter(
  huidig: ObligationParameters,
  sleutel: string,
  waarde: unknown
): ObligationParameters {
  const volgend = { ...huidig }
  const leeg =
    waarde === undefined || waarde === null || waarde === '' || (typeof waarde === 'number' && Number.isNaN(waarde))
  if (leeg) delete volgend[sleutel]
  else volgend[sleutel] = waarde
  return volgend
}

/** De parameters na het kiezen van een AV-vorm: `av_vorm` erin, en alleen de
 *  al ingevulde AV-velden die bij die vorm horen blijven staan. Een lege vorm
 *  ('') wist de statutaire datum helemaal. */
export function avParametersVoorVorm(huidig: ObligationParameters, vorm: string): ObligationParameters {
  const behouden = AV_VELDEN_PER_VORM[vorm] ?? []
  const volgend: ObligationParameters = {}
  for (const [sleutel, waarde] of Object.entries(huidig)) {
    if (!sleutel.startsWith('av_')) volgend[sleutel] = waarde
    else if (behouden.includes(sleutel)) volgend[sleutel] = waarde
  }
  if (vorm) volgend.av_vorm = vorm
  return volgend
}

/** Zet de standaardparameters van alle aangevinkte verplichtingen echt in
 *  `parameters`. Geeft dezelfde array terug wanneer er niets te doen is, zodat
 *  dit veilig vanuit een effect aangeroepen kan worden. */
export function metStandaardParametersVoorSelecties(
  obligationTypes: ObligationType[],
  selections: ObligationSelection[]
): ObligationSelection[] {
  let gewijzigd = false
  const volgend = selections.map((sel) => {
    if (!sel.gekozen) return sel
    const code = obligationTypes.find((t) => t.id === sel.obligation_type_id)?.code
    if (!code) return sel
    const parameters = metStandaardParameters(code, sel.parameters ?? {})
    if (parameters === sel.parameters) return sel
    gewijzigd = true
    return { ...sel, parameters }
  })
  return gewijzigd ? volgend : selections
}
