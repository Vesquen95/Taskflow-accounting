/**
 * De begroeting na het inloggen: "Toegang verleend. Goedemiddag, Wibren."
 *
 * Het inlogscherm kent je naam nog niet (vóór het inloggen leest het niets
 * uit de databank), en het verdwijnt zodra de sessie er is. Daarom zet het
 * vóór het aanmelden een vlag in de sessie-opslag van dit tabblad; de app
 * leest die zodra de medewerker geladen is, begroet één keer en wist ze. Wie
 * de pagina herlaadt met een lopende sessie, wordt dus niet opnieuw begroet.
 *
 * De stem is een keuze van wie aan het scherm zit, standaard uit, en loopt
 * via de spraak van de browser zelf: er gaat geen tekst naar een dienst
 * buiten. Zoals bij de nachtmodus is elke toegang tot de opslag afgeschermd.
 */

const VLAG = 'taskflow.begroeting'
export const STEM_SLEUTEL = 'taskflow.weergave.stem'

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

/** "Goedemorgen" tot 12 uur, "goedemiddag" tot 18 uur, daarna "goedenavond". */
export function groet(uur: number): string {
  if (uur >= 5 && uur < 12) return 'Goedemorgen'
  if (uur >= 12 && uur < 18) return 'Goedemiddag'
  return 'Goedenavond'
}

/** De voornaam: het eerste woord van de naam zoals die in Taskflow staat. */
export function voornaam(naam: string): string {
  return naam.trim().split(/\s+/)[0] ?? ''
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

/** Spreekt de tekst uit in het Nederlands, met een Belgische stem als die er is. */
export function spreek(tekst: string): void {
  if (!kanSpreken()) return
  const zin = new SpeechSynthesisUtterance(tekst)
  zin.lang = 'nl-BE'
  const stemmen = window.speechSynthesis.getVoices()
  const stem = stemmen.find((s) => s.lang === 'nl-BE') ?? stemmen.find((s) => s.lang.startsWith('nl'))
  if (stem) zin.voice = stem
  zin.rate = 1
  zin.pitch = 0.95
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(zin)
}
