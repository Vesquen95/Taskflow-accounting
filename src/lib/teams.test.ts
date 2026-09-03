import { describe, expect, it } from 'vitest'
import { collegasVoorDossier, teamCode, teamLabel, teamsVan } from './teams'
import type { Team } from '../types'

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 't-aal',
    firm_id: 'f1',
    code: 'AAL',
    naam: 'Aalst',
    vestiging: 'Aalst',
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const teams = [
  team(),
  team({ id: 't-zav1', code: 'ZAV1', naam: 'Zaventem 1', vestiging: 'Zaventem' }),
  team({ id: 't-ant', code: 'ANT', naam: 'Antwerpen', vestiging: 'Antwerpen' }),
]

describe('teams — labels', () => {
  it('toont de code en de naam samen waar plaats is', () => {
    expect(teamLabel(teams[1])).toBe('ZAV1 — Zaventem 1')
  })

  it('geeft in een tabelcel alleen de code', () => {
    expect(teamCode(teams, 't-zav1')).toBe('ZAV1')
  })

  it('geeft niets terug voor een dossier zonder team', () => {
    // Niet "onbekend" of een streepje: het scherm beslist zelf hoe het een
    // dossier zonder team toont, en dat is meer dan een lege cel.
    expect(teamCode(teams, null)).toBeNull()
    expect(teamCode(teams, 'bestaat-niet')).toBeNull()
  })
})

describe('teams — lidmaatschap', () => {
  const leden = [
    { employee_id: 'e1', team_id: 't-aal' },
    { employee_id: 'e1', team_id: 't-ant' },
    { employee_id: 'e2', team_id: 't-zav1' },
  ]

  it('geeft alle teams van een medewerker terug', () => {
    expect(teamsVan(leden, 'e1')).toEqual(['t-aal', 't-ant'])
  })

  it('geeft een lege lijst voor wie nergens in zit', () => {
    expect(teamsVan(leden, 'e3')).toEqual([])
    expect(teamsVan(leden, null)).toEqual([])
  })
})

describe('teams — de collegakeuze op een dossier', () => {
  const medewerkers = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]
  const leden = [
    { employee_id: 'e1', team_id: 't-aal' },
    { employee_id: 'e3', team_id: 't-aal' },
    { employee_id: 'e2', team_id: 't-zav1' },
  ]

  it('houdt de collega\'s van het team van het dossier over', () => {
    expect(collegasVoorDossier(medewerkers, leden, 't-aal').map((m) => m.id)).toEqual(['e1', 'e3'])
  })

  it('geeft iedereen bij een dossier zonder team', () => {
    // Er valt niets op te schuinen, en een lege lijst zou een dood scherm zijn.
    expect(collegasVoorDossier(medewerkers, leden, null)).toHaveLength(3)
  })

  it('laat wie de taak nu heeft in de lijst staan, ook buiten het team', () => {
    // Anders verdwijnt de huidige waarde uit haar eigen keuzelijst en lijkt
    // het besturingselement kapot.
    expect(collegasVoorDossier(medewerkers, leden, 't-aal', 'e2').map((m) => m.id)).toEqual([
      'e1',
      'e2',
      'e3',
    ])
  })

  it('valt terug op iedereen wanneer er niemand in het team zit', () => {
    // Filteren zou hier betekenen dat je niemand meer kunt kiezen.
    expect(collegasVoorDossier(medewerkers, leden, 't-ant')).toHaveLength(3)
  })
})
