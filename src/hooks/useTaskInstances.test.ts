import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { useTaskInstances } from './useTaskInstances'
import type { TaskInstanceWithRelations } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

function task(overrides: Partial<TaskInstanceWithRelations> = {}): TaskInstanceWithRelations {
  return {
    id: 't1',
    client_id: 'c1',
    obligation_type_id: 'ot1',
    client_obligation_id: null,
    periode_label: '2026-Q2',
    periode_start: null,
    periode_eind: null,
    due_date: '2026-07-20',
    due_date_wettelijk: '2026-07-20',
    due_date_verschoven: false,
    due_date_handmatig_op: null,
    status: 'open',
    toegewezen_medewerker_id: 'e1',
    voorloper_taak_id: null,
    bron_type: 'automatisch_gegenereerd',
    voorlopige_datum: false,
    vereist_goedkeuring: true,
    goedgekeurd_door: null,
    goedgekeurd_op: null,
    review_vereist: false,
    review_reden: null,
    title: null,
    description: null,
    afgerond_op: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    client: { id: 'c1', naam: 'Client A', vertrouwelijk: false, actief: true },
    obligation_type: { id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' },
    toegewezen_medewerker: { id: 'e1', naam: 'Jan' },
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

describe('useTaskInstances — filter wiring', () => {
  it('defaults to filtering out final statuses (open/in_uitvoering/wacht_op_klant/wacht_op_goedkeuring)', async () => {
    let capturedState: ChainState | undefined
    install({
      task_instances: (state) => {
        capturedState = state
        return { data: [task()], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const inCall = capturedState?.calls.find((c) => c.method === 'in')
    expect(inCall?.args).toEqual(['status', ['open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring']])
  })

  it('includeAlles skips the status filter entirely (Klantdossier history view)', async () => {
    let capturedState: ChainState | undefined
    install({
      task_instances: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances({ includeAlles: true }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(capturedState?.calls.some((c) => c.method === 'in')).toBe(false)
  })

  it('scopes to a single client via eq("client_id", ...) — data-access-layer regression for cross-client isolation', async () => {
    let capturedState: ChainState | undefined
    install({
      task_instances: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances({ clientId: 'client-42' }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(capturedState?.calls).toContainEqual({ method: 'eq', args: ['client_id', 'client-42'] })
  })

  it('beperkt tot de verplichtingstypes van één werkstroom', async () => {
    let capturedState: ChainState | undefined
    install({
      task_instances: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances({ obligationTypeIds: ['ot1', 'ot2'] }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(capturedState?.calls).toContainEqual({ method: 'in', args: ['obligation_type_id', ['ot1', 'ot2']] })
  })

  it('een lege typelijst toont niets in plaats van alles', async () => {
    let capturedState: ChainState | undefined
    install({
      task_instances: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances({ obligationTypeIds: [] }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(capturedState?.calls).toContainEqual({ method: 'in', args: ['obligation_type_id', []] })
  })

  it('adhocOnly vraagt de taken zonder verplichtingstype op, en negeert de typelijst', async () => {
    let capturedState: ChainState | undefined
    install({
      task_instances: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() =>
      useTaskInstances({ adhocOnly: true, obligationTypeIds: ['ot1'] })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(capturedState?.calls).toContainEqual({ method: 'is', args: ['obligation_type_id', null] })
    expect(
      capturedState?.calls.some((c) => c.method === 'in' && c.args[0] === 'obligation_type_id')
    ).toBe(false)
  })

  it('dueTot begrenst het deadlinevenster bovenaan, zonder ondergrens', async () => {
    let capturedState: ChainState | undefined
    install({
      task_instances: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances({ dueTot: '2026-08-30' }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(capturedState?.calls).toContainEqual({ method: 'lte', args: ['due_date', '2026-08-30'] })
    // Geen ondergrens: achterstand blijft zichtbaar, ook in een smal venster.
    expect(capturedState?.calls.some((c) => c.method === 'gte' || c.method === 'gt')).toBe(false)
  })

  it('paused stelt de query uit tot het scherm zijn filters kent', async () => {
    let opgevraagd = 0
    install({
      task_instances: () => {
        opgevraagd++
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances({ paused: true }))

    await new Promise((r) => setTimeout(r, 20))
    expect(opgevraagd).toBe(0)
    // Blijft op laden staan: kort "geen taken" tonen zou liegen.
    expect(result.current.loading).toBe(true)

    act(() => result.current.setFilters((f) => ({ ...f, paused: false })))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(opgevraagd).toBe(1)
  })

  it('overdueOnly filters via lt(due_date, today)', async () => {
    let capturedState: ChainState | undefined
    install({
      task_instances: (state) => {
        capturedState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances({ overdueOnly: true }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const ltCall = capturedState?.calls.find((c) => c.method === 'lt')
    expect(ltCall?.args[0]).toBe('due_date')
    expect(ltCall?.args[1]).toBe(new Date().toISOString().slice(0, 10))
  })

  it('filters client-side by zoekterm across client naam, obligation naam, and ad-hoc title', async () => {
    install({
      task_instances: () => ({
        data: [
          task({ id: 't1', client: { id: 'c1', naam: 'Acme BV', vertrouwelijk: false, actief: true } }),
          task({ id: 't2', client: { id: 'c2', naam: 'Other NV', vertrouwelijk: false, actief: true } }),
          task({ id: 't3', obligation_type_id: null, obligation_type: null, title: 'Contact Acme klant', client: { id: 'c3', naam: 'Third BV', vertrouwelijk: false, actief: true } }),
        ],
        error: null,
      }),
    })

    const { result } = renderHook(() => useTaskInstances({ zoekterm: 'acme' }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.tasks.map((t) => t.id).sort()).toEqual(['t1', 't3'])
  })
})

describe('useTaskInstances — error handling', () => {
  it('surfaces a load error without throwing, and keeps the task list empty', async () => {
    install({
      task_instances: () => ({ data: null, error: new Error('network down') }),
    })

    const { result } = renderHook(() => useTaskInstances())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Kon taken niet laden: network down')
    expect(result.current.tasks).toEqual([])
  })
})

describe('useTaskInstances — mutations', () => {
  it('updateStatus updates the row by id and reloads', async () => {
    let updateState: ChainState | undefined
    install({
      task_instances: (state) => {
        if (state.op === 'update') updateState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.updateStatus('t1', 'in_uitvoering')
    })

    expect(updateState?.payload).toEqual({ status: 'in_uitvoering' })
    expect(updateState?.calls).toContainEqual({ method: 'eq', args: ['id', 't1'] })
  })

  it('updateStatus throws (does not swallow) when the update fails, so the UI can show an error', async () => {
    install({
      task_instances: (state) => {
        if (state.op === 'update') return { data: null, error: new Error('rejected by DB trigger') }
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(result.current.updateStatus('t1', 'ingediend_afgerond')).rejects.toThrow('rejected by DB trigger')
  })

  it('bulkReassign updates via in("id", ids) with the new assignee', async () => {
    let updateState: ChainState | undefined
    install({
      task_instances: (state) => {
        if (state.op === 'update') updateState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.bulkReassign(['t1', 't2'], 'e2')
    })

    expect(updateState?.payload).toEqual({ toegewezen_medewerker_id: 'e2' })
    expect(updateState?.calls).toContainEqual({ method: 'in', args: ['id', ['t1', 't2']] })
  })

  it('markReviewHandled resets review_vereist to false', async () => {
    let updateState: ChainState | undefined
    install({
      task_instances: (state) => {
        if (state.op === 'update') updateState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useTaskInstances())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.markReviewHandled('t1')
    })

    expect(updateState?.payload).toEqual({ review_vereist: false })
  })
})
