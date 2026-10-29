import { afterEach, describe, expect, it } from 'vitest'
import {
  begroetingTekst,
  bewaarGeluid,
  groet,
  leesGeluid,
  markeerBegroeting,
  moetBegroeten,
  voornaam,
  wisBegroeting,
} from './begroeting'

afterEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
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

  it('groet bij voornaam', () => {
    expect(voornaam('  Wibren Patteaux ')).toBe('Wibren')
    expect(begroetingTekst(9, 'Wibren Patteaux')).toBe('Good morning, Wibren.')
  })

  it('begroet één keer per aanmelding', () => {
    expect(moetBegroeten()).toBe(false)
    markeerBegroeting()
    expect(moetBegroeten()).toBe(true)
    wisBegroeting()
    expect(moetBegroeten()).toBe(false)
  })

  it('onthoudt het geluid, standaard uit, onder de oude sleutel', () => {
    expect(leesGeluid()).toBe(false)
    bewaarGeluid(true)
    expect(leesGeluid()).toBe(true)
    expect(window.localStorage.getItem('taskflow.weergave.stem')).toBe('aan')
    bewaarGeluid(false)
    expect(leesGeluid()).toBe(false)
  })
})
