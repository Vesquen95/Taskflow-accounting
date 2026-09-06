import { describe, expect, it } from 'vitest'
import {
  beoordeelSessie,
  telAf,
  INACTIVITEIT_MINUTEN,
  WAARSCHUWING_MINUTEN,
  SESSIE_UREN,
} from './sessieduur'

const MIN = 60 * 1000
const UUR = 60 * MIN
const NU = new Date('2026-09-06T14:00:00Z').getTime()

describe('beoordeelSessie — inactiviteit', () => {
  it('laat een sessie met verse activiteit met rust', () => {
    const oordeel = beoordeelSessie(NU - UUR, NU - MIN, NU)
    expect(oordeel.stand).toBe('actief')
  })

  it('waarschuwt vlak voor het afmelden', () => {
    const laatste = NU - (INACTIVITEIT_MINUTEN - 1) * MIN
    const oordeel = beoordeelSessie(NU - UUR, laatste, NU)
    expect(oordeel.stand).toBe('waarschuwing')
    expect(oordeel.reden).toBe('inactiviteit')
  })

  it('verloopt precies op de grens', () => {
    const laatste = NU - INACTIVITEIT_MINUTEN * MIN
    expect(beoordeelSessie(NU - UUR, laatste, NU).stand).toBe('verlopen')
  })

  it('waarschuwt niet te vroeg', () => {
    // Eén seconde vóór het waarschuwingsvenster hoort er nog niets te staan;
    // anders staat de melding een groot deel van de dag in beeld.
    const laatste = NU - (INACTIVITEIT_MINUTEN - WAARSCHUWING_MINUTEN) * MIN - 1000
    expect(beoordeelSessie(NU - UUR, laatste, NU).stand).toBe('waarschuwing')
    const netEerder = NU - (INACTIVITEIT_MINUTEN - WAARSCHUWING_MINUTEN) * MIN + 2000
    expect(beoordeelSessie(NU - UUR, netEerder, NU).stand).toBe('actief')
  })
})

describe('beoordeelSessie — de absolute grens', () => {
  it('meldt af na de maximale sessieduur, ook bij volle activiteit', () => {
    // Wie de hele dag doorwerkt raakt de inactiviteitsgrens nooit. Zonder deze
    // tweede grens blijft zo'n sessie eeuwig openstaan.
    const oordeel = beoordeelSessie(NU - SESSIE_UREN * UUR, NU, NU)
    expect(oordeel.stand).toBe('verlopen')
    expect(oordeel.reden).toBe('sessieduur')
  })

  it('noemt de juiste reden als die grens het eerst komt', () => {
    const oordeel = beoordeelSessie(NU - SESSIE_UREN * UUR + MIN, NU, NU)
    expect(oordeel.stand).toBe('waarschuwing')
    expect(oordeel.reden).toBe('sessieduur')
  })

  it('noemt inactiviteit als díé het eerst komt', () => {
    const oordeel = beoordeelSessie(NU - UUR, NU - (INACTIVITEIT_MINUTEN - 1) * MIN, NU)
    expect(oordeel.reden).toBe('inactiviteit')
  })
})

describe('telAf', () => {
  it('toont minuten en seconden', () => {
    expect(telAf(90)).toBe('1:30')
    expect(telAf(9)).toBe('0:09')
  })

  it('gaat niet onder nul', () => {
    expect(telAf(-5)).toBe('0:00')
  })
})
