import { describe, expect, it, vi } from 'vitest'
import type { ImportRij, NieuweKlant } from './klantImport'
import { MAX_OPEENVOLGENDE_FOUTEN, voerKlantImportUit } from './klantImportOpslag'

function rij(excelRij: number, naam: string, geldig = true): ImportRij {
  const klant: NieuweKlant = {
    naam,
    ondernemingsnummer: null,
    team_code: null,
    rechtsvorm: null,
    boekjaar_einde_maand: 12,
    boekjaar_einde_dag: 31,
    btw_regime: 'geen',
    btw_aangifte_frequentie: null,
    mandataris: false,
  }
  return { excelRij, ruw: {} as ImportRij['ruw'], klant: geldig ? klant : null, fouten: geldig ? [] : ['stuk'], waarschuwingen: [], verplichtingen: [] }
}

describe('voerKlantImportUit', () => {
  it('slaat enkel de geldige rijen op', async () => {
    const maak = vi.fn().mockResolvedValue('id')
    const verslag = await voerKlantImportUit([rij(2, 'Acme BV'), rij(3, 'Kapot', false)], maak)

    expect(maak).toHaveBeenCalledTimes(1)
    expect(verslag.gelukt).toHaveLength(1)
    expect(verslag.gelukt[0]).toMatchObject({ excelRij: 2, naam: 'Acme BV' })
    expect(verslag.mislukt).toHaveLength(0)
  })

  it('meldt per rij wat er misging en gaat door met de rest', async () => {
    const maak = vi.fn(async (klant: NieuweKlant) => {
      if (klant.naam === 'Beta NV') throw { code: '23505', message: 'duplicate key value violates unique constraint "clients_firm_id_ondernemingsnummer_key"' }
      return 'id'
    })

    const verslag = await voerKlantImportUit([rij(2, 'Acme BV'), rij(3, 'Beta NV'), rij(4, 'Gamma BV')], maak)

    expect(verslag.gelukt.map((r) => r.excelRij)).toEqual([2, 4])
    expect(verslag.mislukt).toHaveLength(1)
    expect(verslag.mislukt[0].excelRij).toBe(3)
    expect(verslag.mislukt[0].reden).toMatch(/ondernemingsnummer/i)
    expect(verslag.afgebroken).toBe(false)
  })

  it('breekt af wanneer het te vaak na elkaar misgaat, in plaats van honderd keer te falen', async () => {
    const maak = vi.fn().mockRejectedValue(new Error('Geen verbinding'))
    const rijen = Array.from({ length: 50 }, (_, i) => rij(i + 2, `Klant ${i}`))

    const verslag = await voerKlantImportUit(rijen, maak)

    expect(maak).toHaveBeenCalledTimes(MAX_OPEENVOLGENDE_FOUTEN)
    expect(verslag.afgebroken).toBe(true)
    expect(verslag.mislukt).toHaveLength(MAX_OPEENVOLGENDE_FOUTEN)
    expect(verslag.nietGeprobeerd).toHaveLength(50 - MAX_OPEENVOLGENDE_FOUTEN)
    expect(verslag.nietGeprobeerd[0].excelRij).toBe(MAX_OPEENVOLGENDE_FOUTEN + 2)
  })

  it('houdt de klanten in de volgorde van het bestand', async () => {
    const volgorde: string[] = []
    const maak = vi.fn(async (klant: NieuweKlant) => {
      volgorde.push(klant.naam)
      return 'id'
    })
    await voerKlantImportUit([rij(2, 'A'), rij(3, 'B'), rij(4, 'C')], maak)
    expect(volgorde).toEqual(['A', 'B', 'C'])
  })

  it('zet na elke aangemaakte klant zijn verplichtingen en taken', async () => {
    const maak = vi.fn(async () => 'client-id')
    const genereer = vi.fn().mockResolvedValue(undefined)

    const verslag = await voerKlantImportUit([rij(2, 'Acme BV'), rij(3, 'Beta NV')], maak, genereer)

    expect(genereer.mock.calls).toEqual([['client-id', []], ['client-id', []]])
    expect(verslag.gelukt.every((u) => u.waarschuwing === null)).toBe(true)
  })

  // De klant staat er dan wél. Hem als "mislukt" melden zou het kantoor
  // aanzetten tot een tweede import, en die botst op het ondernemingsnummer.
  it('meldt een klant als aangemaakt mét waarschuwing wanneer zijn taken niet gegenereerd raken', async () => {
    const maak = vi.fn(async () => 'client-id')
    const genereer = vi.fn().mockRejectedValue({ code: '42501', message: 'geen toegang' })

    const verslag = await voerKlantImportUit([rij(2, 'Acme BV')], maak, genereer)

    expect(verslag.mislukt).toHaveLength(0)
    expect(verslag.gelukt).toHaveLength(1)
    expect(verslag.gelukt[0].waarschuwing).toMatch(/taken/i)
    expect(verslag.afgebroken).toBe(false)
  })

  it('doet niets bij een lege lijst', async () => {
    const maak = vi.fn()
    const verslag = await voerKlantImportUit([], maak)
    expect(maak).not.toHaveBeenCalled()
    expect(verslag).toEqual({ gelukt: [], mislukt: [], nietGeprobeerd: [], afgebroken: false })
  })
})
