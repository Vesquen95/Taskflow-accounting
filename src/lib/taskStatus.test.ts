import { describe, expect, it, vi } from 'vitest'
import {
  annulatieActie,
  beschikbareStatusActies,
  bulkStatusUitleg,
  gemeenschappelijkeBulkStatussen,
  overgangToegestaan,
  statusContext,
  StatusActieOnderbroken,
  statusActieFoutmelding,
  voerStatusActieUit,
  voortgangsActies,
  volgendeStatusActie,
  wachtOpGoedkeurder,
  type StatusContext,
} from './taskStatus'
import type { Employee, TaskInstance, TaskStatus } from '../types'

/**
 * Deze suite is de tegenhanger van enforce_task_instance_transition
 * (migratie 0011). Wijzigt die trigger, dan wijzigt deze tabel mee — en
 * nergens anders in de app.
 */

function ctx(overrides: Partial<StatusContext> = {}): StatusContext {
  return { status: 'open', vereistGoedkeuring: true, magGoedkeuren: false, ...overrides }
}

function doelen(c: StatusContext): TaskStatus[] {
  return beschikbareStatusActies(c).map((a) => a.doel)
}

describe('overgangToegestaan — spiegel van de databasewhitelist', () => {
  it('laat de vooruitgangen toe die de trigger opsomt', () => {
    const c = ctx({ vereistGoedkeuring: false })
    expect(overgangToegestaan('open', 'in_uitvoering', c)).toBe(true)
    expect(overgangToegestaan('open', 'wacht_op_klant', c)).toBe(true)
    expect(overgangToegestaan('in_uitvoering', 'wacht_op_klant', c)).toBe(true)
    expect(overgangToegestaan('wacht_op_klant', 'in_uitvoering', c)).toBe(true)
  })

  it('weigert terug naar open en elke wijziging op een afgesloten taak', () => {
    const c = ctx({ vereistGoedkeuring: false })
    expect(overgangToegestaan('in_uitvoering', 'open', c)).toBe(false)
    expect(overgangToegestaan('ingediend_afgerond', 'in_uitvoering', c)).toBe(false)
    expect(overgangToegestaan('geannuleerd', 'in_uitvoering', c)).toBe(false)
  })

  it('weigert wacht_op_goedkeuring op een taak die geen goedkeuring vereist', () => {
    expect(overgangToegestaan('open', 'wacht_op_goedkeuring', ctx({ vereistGoedkeuring: false }))).toBe(false)
    expect(overgangToegestaan('open', 'wacht_op_goedkeuring', ctx({ vereistGoedkeuring: true }))).toBe(true)
  })

  it('weigert rechtstreeks afronden zodra de taak goedkeuring vereist (kern van F-3)', () => {
    for (const van of ['open', 'in_uitvoering', 'wacht_op_klant'] as const) {
      expect(overgangToegestaan(van, 'ingediend_afgerond', ctx({ vereistGoedkeuring: true, magGoedkeuren: true }))).toBe(false)
      expect(overgangToegestaan(van, 'ingediend_afgerond', ctx({ vereistGoedkeuring: false }))).toBe(true)
    }
  })

  it('laat enkel wie mag goedkeuren uit wacht_op_goedkeuring komen', () => {
    const zonder = ctx({ status: 'wacht_op_goedkeuring', magGoedkeuren: false })
    const met = ctx({ status: 'wacht_op_goedkeuring', magGoedkeuren: true })
    expect(overgangToegestaan('wacht_op_goedkeuring', 'ingediend_afgerond', zonder)).toBe(false)
    expect(overgangToegestaan('wacht_op_goedkeuring', 'in_uitvoering', zonder)).toBe(false)
    expect(overgangToegestaan('wacht_op_goedkeuring', 'ingediend_afgerond', met)).toBe(true)
    expect(overgangToegestaan('wacht_op_goedkeuring', 'in_uitvoering', met)).toBe(true)
  })

  it('laat annuleren toe vanuit elke niet-eindstatus, ook zonder goedkeuringsrecht', () => {
    for (const van of ['open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring'] as const) {
      expect(overgangToegestaan(van, 'geannuleerd', ctx({ magGoedkeuren: false }))).toBe(true)
    }
  })
})

describe('beschikbareStatusActies — het scherm belooft niets wat de databank weigert', () => {
  it('biedt op een goedkeuringsplichtige taak geen enkele weg naar afgerond zonder goedkeuringsrecht', () => {
    for (const status of ['open', 'in_uitvoering', 'wacht_op_klant'] as const) {
      const acties = beschikbareStatusActies(ctx({ status, vereistGoedkeuring: true, magGoedkeuren: false }))
      expect(acties.some((a) => a.stappen.includes('ingediend_afgerond'))).toBe(false)
      expect(acties.map((a) => a.doel)).toContain('wacht_op_goedkeuring')
    }
  })

  it('biedt rechtstreekse afronding op een taak zonder goedkeuringsvereiste', () => {
    const acties = beschikbareStatusActies(ctx({ status: 'in_uitvoering', vereistGoedkeuring: false }))
    const afronden = acties.find((a) => a.doel === 'ingediend_afgerond')
    expect(afronden?.stappen).toEqual(['ingediend_afgerond'])
    expect(afronden?.label).toBe('Afronden')
  })

  it('bundelt indienen en goedkeuren tot één actie voor wie mag goedkeuren', () => {
    const acties = beschikbareStatusActies(ctx({ status: 'open', vereistGoedkeuring: true, magGoedkeuren: true }))
    const afronden = acties.find((a) => a.doel === 'ingediend_afgerond')
    expect(afronden?.stappen).toEqual(['wacht_op_goedkeuring', 'ingediend_afgerond'])
    // De losse route (vier ogen) blijft daarnaast bestaan.
    expect(acties.map((a) => a.doel)).toContain('wacht_op_goedkeuring')
  })

  it('geeft een medewerker zonder goedkeuringsrecht geen enkele vervolgstap op wacht_op_goedkeuring', () => {
    const c = ctx({ status: 'wacht_op_goedkeuring', magGoedkeuren: false })
    expect(voortgangsActies(c)).toEqual([])
    expect(wachtOpGoedkeurder(c)).toBe(true)
    // Annuleren blijft mogelijk, maar dat is geen vervolgstap.
    expect(annulatieActie(c)?.doel).toBe('geannuleerd')
  })

  it('geeft de goedkeurder wél goedkeuren en terugsturen, met sprekende labels', () => {
    const acties = beschikbareStatusActies(ctx({ status: 'wacht_op_goedkeuring', magGoedkeuren: true }))
    expect(acties.map((a) => a.label)).toEqual(['Terugsturen (afkeuren)', 'Goedkeuren', 'Geannuleerd'])
    expect(wachtOpGoedkeurder(ctx({ status: 'wacht_op_goedkeuring', magGoedkeuren: true }))).toBe(false)
  })

  it('geeft niets terug op een afgesloten taak', () => {
    expect(doelen(ctx({ status: 'ingediend_afgerond', magGoedkeuren: true }))).toEqual([])
    expect(doelen(ctx({ status: 'geannuleerd', magGoedkeuren: true }))).toEqual([])
  })
})

describe('volgendeStatusActie — de keten achter de doorklikbare status', () => {
  it('volgt open → in uitvoering → afgerond voor een taak zonder goedkeuring', () => {
    const geen = { vereistGoedkeuring: false, magGoedkeuren: false }
    expect(volgendeStatusActie(ctx({ status: 'open', ...geen }))?.doel).toBe('in_uitvoering')
    expect(volgendeStatusActie(ctx({ status: 'in_uitvoering', ...geen }))?.doel).toBe('ingediend_afgerond')
  })

  it('loopt voor een wettelijke taak via wacht op goedkeuring', () => {
    const wettelijk = { vereistGoedkeuring: true, magGoedkeuren: false }
    expect(volgendeStatusActie(ctx({ status: 'open', ...wettelijk }))?.doel).toBe('in_uitvoering')
    expect(volgendeStatusActie(ctx({ status: 'in_uitvoering', ...wettelijk }))?.doel).toBe('wacht_op_goedkeuring')
    expect(volgendeStatusActie(ctx({ status: 'wacht_op_goedkeuring', ...wettelijk }))).toBeNull()
    expect(volgendeStatusActie(ctx({ status: 'wacht_op_goedkeuring', vereistGoedkeuring: true, magGoedkeuren: true }))?.doel).toBe(
      'ingediend_afgerond'
    )
  })

  it('brengt een taak die op de klant wacht terug in uitvoering', () => {
    expect(volgendeStatusActie(ctx({ status: 'wacht_op_klant' }))?.doel).toBe('in_uitvoering')
  })

  it('zet altijd hoogstens één statuswijziging per klik', () => {
    const statussen: TaskStatus[] = ['open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring']
    for (const status of statussen) {
      for (const vereistGoedkeuring of [true, false]) {
        for (const magGoedkeuren of [true, false]) {
          const actie = volgendeStatusActie(ctx({ status, vereistGoedkeuring, magGoedkeuren }))
          if (actie) expect(actie.stappen).toHaveLength(1)
        }
      }
    }
  })

  it('geeft niets terug op een afgesloten taak', () => {
    expect(volgendeStatusActie(ctx({ status: 'ingediend_afgerond', magGoedkeuren: true }))).toBeNull()
    expect(volgendeStatusActie(ctx({ status: 'geannuleerd', magGoedkeuren: true }))).toBeNull()
  })

  it('stelt nooit een stap voor die de databank zou weigeren', () => {
    const statussen: TaskStatus[] = ['open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring']
    for (const status of statussen) {
      for (const vereistGoedkeuring of [true, false]) {
        for (const magGoedkeuren of [true, false]) {
          const c = ctx({ status, vereistGoedkeuring, magGoedkeuren })
          for (const actie of beschikbareStatusActies(c)) {
            let van = status
            for (const stap of actie.stappen) {
              expect(overgangToegestaan(van, stap, c)).toBe(true)
              van = stap
            }
          }
        }
      }
    }
  })
})

describe('statusContext — de drie ingrediënten', () => {
  const taak = { status: 'open', vereist_goedkeuring: true } as Pick<TaskInstance, 'status' | 'vereist_goedkeuring'>

  it('leest status en goedkeuringsvereiste van de taak en het recht van de medewerker', () => {
    const c = statusContext(taak, { mag_goedkeuren: true } as Employee)
    expect(c).toEqual({ status: 'open', vereistGoedkeuring: true, magGoedkeuren: true })
  })

  it('gaat uit van géén goedkeuringsrecht wanneer de medewerker (nog) niet geladen is', () => {
    expect(statusContext(taak, null).magGoedkeuren).toBe(false)
    expect(statusContext(taak, undefined).magGoedkeuren).toBe(false)
  })
})

describe('voerStatusActieUit — de tussentoestand is zichtbaar, niet verzwegen', () => {
  const afronden = {
    doel: 'ingediend_afgerond',
    label: 'Afronden',
    stappen: ['wacht_op_goedkeuring', 'ingediend_afgerond'],
    soort: 'voortgang',
  } as const

  it('zet de stappen in volgorde', async () => {
    const zetStatus = vi.fn().mockResolvedValue(undefined)
    await voerStatusActieUit('t1', afronden, zetStatus)
    expect(zetStatus.mock.calls).toEqual([
      ['t1', 'wacht_op_goedkeuring'],
      ['t1', 'ingediend_afgerond'],
    ])
  })

  it('geeft een fout in de eerste stap onveranderd door — er is niets gebeurd', async () => {
    const oorzaak = new Error('Ongeldige statusovergang')
    const zetStatus = vi.fn().mockRejectedValue(oorzaak)
    await expect(voerStatusActieUit('t1', afronden, zetStatus)).rejects.toBe(oorzaak)
  })

  it('meldt bij een latere stap wélke tussentoestand bereikt is', async () => {
    const oorzaak = new Error('Alleen medewerkers met goedkeuringsrecht')
    const zetStatus = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(oorzaak)

    const fout = await voerStatusActieUit('t1', afronden, zetStatus).catch((e: unknown) => e)

    expect(fout).toBeInstanceOf(StatusActieOnderbroken)
    expect((fout as StatusActieOnderbroken).bereikt).toBe('wacht_op_goedkeuring')
    expect((fout as StatusActieOnderbroken).mislukt).toBe('ingediend_afgerond')
    expect((fout as StatusActieOnderbroken).oorzaak).toBe(oorzaak)
  })
})

describe('statusActieFoutmelding', () => {
  it('vertelt bij een onderbroken actie waar de taak nu staat', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const melding = statusActieFoutmelding(
      new StatusActieOnderbroken('wacht_op_goedkeuring', 'ingediend_afgerond', new Error('Geen goedkeuringsrecht'))
    )
    expect(melding).toContain('staat nu op "Wacht op goedkeuring"')
    expect(melding).toContain('blijft op "Wacht op goedkeuring" staan')
    expect(melding).toContain('Geen goedkeuringsrecht')
  })

  it('valt terug op de gewone foutvertaling voor een gewone fout', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(statusActieFoutmelding(new Error('Netwerk weg'))).toContain('Statuswijziging is mislukt')
  })
})

/**
 * Bulk: de statusbalk mag alleen aanbieden wat op *elke* geselecteerde taak
 * kan. Eén doorsnede over de selectie, met dezelfde regels als één taak —
 * anders belooft de balk iets wat de trigger op de eerste dwarsligger
 * afbreekt, en dan gebeurt er (één statement!) helemaal niets.
 */
describe('gemeenschappelijkeBulkStatussen — de doorsnede over een selectie', () => {
  it('biedt op één open taak de gewone bulkkeuzes aan', () => {
    expect(gemeenschappelijkeBulkStatussen([ctx({ status: 'open' })])).toEqual([
      'in_uitvoering',
      'wacht_op_klant',
      'geannuleerd',
    ])
  })

  it('laat "Wacht op klant" vallen zodra één taak daar al op staat (geen overgang naar zichzelf)', () => {
    const statussen = gemeenschappelijkeBulkStatussen([ctx({ status: 'open' }), ctx({ status: 'wacht_op_klant' })])
    expect(statussen).not.toContain('wacht_op_klant')
    expect(statussen).toEqual(['in_uitvoering', 'geannuleerd'])
  })

  it('laat "Wacht op klant" vallen bij een taak in wacht_op_goedkeuring (niet in de whitelist van de trigger)', () => {
    const statussen = gemeenschappelijkeBulkStatussen([
      ctx({ status: 'in_uitvoering' }),
      ctx({ status: 'wacht_op_goedkeuring', magGoedkeuren: true }),
    ])
    expect(statussen).not.toContain('wacht_op_klant')
  })

  it('biedt zonder goedkeuringsrecht geen "In uitvoering" aan op een selectie met wacht_op_goedkeuring', () => {
    const statussen = gemeenschappelijkeBulkStatussen([
      ctx({ status: 'open' }),
      ctx({ status: 'wacht_op_goedkeuring', magGoedkeuren: false }),
    ])
    expect(statussen).toEqual(['geannuleerd'])
  })

  it('geeft dat terugsturen wél terug aan wie goedkeuringsrecht heeft', () => {
    const statussen = gemeenschappelijkeBulkStatussen([
      ctx({ status: 'open', magGoedkeuren: true }),
      ctx({ status: 'wacht_op_goedkeuring', magGoedkeuren: true }),
    ])
    expect(statussen).toContain('in_uitvoering')
  })

  it('levert niets op zodra er een afgesloten taak in de selectie zit', () => {
    expect(gemeenschappelijkeBulkStatussen([ctx({ status: 'open' }), ctx({ status: 'ingediend_afgerond' })])).toEqual([])
    expect(gemeenschappelijkeBulkStatussen([ctx({ status: 'geannuleerd' })])).toEqual([])
  })

  it('levert niets op voor een lege selectie', () => {
    expect(gemeenschappelijkeBulkStatussen([])).toEqual([])
  })
})

describe('bulkStatusUitleg — waarom er niets te kiezen valt', () => {
  it('noemt hoeveel taken afgesloten zijn en dus niets meer toelaten', () => {
    const uitleg = bulkStatusUitleg([
      ctx({ status: 'open' }),
      ctx({ status: 'ingediend_afgerond' }),
      ctx({ status: 'geannuleerd' }),
    ])
    expect(uitleg).toContain('2 van de 3')
    expect(uitleg).toMatch(/afgesloten/i)
  })

  it('geeft een leesbare reden terug, ook wanneer geen enkele taak afgesloten is', () => {
    const uitleg = bulkStatusUitleg([ctx({ status: 'open' })])
    expect(uitleg.length).toBeGreaterThan(0)
    expect(uitleg).not.toMatch(/undefined|NaN/)
  })
})
