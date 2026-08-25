import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { useClients } from './useClients'
import type { Client } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    firm_id: 'f1',
    naam: 'Acme BV',
    ondernemingsnummer: 'BE0123.456.789',
    rechtsvorm: 'BV',
    boekjaar_einde_maand: 12,
    boekjaar_einde_dag: 31,
    btw_regime: 'periodieke_aangever',
    btw_aangifte_frequentie: 'kwartaal',
    mandataris: true,
    vertrouwelijk: false,
    standaard_verantwoordelijke_id: 'e1',
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function install(handlers: SupabaseHandlers) {
  const mock = createSupabaseMock(handlers)
  ;(supabase.from as Mock).mockImplementation(mock.from)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useClients — default/explicit filters', () => {
  it('defaults to actief=true clients only', async () => {
    let capturedState: ChainState | undefined
    install({
      clients: (state) => {
        capturedState = state
        return { data: [client()], error: null }
      },
    })

    const { result } = renderHook(() => useClients())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(capturedState?.calls).toContainEqual({ method: 'eq', args: ['actief', true] })
  })

  it('applies a mandataris=true filter when requested', async () => {
    let capturedState: ChainState | undefined
    install({
      clients: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClients({ mandataris: true, actief: 'alle' }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(capturedState?.calls).toContainEqual({ method: 'eq', args: ['mandataris', true] })
    expect(capturedState?.calls.some((c) => c.method === 'eq' && c.args[0] === 'actief')).toBe(false)
  })

  it('builds an ilike-or filter across naam and ondernemingsnummer for zoekterm', async () => {
    let capturedState: ChainState | undefined
    install({
      clients: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClients({ zoekterm: 'acme', actief: 'alle' }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const orCall = capturedState?.calls.find((c) => c.method === 'or')
    expect(orCall?.args[0]).toBe('naam.ilike.%acme%,ondernemingsnummer.ilike.%acme%')
  })

  // REGRESSION TEST (fixed): a search term containing a comma (or other
  // PostgREST-reserved characters: '(', ')', '%', '*') is escaped with a
  // backslash before being interpolated into the `or=` filter string, so
  // it can no longer split the filter into unrelated conditions or corrupt
  // the ILIKE wildcard matching. See useClients.ts#escapePostgrestFilterValue.
  it('escapes a comma in the search term so it cannot break the or-filter syntax', async () => {
    let capturedState: ChainState | undefined
    install({
      clients: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClients({ zoekterm: 'foo,bar', actief: 'alle' }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const orCall = capturedState?.calls.find((c) => c.method === 'or')
    expect(orCall?.args[0]).toBe('naam.ilike.%foo\\,bar%,ondernemingsnummer.ilike.%foo\\,bar%')
  })

  it('escapes parentheses, percent and asterisk characters in the search term', async () => {
    let capturedState: ChainState | undefined
    install({
      clients: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClients({ zoekterm: 'a(b)c%d*e', actief: 'alle' }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const orCall = capturedState?.calls.find((c) => c.method === 'or')
    expect(orCall?.args[0]).toBe(
      'naam.ilike.%a\\(b\\)c\\%d\\*e%,ondernemingsnummer.ilike.%a\\(b\\)c\\%d\\*e%'
    )
  })
})

describe('useClients — error handling', () => {
  it('surfaces a load error and keeps the client list empty', async () => {
    install({ clients: () => ({ data: null, error: new Error('boom') }) })

    const { result } = renderHook(() => useClients())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Kon klanten niet laden: boom')
    expect(result.current.clients).toEqual([])
  })

  // Regressie: een PostgREST-fout is niet noodzakelijk een `Error`-instantie.
  // Het oude `err instanceof Error ? err.message : '...'`-patroon liet in dat
  // geval enkel "Kon klanten niet laden." achter, zonder SQLSTATE.
  it('keeps message and SQLSTATE of a non-Error PostgREST error object', async () => {
    install({
      clients: () => ({
        data: null,
        error: {
          message: 'permission denied for table clients',
          code: '42501',
          details: null,
          hint: null,
        },
      }),
    })

    const { result } = renderHook(() => useClients())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe(
      'Kon klanten niet laden: Je hebt geen rechten voor deze actie. (permission denied for table clients — code 42501)'
    )
  })
})

describe('useClients — mutations', () => {
  it('createClient inserts and returns the created row', async () => {
    let insertState: ChainState | undefined
    install({
      clients: (state) => {
        if (state.op === 'insert') {
          insertState = state
          return { data: client({ id: 'new-1' }), error: null }
        }
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClients())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let created: Client | undefined
    await act(async () => {
      created = await result.current.createClient({ ...client(), firm_id: 'f1' })
    })

    expect(insertState?.op).toBe('insert')
    expect(created?.id).toBe('new-1')
  })

  it('updateClient updates the row by id and reloads', async () => {
    let updateState: ChainState | undefined
    install({
      clients: (state) => {
        if (state.op === 'update') updateState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClients())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.updateClient('c1', { actief: false })
    })

    expect(updateState?.payload).toEqual({ actief: false })
    expect(updateState?.calls).toContainEqual({ method: 'eq', args: ['id', 'c1'] })
  })
})
