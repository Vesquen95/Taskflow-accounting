/**
 * De begroeting na het inloggen: "Toegang verleend. Good afternoon, Wibren."
 *
 * Het inlogscherm kent je naam nog niet (vóór het inloggen leest het niets
 * uit de databank), en het verdwijnt zodra de sessie er is. Daarom zet het
 * vóór het aanmelden een vlag in de sessie-opslag van dit tabblad; de app
 * leest die zodra de medewerker geladen is, begroet één keer en wist ze. Wie
 * de pagina herlaadt met een lopende sessie, wordt dus niet opnieuw begroet.
 *
 * Het geluid is een keuze van wie aan het scherm zit, standaard uit: het
 * intronummer uit Suno (lib/geluid.ts). Gevraagd (29/10/2026): geen andere
 * stemmen, geen gesproken zinnen van de browser en geen keuze van
 * aanspreking meer -- alleen dat nummer. Zoals bij de nachtmodus is elke
 * toegang tot de opslag afgeschermd.
 */

const VLAG = 'taskflow.begroeting'
// De sleutel heet nog naar de stem van vroeger; zo blijft wie het geluid al
// aanzette, het aan hebben.
export const GELUID_SLEUTEL = 'taskflow.weergave.stem'

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

/** "Good afternoon, Wibren." */
export function begroetingTekst(uur: number, naam: string): string {
  return `${groet(uur)}, ${voornaam(naam)}.`
}

export function leesGeluid(): boolean {
  try {
    return window.localStorage.getItem(GELUID_SLEUTEL) === 'aan'
  } catch {
    return false
  }
}

export function bewaarGeluid(aan: boolean): void {
  try {
    if (aan) window.localStorage.setItem(GELUID_SLEUTEL, 'aan')
    else window.localStorage.removeItem(GELUID_SLEUTEL)
  } catch {
    // Geen opslag: de keuze geldt dan niet.
  }
}
