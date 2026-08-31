import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKleinScherm, KLEIN_SCHERM_QUERY } from './useKleinScherm'
import { stelSchermIn } from '../test/kleinScherm'

let herstel: (() => void) | null = null
afterEach(() => {
  herstel?.()
  herstel = null
})

describe('useKleinScherm', () => {
  it('houdt het op de computerversie wanneer matchMedia niet bestaat', () => {
    // Een omgeving zonder matchMedia (een test, een oude browser) mag niet
    // stilvallen én mag niet per ongeluk de telefoonversie tonen: op een
    // computer staat daar het meeste op.
    const { result } = renderHook(() => useKleinScherm())
    expect(result.current).toBe(false)
  })

  it('herkent een klein scherm', () => {
    herstel = stelSchermIn(true)
    const { result } = renderHook(() => useKleinScherm())
    expect(result.current).toBe(true)
  })

  it('vraagt naar dezelfde grens als de lg-klassen in de opmaak', () => {
    // Zouden die twee uit elkaar lopen, dan bestaat er een breedte waar de
    // zijbalk al vaststaat terwijl de inhoud nog de telefoonversie toont.
    herstel = stelSchermIn(false)
    renderHook(() => useKleinScherm())
    expect(vi.mocked(window.matchMedia)).toHaveBeenCalledWith(KLEIN_SCHERM_QUERY)
    expect(KLEIN_SCHERM_QUERY).toBe('(max-width: 1023.98px)')
  })
})
