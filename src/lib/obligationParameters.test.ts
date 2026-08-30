import { describe, expect, it } from 'vitest'
import {
  avParametersVoorVorm,
  jaarafsluitingBasis,
  jaarafsluitingParametersVoorBasis,
  metParameter,
  metStandaardParameters,
} from './obligationParameters'

describe('metStandaardParameters', () => {
  it('vult aan wat ontbreekt en laat bestaande waarden staan', () => {
    expect(metStandaardParameters('rapportering', {})).toEqual({
      frequentie: 'kwartaal',
      termijn_dagen: 10,
    })
    expect(metStandaardParameters('rapportering', { termijn_dagen: 30 })).toEqual({
      frequentie: 'kwartaal',
      termijn_dagen: 30,
    })
  })

  it('geeft hetzelfde object terug wanneer er niets aan te vullen valt', () => {
    // Het formulier vult aan vanuit een effect. Een nieuw object bij elke
    // ronde zou dat effect eindeloos opnieuw laten lopen.
    const huidig = { frequentie: 'maand', termijn_dagen: 10 }
    expect(metStandaardParameters('rapportering', huidig)).toBe(huidig)
  })

  it('laat een verplichting zonder standaardwaarden ongemoeid', () => {
    const huidig = {}
    expect(metStandaardParameters('algemene_vergadering', huidig)).toBe(huidig)
  })
})

describe('jaarafsluitingBasis', () => {
  it('leest een oude verplichting zonder basis als "boekjaar"', () => {
    // Elk bestaand dossier heeft alleen sla_maanden staan. Die mogen niet
    // stil van deadline veranderen door deze uitbreiding.
    expect(jaarafsluitingBasis({ sla_maanden: 3 })).toBe('boekjaar')
    expect(jaarafsluitingBasis({})).toBe('boekjaar')
  })

  it('herkent de AV-basis', () => {
    expect(jaarafsluitingBasis({ basis: 'voor_av', maanden_voor_av: 1 })).toBe('voor_av')
  })

  it('valt terug op "boekjaar" bij een onbekende waarde', () => {
    expect(jaarafsluitingBasis({ basis: 'iets anders' })).toBe('boekjaar')
  })
})

describe('jaarafsluitingParametersVoorBasis', () => {
  it('zet bij de AV-basis het standaardaantal maanden en wist de doorlooptijd', () => {
    // sla_maanden laten staan zou een waarde bewaren die nergens meer op het
    // scherm staat -- en die de motor wél weer gebruikt zodra iemand
    // terugschakelt.
    expect(jaarafsluitingParametersVoorBasis({ sla_maanden: 3 }, 'voor_av')).toEqual({
      basis: 'voor_av',
      maanden_voor_av: 1,
    })
  })

  it('zet bij de boekjaarbasis de doorlooptijd terug en wist het AV-getal', () => {
    expect(
      jaarafsluitingParametersVoorBasis({ basis: 'voor_av', maanden_voor_av: 2 }, 'boekjaar')
    ).toEqual({ basis: 'boekjaar', sla_maanden: 3 })
  })

  it('houdt een al gekozen aantal maanden vast bij hetzelfde basistype', () => {
    expect(
      jaarafsluitingParametersVoorBasis({ basis: 'voor_av', maanden_voor_av: 3 }, 'voor_av')
    ).toEqual({ basis: 'voor_av', maanden_voor_av: 3 })
  })

  it('laat parameters die niets met de berekening te maken hebben ongemoeid', () => {
    expect(jaarafsluitingParametersVoorBasis({ notitie: 'x', sla_maanden: 4 }, 'voor_av')).toEqual({
      notitie: 'x',
      basis: 'voor_av',
      maanden_voor_av: 1,
    })
  })
})

describe('metStandaardParameters voor de jaarafsluiting', () => {
  it('vult een oude verplichting aan met de boekjaarbasis', () => {
    expect(metStandaardParameters('jaarafsluiting', { sla_maanden: 4 })).toEqual({
      basis: 'boekjaar',
      sla_maanden: 4,
    })
  })

  it('zet bij een AV-verplichting geen doorlooptijd terug', () => {
    // Dit was de valkuil: een generieke aanvulling zou sla_maanden opnieuw
    // toevoegen aan een dossier dat op de AV rekent.
    expect(
      metStandaardParameters('jaarafsluiting', { basis: 'voor_av', maanden_voor_av: 2 })
    ).toEqual({ basis: 'voor_av', maanden_voor_av: 2 })
  })

  it('geeft hetzelfde object terug wanneer alles al ingevuld is', () => {
    const huidig = { basis: 'boekjaar', sla_maanden: 3 }
    expect(metStandaardParameters('jaarafsluiting', huidig)).toBe(huidig)
  })
})

describe('avParametersVoorVorm', () => {
  it('houdt bij een vaste datum alleen maand en dag over', () => {
    expect(
      avParametersVoorVorm({ av_vorm: 'nde_weekdag', av_maand: 6, av_rang: 'eerste', av_weekdag: 'maandag' }, 'vaste_datum')
    ).toEqual({ av_vorm: 'vaste_datum', av_maand: 6 })
  })

  it('wist de statutaire datum helemaal bij een lege vorm', () => {
    expect(avParametersVoorVorm({ av_vorm: 'vaste_datum', av_maand: 6, av_dag: 15 }, '')).toEqual({})
  })
})

describe('metParameter', () => {
  it('verwijdert de sleutel bij een lege waarde in plaats van er iets leegs in te zetten', () => {
    expect(metParameter({ a: 1, b: 2 }, 'b', '')).toEqual({ a: 1 })
    expect(metParameter({ a: 1, b: 2 }, 'b', Number.NaN)).toEqual({ a: 1 })
  })
})
