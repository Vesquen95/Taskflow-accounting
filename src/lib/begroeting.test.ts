import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  begroetingTekst,
  bewaarAanspreking,
  bewaarStem,
  groet,
  kiesStem,
  leesAanspreking,
  leesStem,
  markeerBegroeting,
  moetBegroeten,
  spreek,
  voornaam,
  wisBegroeting,
} from './begroeting'

afterEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('begroeting', () => {
  it('groet volgens het uur', () => {
    expect(groet(8)).toBe('Good morning')
    expect(groet(11)).toBe('Good morning')
    expect(groet(12)).toBe('Good afternoon')
    expect(groet(17)).toBe('Good afternoon')
    expect(groet(18)).toBe('Good evening')
    expect(groet(2)).toBe('Good evening')
  })

  it('spreekt aan zoals gekozen, standaard bij voornaam', () => {
    expect(leesAanspreking()).toBe('naam')
    expect(begroetingTekst(9, leesAanspreking(), 'Wibren Patteaux')).toBe('Good morning, Wibren.')
    bewaarAanspreking('sir')
    expect(begroetingTekst(9, leesAanspreking(), 'Wibren Patteaux')).toBe('Good morning, sir.')
    bewaarAanspreking('maam')
    expect(begroetingTekst(20, leesAanspreking(), 'Sofie')).toBe("Good evening, ma'am.")
    bewaarAanspreking('naam')
    expect(window.localStorage.getItem('taskflow.weergave.aanspreking')).toBeNull()
  })

  it('kiest een Britse mannenstem, dan een Britse, dan een Engelse', () => {
    const stem = (name: string, lang: string) => ({ name, lang })
    const nl = stem('Xander', 'nl-NL')
    const vrouw = stem('Google UK English Female', 'en-GB')
    const man = stem('Google UK English Male', 'en-GB')
    const ryan = stem('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB')
    const vs = stem('Samantha', 'en-US')
    expect(kiesStem([nl, vrouw, man, ryan])).toBe(ryan)
    expect(kiesStem([nl, vrouw, man])).toBe(man)
    expect(kiesStem([vs, vrouw])).toBe(vrouw)
    expect(kiesStem([nl, stem('Daniel', 'en_GB')])?.name).toBe('Daniel')
    expect(kiesStem([nl, vs])).toBe(vs)
    expect(kiesStem([nl])).toBeUndefined()
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

  it('spreekt in het Engels, met een Britse stem', () => {
    const speak = vi.fn()
    const stemmen = [{ name: 'Xander', lang: 'nl-NL' }, { name: 'Daniel', lang: 'en-GB' }]
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
    spreek('Good afternoon, sir.')
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Good afternoon, sir.', lang: 'en-GB', voice: stemmen[1] }),
    )
  })

  it('wacht tot de browser zijn stemmen geladen heeft', () => {
    vi.useFakeTimers()
    const speak = vi.fn()
    let stemmen: { name: string; lang: string }[] = []
    let geladen = () => {}
    vi.stubGlobal('speechSynthesis', {
      speak,
      cancel: vi.fn(),
      getVoices: () => stemmen,
      addEventListener: (_: string, f: () => void) => (geladen = f),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} })
    spreek('Good morning, sir.')
    expect(speak).not.toHaveBeenCalled()
    stemmen = [{ name: 'Daniel', lang: 'en-GB' }]
    geladen()
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ voice: stemmen[0] }))
    vi.advanceTimersByTime(1000)
    expect(speak).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('zwijgt als de browser niet kan spreken', () => {
    expect(() => spreek('Hallo')).not.toThrow()
  })
})
