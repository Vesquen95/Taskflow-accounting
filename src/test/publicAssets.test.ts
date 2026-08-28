import { describe, expect, it } from 'vitest'
// ?raw geeft de bestandsinhoud zoals ze op schijf staat. Dat is precies wat
// de browser als afbeelding te lezen krijgt, en het scheelt een afhankelijkheid
// op de node-types voor iets wat verder nergens in de app nodig is.
import logoBron from '../../public/rsm-logo.svg?raw'
import faviconBron from '../../public/favicon.svg?raw'

/**
 * De SVG's in public/ worden met een img-tag geladen, en dan geldt strikte
 * XML in plaats van de milde HTML-parser.
 *
 * Op 28/08/2026 stond het RSM-logo daardoor als gebroken afbeelding op de
 * site: er zaten twee opeenvolgende koppeltekens in een XML-commentaar, wat
 * XML verbiedt. Het bestand werd netjes met status 200 en het juiste
 * content-type geserveerd, dus elke controle die naar het netwerk keek stond
 * op groen. Het viel ook niet op bij het inline renderen tijdens de
 * ontwikkeling, want daar parst de HTML-parser en die is mild. Alleen als
 * afbeelding brak het.
 */
const BESTANDEN: [naam: string, bron: string][] = [
  ['rsm-logo.svg', logoBron],
  ['favicon.svg', faviconBron],
]

describe('SVG-bestanden in public/', () => {
  it.each(BESTANDEN)('%s is geldige XML', (_naam, bron) => {
    const doc = new DOMParser().parseFromString(bron, 'image/svg+xml')

    expect(doc.querySelector('parsererror')?.textContent ?? null).toBeNull()
    expect(doc.documentElement.tagName.toLowerCase()).toBe('svg')
  })

  it.each(BESTANDEN)('%s heeft een intrinsieke maat', (_naam, bron) => {
    // Zonder width en height kent de browser de verhouding niet. Met
    // `w-auto` wordt de breedte dan nul en verdwijnt het logo, zonder dat er
    // iets fout lijkt te gaan.
    const svg = new DOMParser().parseFromString(bron, 'image/svg+xml').documentElement

    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(0)
    expect(Number(svg.getAttribute('height'))).toBeGreaterThan(0)
    expect(svg.getAttribute('viewBox')).toMatch(/^[\d.\s-]+$/)
  })

  it('het logo draagt de merkkleuren van het kantoor', () => {
    for (const kleur of ['#009cde', '#3f9c35', '#888b8d']) {
      expect(logoBron.toLowerCase()).toContain(kleur)
    }
  })
})
