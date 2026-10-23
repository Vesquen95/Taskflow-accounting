/**
 * De begroeting na het inloggen: "Toegang verleend. Good afternoon, sir."
 *
 * Het inlogscherm kent je naam nog niet (vóór het inloggen leest het niets
 * uit de databank), en het verdwijnt zodra de sessie er is. Daarom zet het
 * vóór het aanmelden een vlag in de sessie-opslag van dit tabblad; de app
 * leest die zodra de medewerker geladen is, begroet één keer en wist ze. Wie
 * de pagina herlaadt met een lopende sessie, wordt dus niet opnieuw begroet.
 *
 * De stem is een keuze van wie aan het scherm zit, standaard uit, en loopt
 * via de spraak van de browser zelf: er gaat geen tekst naar een dienst
 * buiten. Gevraagd (23/10/2026): Engels, "zoals Jarvis zelf" -- dus een
 * Britse mannenstem als het toestel er een heeft. Welke stemmen er zijn,
 * hangt af van browser en toestel; zie kiesStem().
 *
 * De aanspreking (sir, ma'am of de voornaam) is ook een keuze per browser:
 * Taskflow weet van niemand hoe die aangesproken wil worden, dus standaard de
 * voornaam. Zoals bij de nachtmodus is elke toegang tot de opslag
 * afgeschermd.
 */

const VLAG = 'taskflow.begroeting'
export const STEM_SLEUTEL = 'taskflow.weergave.stem'
export const AANSPREKING_SLEUTEL = 'taskflow.weergave.aanspreking'

export type Aanspreking = 'naam' | 'sir' | 'maam'
export const AANSPREKINGEN: { waarde: Aanspreking; label: string }[] = [
  { waarde: 'naam', label: 'Voornaam' },
  { waarde: 'sir', label: 'Sir' },
  { waarde: 'maam', label: "Ma'am" },
]

export function markeerBegroeting(): void {
  try {
    window.sessionStorage.setItem(VLAG, '1')
  } catch {
    // Geen opslag: dan geen begroeting, verder niets.
  }
}

export function wisBegroeting(): void {
  try {
    window.sessionStorage.removeItem(VLAG)
  } catch {
    // idem
  }
}

export function moetBegroeten(): boolean {
  try {
    return window.sessionStorage.getItem(VLAG) === '1'
  } catch {
    return false
  }
}

/** "Good morning" tot 12 uur, "good afternoon" tot 18 uur, daarna "good evening". */
export function groet(uur: number): string {
  if (uur >= 5 && uur < 12) return 'Good morning'
  if (uur >= 12 && uur < 18) return 'Good afternoon'
  return 'Good evening'
}

/** De voornaam: het eerste woord van de naam zoals die in Taskflow staat. */
export function voornaam(naam: string): string {
  return naam.trim().split(/\s+/)[0] ?? ''
}

/** "Good afternoon, sir." -- of ma'am, of de voornaam. */
export function begroetingTekst(uur: number, aanspreking: Aanspreking, naam: string): string {
  const wie = aanspreking === 'sir' ? 'sir' : aanspreking === 'maam' ? "ma'am" : voornaam(naam)
  return `${groet(uur)}, ${wie}.`
}

export function leesAanspreking(): Aanspreking {
  try {
    const waarde = window.localStorage.getItem(AANSPREKING_SLEUTEL)
    return waarde === 'sir' || waarde === 'maam' ? waarde : 'naam'
  } catch {
    return 'naam'
  }
}

export function bewaarAanspreking(aanspreking: Aanspreking): void {
  try {
    if (aanspreking === 'naam') window.localStorage.removeItem(AANSPREKING_SLEUTEL)
    else window.localStorage.setItem(AANSPREKING_SLEUTEL, aanspreking)
  } catch {
    // Geen opslag: de keuze geldt dan niet.
  }
}

export function kanSpreken(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
}

export function leesStem(): boolean {
  try {
    return window.localStorage.getItem(STEM_SLEUTEL) === 'aan'
  } catch {
    return false
  }
}

export function bewaarStem(aan: boolean): void {
  try {
    if (aan) window.localStorage.setItem(STEM_SLEUTEL, 'aan')
    else window.localStorage.removeItem(STEM_SLEUTEL)
  } catch {
    // Geen opslag: de keuze geldt dan niet.
  }
}

// De Britse mannenstemmen van de gangbare browsers, de beste eerst: de
// "Natural"-stemmen van Edge, die van Windows, Chrome, en die van Apple.
const VOORKEUR = [/Ryan/i, /Thomas/i, /George/i, /Google UK English Male/i, /Daniel/i, /Arthur/i, /Oliver/i]

/** Een Britse stem, liefst een mannenstem uit de lijst; anders eender welke Engelse. */
export function kiesStem<S extends { name: string; lang: string }>(stemmen: S[]): S | undefined {
  const taal = (s: S) => s.lang.replace('_', '-').toLowerCase()
  const brits = stemmen.filter((s) => taal(s) === 'en-gb')
  for (const naam of VOORKEUR) {
    const stem = brits.find((s) => naam.test(s.name))
    if (stem) return stem
  }
  return brits[0] ?? stemmen.find((s) => taal(s).startsWith('en'))
}

/** Spreekt de tekst uit in het Engels, met een Britse stem als die er is. */
export function spreek(tekst: string): void {
  if (!kanSpreken()) return
  const spraak = window.speechSynthesis
  const zeg = () => {
    const zin = new SpeechSynthesisUtterance(tekst)
    zin.lang = 'en-GB'
    const stem = kiesStem(spraak.getVoices())
    if (stem) zin.voice = stem
    zin.rate = 0.97
    zin.pitch = 0.9
    spraak.cancel()
    spraak.speak(zin)
  }
  if (spraak.getVoices().length > 0) return zeg()
  // Chrome laadt zijn stemmen pas bij de eerste vraag: even wachten, en na
  // een korte tijd toch spreken, met de standaardstem.
  let gedaan = false
  const eenmaal = () => {
    if (gedaan) return
    gedaan = true
    spraak.removeEventListener?.('voiceschanged', eenmaal)
    zeg()
  }
  spraak.addEventListener?.('voiceschanged', eenmaal)
  window.setTimeout(eenmaal, 800)
}
