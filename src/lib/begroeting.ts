/**
 * De begroeting na het inloggen: "Toegang verleend", met een filmcitaat.
 *
 * Het inlogscherm kent je naam nog niet (vóór het inloggen leest het niets
 * uit de databank), en het verdwijnt zodra de sessie er is. Daarom zet het
 * vóór het aanmelden een vlag in de sessie-opslag van dit tabblad; de app
 * leest die zodra de medewerker geladen is, begroet één keer en wist ze. Wie
 * de pagina herlaadt met een lopende sessie, wordt dus niet opnieuw begroet.
 *
 * Geluid en een gesproken of getoonde groet zijn er niet meer: die gingen
 * eruit op 29/10/2026 ("haal alles van het geluid en tekst eruit").
 */

const VLAG = 'taskflow.begroeting'

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
