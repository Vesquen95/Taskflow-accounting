import { describe, expect, it } from 'vitest'

// Rechtstreeks van schijf: in de tests maakt vitest van elke CSS-import een
// lege tekst (css: false in vite.config.ts), ook met ?raw. De node-types staan
// niet in de tsconfig van src, vandaar de getypte dynamische import.
const fsNaam = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsNaam)) as {
  readFileSync: (pad: string, codering: 'utf8') => string
}
// Vitest draait vanuit de map van het project.
const css = readFileSync('src/index.css', 'utf8')

/**
 * Een standaardkleur voor velden in de basisstijl mag nooit zwaarder wegen dan
 * een klasse op het veld zelf. Op 15/10/2026 deed `input:not(...)` dat wel:
 * de donkere velden van het inlogscherm werden wit, met witte tekst erin, zodat
 * niet te zien was wat je typte. De tests in jsdom rekenen geen CSS uit; deze
 * test bewaakt daarom de regel zelf.
 */
describe('de basisstijl voor velden', () => {
  it('staat in :where(), zodat een klasse op het veld altijd wint', () => {
    expect(css).toMatch(/:where\(input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\), select, textarea\)/)
  })

  it('leest echt het bestand (geen lege tekst)', () => {
    expect(css).toContain('@tailwind base')
  })

  it('heeft geen kale input-, select- of textarea-regel met een kleur', () => {
    // De vinkjeskleur (accent-color) mag wel kaal: daar staat nooit een klasse
    // tegenover. Een algemene veldregel niet.
    const kaal = css.split('\n').filter((r) => /^\s*(input:not\(|select\s*[,{]|textarea\s*[,{])/.test(r))
    expect(kaal).toEqual([])
  })
})
