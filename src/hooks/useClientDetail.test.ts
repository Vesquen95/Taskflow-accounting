import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { useClientDetail } from './useClientDetail'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

function install(handlers: SupabaseHandlers) {
  const mock = createSupabaseMock(handlers)
  ;(supabase.from as Mock).mockImplementation(mock.from)
  return mock
}

const baseHandlers: SupabaseHandlers = {
  clients: () => ({ data: { id: 'c1', naam: 'Acme BV' }, error: null }),
  client_obligations: () => ({ data: [], error: null }),
  task_instances: () => ({ data: [], error: null }),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useClientDetail — loading', () => {
  it('does nothing (no queries, loading=false) when clientId is null', async () => {
    const from = vi.fn()
    ;(supabase.from as Mock).mockImplementation(from)

    const { result } = renderHook(() => useClientDetail(null))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.client).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })

  it('loads client, obligations, and tasks in parallel, scoped to the client id', async () => {
    const obligationCalls: ChainState[] = []
    const taskCalls: ChainState[] = []
    install({
      ...baseHandlers,
      client_obligations: (state) => {
        obligationCalls.push(state)
        return { data: [{ id: 'co1' }], error: null }
      },
      task_instances: (state) => {
        taskCalls.push(state)
        return { data: [{ id: 't1' }], error: null }
      },
    })

    const { result } = renderHook(() => useClientDetail('c1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.client).toEqual({ id: 'c1', naam: 'Acme BV' })
    expect(result.current.obligations).toEqual([{ id: 'co1' }])
    expect(result.current.tasks).toEqual([{ id: 't1' }])
    expect(obligationCalls[0].calls).toContainEqual({ method: 'eq', args: ['client_id', 'c1'] })
    expect(taskCalls[0].calls).toContainEqual({ method: 'eq', args: ['client_id', 'c1'] })
  })

  it('surfaces an error when any of the three parallel queries fails', async () => {
    install({
      ...baseHandlers,
      task_instances: () => ({ data: null, error: new Error('task query failed') }),
    })

    const { result } = renderHook(() => useClientDetail('c1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Kon klantdossier niet laden: task query failed')
  })
})

describe('useClientDetail — effectief-gedateerd obligation change (§2.6)', () => {
  it('closes the old obligation row (actief=false, geldig_tot=today) and opens a new one, rather than overwriting', async () => {
    let closeState: ChainState | undefined
    let openState: ChainState | undefined
    install({
      ...baseHandlers,
      client_obligations: (state) => {
        if (state.op === 'update') closeState = state
        if (state.op === 'insert') openState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClientDetail('c1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const today = new Date().toISOString().slice(0, 10)

    await act(async () => {
      await result.current.updateObligationParameters('co1', 'ot1', { frequentie: 'maand' }, 'e2')
    })

    expect(closeState?.payload).toEqual({ actief: false, geldig_tot: today })
    expect(closeState?.calls).toContainEqual({ method: 'eq', args: ['id', 'co1'] })

    expect(openState?.payload).toMatchObject({
      client_id: 'c1',
      obligation_type_id: 'ot1',
      actief: true,
      geldig_vanaf: today,
      parameters: { frequentie: 'maand' },
      standaard_toegewezen_medewerker_id: 'e2',
    })
  })

  it('does not overwrite the parameters of the old row — only closes it', async () => {
    let closeState: ChainState | undefined
    install({
      ...baseHandlers,
      client_obligations: (state) => {
        if (state.op === 'update') closeState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClientDetail('c1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.updateObligationParameters('co1', 'ot1', { frequentie: 'maand' }, null)
    })

    expect(closeState?.payload).not.toHaveProperty('parameters')
  })
})

describe('useClientDetail — ad-hoc task creation (§2.7)', () => {
  it('creates an ad-hoc task with bron_type=handmatig_adhoc, vereist_goedkeuring=false, and due_date_wettelijk mirroring due_date', async () => {
    let insertState: ChainState | undefined
    install({
      ...baseHandlers,
      task_instances: (state) => {
        if (state.op === 'insert') insertState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClientDetail('c1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.createAdhocTask({
        title: 'Bel klant over dossier X',
        description: null,
        due_date: '2026-09-01',
        toegewezen_medewerker_id: 'e1',
      })
    })

    expect(insertState?.payload).toMatchObject({
      client_id: 'c1',
      obligation_type_id: null,
      client_obligation_id: null,
      title: 'Bel klant over dossier X',
      due_date: '2026-09-01',
      due_date_wettelijk: '2026-09-01',
      status: 'open',
      bron_type: 'handmatig_adhoc',
      vereist_goedkeuring: false,
    })
  })
})

describe('useClientDetail — deactivateObligation', () => {
  it('closes the obligation row (does not delete it)', async () => {
    let updateState: ChainState | undefined
    install({
      ...baseHandlers,
      client_obligations: (state) => {
        if (state.op === 'update') updateState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useClientDetail('c1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.deactivateObligation('co1')
    })

    expect(updateState?.op).toBe('update')
    expect(updateState?.payload).toMatchObject({ actief: false })
    expect(updateState?.calls).toContainEqual({ method: 'eq', args: ['id', 'co1'] })
  })
})
