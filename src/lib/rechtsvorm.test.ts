import { describe, expect, it } from 'vitest'
import { heeftUboVerplichting, kanPatrimoniumtaksHebben, rechtsvormSoort } from './rechtsvorm'

describe('rechtsvormSoort', () => {
  it('herkent verenigingen en stichtingen, hoe ze ook geschreven staan', () => {
    for (const vorm of ['VZW', 'vzw', 'V.Z.W.', 'IVZW', 'Stichting', 'private stichting', 'ASBL']) {
      expect(rechtsvormSoort(vorm)).toBe('vereniging')
    }
  })

  it('herkent de gebruikelijke vennootschapsvormen', () => {
    for (const vorm of ['BV', 'NV', 'CommV', 'VOF', 'CV', 'BVBA', 'Eenmanszaak']) {
      expect(rechtsvormSoort(vorm)).toBe('vennootschap')
    }
  })

  it('zegt "onbekend" wanneer het veld leeg is of iets anders bevat', () => {
    // Dat is een echt antwoord en geen verlegenheid: het systeem weet het niet.
    expect(rechtsvormSoort('')).toBe('onbekend')
    expect(rechtsvormSoort(null)).toBe('onbekend')
    expect(rechtsvormSoort('GmbH')).toBe('onbekend')
    expect(rechtsvormSoort('Maatschap')).toBe('onbekend')
  })
})

describe('kanPatrimoniumtaksHebben', () => {
  it('geldt voor verenigingen', () => {
    expect(kanPatrimoniumtaksHebben('VZW')).toBe(true)
    expect(kanPatrimoniumtaksHebben('Private stichting')).toBe(true)
  })

  it('geldt niet voor een vennootschap', () => {
    expect(kanPatrimoniumtaksHebben('BV')).toBe(false)
    expect(kanPatrimoniumtaksHebben('NV')).toBe(false)
  })

  it('blijft toegestaan bij een onbekende of lege rechtsvorm', () => {
    // Een taks verbergen omdat het veld niet ingevuld is, is erger dan er een
    // aanbieden die achteraf niet nodig blijkt.
    expect(kanPatrimoniumtaksHebben('')).toBe(true)
    expect(kanPatrimoniumtaksHebben(null)).toBe(true)
    expect(kanPatrimoniumtaksHebben('GmbH')).toBe(true)
  })
})

describe('UBO-register — wie is informatieplichtig', () => {
  it('geldt voor vennootschappen en verenigingen', () => {
    for (const vorm of ['BV', 'NV', 'CV', 'VZW', 'Stichting', 'IVZW']) {
      expect(heeftUboVerplichting('rechtspersoon', vorm)).toBe(true)
    }
  })

  it('geldt niet voor een eenmanszaak', () => {
    // Er is geen entiteit om achter te kijken: de ondernemer ís de
    // natuurlijke persoon. De vorm staat wél in de vennootschapslijst, want
    // die dient om "geen vereniging" te kunnen zeggen — hier maakt het
    // verschil wel uit.
    expect(heeftUboVerplichting('rechtspersoon', 'eenmanszaak')).toBe(false)
    expect(heeftUboVerplichting('rechtspersoon', 'Eenmanszaak')).toBe(false)
  })

  it('geldt nooit voor een natuurlijke persoon', () => {
    expect(heeftUboVerplichting('natuurlijk_persoon', 'BV')).toBe(false)
    expect(heeftUboVerplichting('natuurlijk_persoon', null)).toBe(false)
  })

  it('geldt bij een onbekende of lege rechtsvorm wel', () => {
    // Zo goed als elke rechtspersoon is informatieplichtig. Een wettelijke
    // verplichting verbergen omdat een veld leeg is, is erger dan er een
    // aanbieden die achteraf niet nodig blijkt.
    expect(heeftUboVerplichting('rechtspersoon', null)).toBe(true)
    expect(heeftUboVerplichting('rechtspersoon', '')).toBe(true)
    expect(heeftUboVerplichting('rechtspersoon', 'Comm.V. buitenlands')).toBe(true)
  })
})
