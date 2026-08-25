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

  // BUG REGRESSION CANDIDATE: a search term containing a comma is not
  // escaped/sanitised before being interpolated into the PostgREST `or=`
  // filter string. PostgREST splits `or=` on top-level commas, so a term
  // like "foo,bar" corrupts the filter into two unrelated conditions
  // instead of searching for the literal substring "foo,bar". This test
  // documents the current (buggy) behaviour rather than asserting the
  // fix — see the tester's report for the recommended remediation
  // (sanitise/escape commas and '%'/'*' before interpolating, or move to
  // a parameterised `.or()` alternative).
  it('KNOWN BUG: a comma in the search term is passed through unescaped into the or-filter string', async () => {
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
    // This is the literal (unsafe) string sent to PostgREST today. A fix
    // would escape the comma so this assertion should change to reflect
    // an escaped value once addressed.
    expect(orCall?.args[0]).toBe('naam.ilike.%foo,bar%,ondernemingsnummer.ilike.%foo,bar%')
  })
})

describe('useClients — error handling', () => {
  it('surfaces a load error and keeps the client list empty', async () => {
    install({ clients: () => ({ data: null, error: new Error('boom') }) })

    const { result } = renderHook(() => useClients())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('boom')
    expect(result.current.clients).toEqual([])
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
