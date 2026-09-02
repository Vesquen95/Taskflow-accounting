import { describe, expect, it } from 'vitest'
import {
  buitenlandseBtwDeadline,
  buitenlandseBtwJaren,
  buitenlandseBtwTitel,
} from './taakLabel'

describe('de sneltoets voor de teruggaaf van buitenlandse btw', () => {
  it('legt de deadline op 30 september van het jaar ná het teruggaafjaar', () => {
    // Dit is de fout die de sneltoets moet voorkomen: de btw van 2025 vraag je
    // terug tegen 30 september 2026, niet 2025.
    expect(buitenlandseBtwDeadline(2025)).toBe('2026-09-30')
    expect(buitenlandseBtwDeadline(2026)).toBe('2027-09-30')
  })

  it('noemt het jaar waarover de btw gaat, niet het jaar van indienen', () => {
    expect(buitenlandseBtwTitel(2025)).toBe('Teruggaaf buitenlandse btw 2025')
  })

  it('biedt het lopende jaar en de twee ervoor aan', () => {
    expect(buitenlandseBtwJaren(new Date(2026, 8, 2))).toEqual([2026, 2025, 2024])
  })
})
