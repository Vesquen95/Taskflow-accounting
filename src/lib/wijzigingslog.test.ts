import { describe, expect, it } from 'vitest'
import { logWaarde, veldLabel } from './wijzigingslog'

const medewerkers = [
  { id: '8f3c1a2b-0000-4000-8000-000000000001', naam: 'Els Peeters' },
  { id: '8f3c1a2b-0000-4000-8000-000000000002', naam: 'Jan Janssens' },
]

describe('veldLabel', () => {
  it('vertaalt de kolomnamen die het log bewaart', () => {
    expect(veldLabel('standaard_verantwoordelijke_id')).toBe('Standaard verantwoordelijke')
    expect(veldLabel('taken_volgen_verantwoordelijke')).toBe('Openstaande taken mee verplaatst')
  })

  it('laat een onbekend veld staan in plaats van het te verbergen', () => {
    expect(veldLabel('iets_nieuws')).toBe('iets_nieuws')
  })
})

describe('logWaarde', () => {
  it('maakt van een uuid een naam', () => {
    expect(logWaarde('8f3c1a2b-0000-4000-8000-000000000001', medewerkers)).toBe('Els Peeters')
  })

  it('doet dat ook midden in een zin', () => {
    // Zo schrijft migratie 0059 haar regel.
    expect(
      logWaarde('6 openstaande taken stonden op 8f3c1a2b-0000-4000-8000-000000000002', medewerkers)
    ).toBe('6 openstaande taken stonden op Jan Janssens')
  })

  it('laat een uuid staan dat bij niemand hoort', () => {
    // Een verwijderde of onbekende medewerker verzinnen we niet.
    const vreemd = '8f3c1a2b-0000-4000-8000-00000000ffff'
    expect(logWaarde(vreemd, medewerkers)).toBe(vreemd)
  })

  it('raakt gewone waarden niet aan', () => {
    expect(logWaarde('kwartaal', medewerkers)).toBe('kwartaal')
    expect(logWaarde('de bak van het team', medewerkers)).toBe('de bak van het team')
  })

  it('toont een streepje als er niets stond', () => {
    expect(logWaarde(null, medewerkers)).toBe('—')
    expect(logWaarde('', medewerkers)).toBe('—')
  })
})
