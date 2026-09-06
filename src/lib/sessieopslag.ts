/**
 * De tijdstempels van de sessie, in de opslag van de browser.
 *
 * Waarom localStorage en niet gewoon een variabele in het geheugen: het
 * kantoor werkt met meerdere tabbladen open (een dossier hier, de kalender
 * daar). Wie in het ene tabblad zit te typen is niet inactief in het andere.
 * Door de stempel te delen ziet elk tabblad dezelfde laatste activiteit.
 *
 * Elke bewerking is afgeschermd met try/catch. localStorage kan gewoonweg
 * gooien -- een privévenster, een browser die opslag per site blokkeert, of
 * een volle quota. Dat mag de app niet omver halen: zonder opslag valt de
 * bewaking terug op het geheugen van dit ene tabblad, en werkt de afmelding
 * nog steeds, alleen niet meer gedeeld.
 */
import type { Verloopreden } from './sessieduur'

const SLEUTEL_START = 'taskflow.sessie.start'
const SLEUTEL_ACTIVITEIT = 'taskflow.sessie.activiteit'
const SLEUTEL_REDEN = 'taskflow.sessie.reden'

function lees(sleutel: string): string | null {
  try {
    return window.localStorage.getItem(sleutel)
  } catch {
    return null
  }
}

function schrijf(sleutel: string, waarde: string): void {
  try {
    window.localStorage.setItem(sleutel, waarde)
  } catch {
    // Geen opslag beschikbaar. Zie de kop van dit bestand.
  }
}

function wis(sleutel: string): void {
  try {
    window.localStorage.removeItem(sleutel)
  } catch {
    // idem
  }
}

function alsGetal(ruw: string | null): number | null {
  if (ruw === null) return null
  const n = Number(ruw)
  return Number.isFinite(n) ? n : null
}

/**
 * Het moment van aanmelden, maar alleen als de stempel van déze gebruiker is.
 *
 * De koppeling aan het gebruikers-id is geen detail: op een gedeelde pc zou
 * de collega die na jou aanmeldt anders jouw twaalf uur erven en meteen weer
 * buiten vliegen.
 */
export function leesStart(uid: string): number | null {
  const ruw = lees(SLEUTEL_START)
  if (ruw === null) return null
  const scheiding = ruw.indexOf('|')
  if (scheiding < 0) return null
  if (ruw.slice(0, scheiding) !== uid) return null
  return alsGetal(ruw.slice(scheiding + 1))
}

export function schrijfStart(uid: string, moment: number): void {
  schrijf(SLEUTEL_START, `${uid}|${moment}`)
}

export function leesActiviteit(): number | null {
  return alsGetal(lees(SLEUTEL_ACTIVITEIT))
}

export function schrijfActiviteit(moment: number): void {
  schrijf(SLEUTEL_ACTIVITEIT, String(moment))
}

/**
 * Weg met de stempels. Hoort bij élke wissel van sessie: bij het afmelden,
 * maar net zo goed bij het aanmelden -- anders begint een verse aanmelding
 * met de stempels van de vorige, die al verlopen kunnen zijn.
 */
export function wisSessiestempels(): void {
  wis(SLEUTEL_START)
  wis(SLEUTEL_ACTIVITEIT)
}

/**
 * Blijft één navigatie liggen: het aanmeldscherm leest hem en wist hem daarna.
 *
 * Lezen en wissen staan bewust apart. Anders zou het aanmeldscherm de reden
 * al kwijt zijn voor het ze getoond heeft -- React roept een
 * useState-beginwaarde in ontwikkelmodus twee keer aan, en de tweede zou dan
 * niets meer vinden.
 */
export function bewaarVerloopreden(reden: Verloopreden): void {
  schrijf(SLEUTEL_REDEN, reden)
}

export function leesVerloopreden(): Verloopreden | null {
  const ruw = lees(SLEUTEL_REDEN)
  if (ruw === 'inactiviteit' || ruw === 'sessieduur') return ruw
  return null
}

export function wisVerloopreden(): void {
  wis(SLEUTEL_REDEN)
}
