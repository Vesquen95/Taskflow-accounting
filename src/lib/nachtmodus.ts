/**
 * De nachtmodus: de hele app donker, zoals het inlogscherm.
 *
 * Een persoonlijke keuze van wie aan het scherm zit, dus in de opslag van de
 * browser en niet in de databank. Ze werkt via één attribuut op <html>
 * (`data-modus="nacht"`); de kleuren zelf lopen via CSS-variabelen
 * (tailwind.config.js), dus geen enkel scherm hoeft ervan te weten.
 *
 * Zoals bij de sessiestempels (sessieopslag.ts) is elke toegang tot de opslag
 * afgeschermd: in een privévenster kan localStorage gooien, en dan blijft de
 * keuze gewoon voor dit tabblad gelden.
 */

export const NACHTMODUS_SLEUTEL = 'taskflow.weergave.nachtmodus'

export function leesNachtmodus(): boolean {
  try {
    return window.localStorage.getItem(NACHTMODUS_SLEUTEL) === 'aan'
  } catch {
    return false
  }
}

/** Zet het attribuut op <html>. Ook vóór de eerste render, tegen een flits. */
export function pasNachtmodusToe(aan: boolean): void {
  if (aan) document.documentElement.dataset.modus = 'nacht'
  else delete document.documentElement.dataset.modus
}

export function bewaarNachtmodus(aan: boolean): void {
  pasNachtmodusToe(aan)
  try {
    if (aan) window.localStorage.setItem(NACHTMODUS_SLEUTEL, 'aan')
    else window.localStorage.removeItem(NACHTMODUS_SLEUTEL)
  } catch {
    // Geen opslag: de keuze geldt dan alleen voor dit tabblad.
  }
}
