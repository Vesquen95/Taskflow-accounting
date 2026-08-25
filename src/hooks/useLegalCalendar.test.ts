import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type RpcHandler, type SupabaseHandlers } from '../test/supabaseMock'
import { useLegalCalendar } from './useLegalCalendar'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

function install(handlers: SupabaseHandlers, rpcHandler?: RpcHandler) {
  const mock = createSupabaseMock(handlers, {}, rpcHandler)
  ;(supabase.from as Mock).mockImplementation(mock.from)
  ;(supabase.rpc as unknown as Mock).mockImplementation(mock.rpc)
  return mock
}

const baseHandlers: SupabaseHandlers = {
  legal_calendar: () => ({ data: [], error: null }),
  public_holidays: () => ({ data: [], error: null }),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useLegalCalendar — loading', () => {
  it('loads both legal_calendar entries and public_holidays in parallel', async () => {
    install({
      legal_calendar: () => ({ data: [{ id: 'lc1' }], error: null }),
      public_holidays: () => ({ data: [{ id: 'ph1' }], error: null }),
    })

    const { result } = renderHook(() => useLegalCalendar())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.entries).toEqual([{ id: 'lc1' }])
    expect(result.current.holidays).toEqual([{ id: 'ph1' }])
  })

  it('surfaces an error if either query fails', async () => {
    install({
      ...baseHandlers,
      public_holidays: () => ({ data: null, error: new Error('holidays query failed') }),
    })

    const { result } = renderHook(() => useLegalCalendar())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Kon de wettelijke kalender niet laden: holidays query failed')
  })
})

describe('useLegalCalendar — legal-calendar edits (§3.4 traceability)', () => {
  it('addEntry stamps both aangemaakt_door and gewijzigd_door with the acting employee id', async () => {
    let insertState: ChainState | undefined
    install({
      ...baseHandlers,
      legal_calendar: (state) => {
        if (state.op === 'insert') insertState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useLegalCalendar())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addEntry({
        obligation_type_id: 'ot1',
        jaar: 2027,
        scope: null,
        deadline_datum: '2027-06-30',
        is_override: true,
        bron: 'FOD update',
        actorId: 'admin-1',
      })
    })

    expect(insertState?.payload).toMatchObject({
      aangemaakt_door: 'admin-1',
      gewijzigd_door: 'admin-1',
      is_override: true,
      deadline_datum: '2027-06-30',
    })
  })

  it('addHoliday stamps the acting employee id as well', async () => {
    let insertState: ChainState | undefined
    install({
      ...baseHandlers,
      public_holidays: (state) => {
        if (state.op === 'insert') insertState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useLegalCalendar())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addHoliday({ jaar: 2027, datum: '2027-07-21', omschrijving: 'Nationale feestdag', actorId: 'admin-1' })
    })

    expect(insertState?.payload).toMatchObject({ aangemaakt_door: 'admin-1', gewijzigd_door: 'admin-1' })
  })
})

describe('useLegalCalendar — generateTaskInstances (recurrence-engine trigger)', () => {
  it('calls the generate_task_instances RPC with horizon/backfill params and returns the created count', async () => {
    let calledFn: string | undefined
    let calledArgs: unknown
    install(baseHandlers, (fnName, args) => {
      calledFn = fnName
      calledArgs = args
      return { data: 17, error: null }
    })

    const { result } = renderHook(() => useLegalCalendar())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let count: number | undefined
    await act(async () => {
      count = await result.current.generateTaskInstances(3, 6)
    })

    expect(calledFn).toBe('generate_task_instances')
    expect(calledArgs).toEqual({ p_horizon_months: 3, p_backfill_months: 6 })
    expect(count).toBe(17)
  })

  it('propagates an RPC error instead of silently returning 0', async () => {
    install(baseHandlers, () => ({ data: null, error: new Error('permission denied for function') }))

    const { result } = renderHook(() => useLegalCalendar())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(result.current.generateTaskInstances()).rejects.toThrow('permission denied for function')
  })

  it('defaults to a 3-month horizon and 6-month backfill when called with no args', async () => {
    let calledArgs: unknown
    install(baseHandlers, (_fn, args) => {
      calledArgs = args
      return { data: 0, error: null }
    })

    const { result } = renderHook(() => useLegalCalendar())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.generateTaskInstances()
    })

    expect(calledArgs).toEqual({ p_horizon_months: 3, p_backfill_months: 6 })
  })
})
