import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from './supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { legeSelecties, loadClientObligations, saveClientObligations } from './clientObligations'
import type { ObligationType } from '../types'

vi.mock('./supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

const types: ObligationType[] = [
  { id: 'ot-av', code: 'algemene_vergadering', naam: 'Algemene vergadering', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: 'jaarlijks' },
  { id: 'ot-rap', code: 'rapportering', naam: 'Rapportering', categorie: 'service', deadline_mechanisme: 'formule', standaard_periodiciteit: 'kwartaal' },
  { id: 'ot-btw', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: 'maand_of_kwartaal' },
]
const codePerTypeId = Object.fromEntries(types.map((t) => [t.id, t.code]))

function install(handlers: SupabaseHandlers) {
  const mock = createSupabaseMock(handlers)
  ;(supabase.from as Mock).mockImplementation(mock.from)
  return mock
}

const vandaag = new Date().toISOString().slice(0, 10)

beforeEach(() => {
  vi.clearAllMocks()
  ;(supabase.rpc as Mock).mockResolvedValue({ data: 0, error: null })
})

describe('saveClientObligations', () => {
  it('voegt een aangevinkte verplichting toe die er nog niet was', async () => {
    const calls: ChainState[] = []
    install({
      client_obligations: (state) => {
        calls.push(state)
        return { data: [], error: null }
      },
    })

    const selecties = legeSelecties(types).map((s) =>
      s.obligation_type_id === 'ot-rap'
        ? { ...s, gekozen: true, parameters: { frequentie: 'kwartaal', termijn_dagen: 10 } }
        : s
    )
    await saveClientObligations('c1', selecties, codePerTypeId)

    const insert = calls.find((c) => c.calls.some((x) => x.method === 'insert'))
    expect(insert).toBeDefined()
    const payload = insert!.calls.find((x) => x.method === 'insert')!.args[0] as Record<string, unknown>
    expect(payload.obligation_type_id).toBe('ot-rap')
    expect(payload.actief).toBe(true)
    expect(payload.geldig_vanaf).toBe(vandaag)
    expect(payload.parameters).toEqual({ frequentie: 'kwartaal', termijn_dagen: 10 })
  })

  it('sluit een afgevinkte verplichting af in plaats van ze te verwijderen', async () => {
    const calls: ChainState[] = []
    install({
      client_obligations: (state) => {
        calls.push(state)
        return {
          data: [
            {
              id: 'co-1',
              obligation_type_id: 'ot-rap',
              actief: true,
              geldig_tot: null,
              parameters: {},
              standaard_toegewezen_medewerker_id: null,
            },
          ],
          error: null,
        }
      },
    })

    // Niets aangevinkt: de bestaande rapportering moet afgesloten worden.
    await saveClientObligations('c1', legeSelecties(types), codePerTypeId)

    const update = calls.find((c) => c.calls.some((x) => x.method === 'update'))
    expect(update).toBeDefined()
    const payload = update!.calls.find((x) => x.method === 'update')!.args[0] as Record<string, unknown>
    expect(payload).toEqual({ actief: false, geldig_tot: vandaag })
    // Geen delete: de historiek van het dossier blijft staan.
    expect(calls.some((c) => c.calls.some((x) => x.method === 'delete'))).toBe(false)
  })

  it('laat de btw-verplichtingen met rust — die volgen uit het btw-regime', async () => {
    const calls: ChainState[] = []
    install({
      client_obligations: (state) => {
        calls.push(state)
        return { data: [], error: null }
      },
    })

    const selecties = legeSelecties(types).map((s) =>
      s.obligation_type_id === 'ot-btw' ? { ...s, gekozen: true } : s
    )
    await saveClientObligations('c1', selecties, codePerTypeId)

    expect(calls.some((c) => c.calls.some((x) => x.method === 'insert'))).toBe(false)
  })

  it('laat een ongewijzigde verplichting ongemoeid', async () => {
    const calls: ChainState[] = []
    install({
      client_obligations: (state) => {
        calls.push(state)
        return {
          data: [
            {
              id: 'co-1',
              obligation_type_id: 'ot-rap',
              actief: true,
              geldig_tot: null,
              parameters: { frequentie: 'kwartaal' },
              standaard_toegewezen_medewerker_id: 'e1',
            },
          ],
          error: null,
        }
      },
    })

    const selecties = legeSelecties(types).map((s) =>
      s.obligation_type_id === 'ot-rap'
        ? { ...s, gekozen: true, standaard_toegewezen_medewerker_id: 'e1', parameters: { frequentie: 'kwartaal' } }
        : s
    )
    await saveClientObligations('c1', selecties, codePerTypeId)

    expect(calls.some((c) => c.calls.some((x) => x.method === 'update' || x.method === 'insert'))).toBe(false)
  })

  it('laat de database daarna de taken bijwerken', async () => {
    install({ client_obligations: () => ({ data: [], error: null }) })
    ;(supabase.rpc as Mock).mockResolvedValue({ data: 7, error: null })

    const aantal = await saveClientObligations('c1', legeSelecties(types), codePerTypeId)

    expect(supabase.rpc).toHaveBeenCalledWith('sync_client_tasks', { p_client_id: 'c1' })
    expect(aantal).toBe(7)
  })

  it('geeft de fout door wanneer het bijwerken van de taken mislukt', async () => {
    install({ client_obligations: () => ({ data: [], error: null }) })
    ;(supabase.rpc as Mock).mockResolvedValue({ data: null, error: new Error('sync mislukt') })

    await expect(saveClientObligations('c1', legeSelecties(types), codePerTypeId)).rejects.toThrow('sync mislukt')
  })
})

describe('loadClientObligations', () => {
  it('geeft enkel de lopende verplichtingen terug', async () => {
    install({
      client_obligations: () => ({
        data: [
          { id: 'co-1', obligation_type_id: 'ot-rap', actief: true, geldig_tot: null, parameters: { frequentie: 'jaar' }, standaard_toegewezen_medewerker_id: 'e1' },
          { id: 'co-2', obligation_type_id: 'ot-av', actief: false, geldig_tot: '2020-01-01', parameters: {}, standaard_toegewezen_medewerker_id: null },
        ],
        error: null,
      }),
    })

    const selecties = await loadClientObligations('c1')

    expect(selecties).toHaveLength(1)
    expect(selecties[0]).toEqual({
      obligation_type_id: 'ot-rap',
      gekozen: true,
      standaard_toegewezen_medewerker_id: 'e1',
      parameters: { frequentie: 'jaar' },
    })
  })
})
