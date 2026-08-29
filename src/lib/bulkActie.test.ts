import { describe, expect, it, vi } from 'vitest'
import { NIET_BIJGEWERKT_REDEN, voerBulkUit } from './bulkActie'

describe('voerBulkUit — snelle weg eerst, per taak wanneer die faalt', () => {
  it('doet één opdracht wanneer de databank alles aanvaardt', async () => {
    const samen = vi.fn(async (ids: string[]) => ids)
    const perTaak = vi.fn(async () => true)

    const resultaat = await voerBulkUit(['t1', 't2', 't3'], samen, perTaak)

    expect(samen).toHaveBeenCalledTimes(1)
    expect(perTaak).not.toHaveBeenCalled()
    expect(resultaat).toEqual({ gelukt: ['t1', 't2', 't3'], mislukt: [] })
  })

  it('zoekt per taak uit wat er misging zodra de ene opdracht wordt geweigerd', async () => {
    const samen = vi.fn(async () => {
      throw new Error('Ongeldige statusovergang: wacht_op_klant -> wacht_op_klant')
    })
    const perTaak = vi.fn(async (id: string) => {
      if (id === 't2') throw new Error('Ongeldige statusovergang: wacht_op_klant -> wacht_op_klant')
      return true
    })

    const resultaat = await voerBulkUit(['t1', 't2', 't3'], samen, perTaak)

    expect(perTaak).toHaveBeenCalledTimes(3)
    expect(resultaat.gelukt).toEqual(['t1', 't3'])
    expect(resultaat.mislukt).toHaveLength(1)
    expect(resultaat.mislukt[0].taskId).toBe('t2')
    expect(resultaat.mislukt[0].reden).toContain('Ongeldige statusovergang')
  })

  it('meldt een taak die de databank stil overslaat (niet zichtbaar / geen schrijfrecht) als mislukt', async () => {
    const resultaat = await voerBulkUit(
      ['t1', 't2'],
      async () => ['t1'],
      async () => true
    )

    expect(resultaat.gelukt).toEqual(['t1'])
    expect(resultaat.mislukt).toEqual([{ taskId: 't2', reden: NIET_BIJGEWERKT_REDEN }])
  })

  it('meldt ook per taak wanneer de rij daar stil wordt overgeslagen', async () => {
    const resultaat = await voerBulkUit(
      ['t1', 't2'],
      async () => {
        throw new Error('afgebroken')
      },
      async (id: string) => id === 't1'
    )

    expect(resultaat.gelukt).toEqual(['t1'])
    expect(resultaat.mislukt).toEqual([{ taskId: 't2', reden: NIET_BIJGEWERKT_REDEN }])
  })

  it('doet niets bij een lege selectie', async () => {
    const samen = vi.fn(async (ids: string[]) => ids)
    const resultaat = await voerBulkUit([], samen, async () => true)

    expect(samen).not.toHaveBeenCalled()
    expect(resultaat).toEqual({ gelukt: [], mislukt: [] })
  })
})
