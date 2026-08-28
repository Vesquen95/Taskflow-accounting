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
  jaarafsluiting: { sla_maanden: 3 },
  rapportering: { frequentie: 'kwartaal', termijn_dagen: 10 },
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
export const AV_VELDEN_PER_VORM: Record<string, string[]> = {
  vaste_datum: ['av_maand', 'av_dag'],
  nde_weekdag: ['av_maand', 'av_rang', 'av_weekdag'],
}

/** Vult de ontbrekende standaardparameters aan, zonder ooit een waarde te
 *  overschrijven die al ingevuld is (een bestaande klant bewerken mag niets
 *  stilletjes wijzigen). */
export function metStandaardParameters(code: string, huidig: ObligationParameters): ObligationParameters {
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
