import { afterEach, describe, expect, it, vi } from 'vitest'
import { bewaarStem, groet, leesStem, markeerBegroeting, moetBegroeten, spreek, voornaam, wisBegroeting } from './begroeting'

afterEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('begroeting', () => {
  it('groet volgens het uur', () => {
    expect(groet(8)).toBe('Goedemorgen')
    expect(groet(11)).toBe('Goedemorgen')
    expect(groet(12)).toBe('Goedemiddag')
    expect(groet(17)).toBe('Goedemiddag')
    expect(groet(18)).toBe('Goedenavond')
    expect(groet(2)).toBe('Goedenavond')
  })

  it('neemt de voornaam', () => {
    expect(voornaam('  Wibren Patteaux ')).toBe('Wibren')
    expect(voornaam('Sofie')).toBe('Sofie')
  })

  it('begroet één keer per aanmelding', () => {
    expect(moetBegroeten()).toBe(false)
    markeerBegroeting()
    expect(moetBegroeten()).toBe(true)
    wisBegroeting()
    expect(moetBegroeten()).toBe(false)
  })

  it('onthoudt de stem, standaard uit', () => {
    expect(leesStem()).toBe(false)
    bewaarStem(true)
    expect(leesStem()).toBe(true)
    bewaarStem(false)
    expect(leesStem()).toBe(false)
  })

  it('spreekt in het Nederlands, met een Belgische stem als die er is', () => {
    const speak = vi.fn()
    const stemmen = [{ lang: 'en-GB' }, { lang: 'nl-NL' }, { lang: 'nl-BE' }]
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn(), getVoices: () => stemmen })
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = ''
        voice: unknown = null
        rate = 1
        pitch = 1
        constructor(public text: string) {}
      },
    )
    spreek('Goedemiddag, Wibren.')
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'Goedemiddag, Wibren.', lang: 'nl-BE', voice: stemmen[2] }))
  })

  it('zwijgt als de browser niet kan spreken', () => {
    expect(() => spreek('Hallo')).not.toThrow()
  })
})
