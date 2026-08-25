import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type RpcHandler, type SupabaseHandlers } from '../test/supabaseMock'
import { useEmployees } from './useEmployees'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

function install(handlers: SupabaseHandlers, rpcHandler?: RpcHandler) {
  const mock = createSupabaseMock(handlers, {}, rpcHandler)
  ;(supabase.from as Mock).mockImplementation(mock.from)
  ;(supabase.rpc as unknown as Mock).mockImplementation(mock.rpc)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useEmployees', () => {
  it('loads employees ordered by naam', async () => {
    install({ employees: () => ({ data: [{ id: 'e1', naam: 'Jan' }], error: null }) })

    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.employees).toEqual([{ id: 'e1', naam: 'Jan' }])
  })

  it('surfaces a load error', async () => {
    install({ employees: () => ({ data: null, error: new Error('rls denied') }) })

    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Kon medewerkers niet laden: rls denied')
  })

  it('inviteEmployee calls the invite_employee RPC with the right args and reloads', async () => {
    let calledFn: string | undefined
    let calledArgs: unknown
    install({ employees: () => ({ data: [], error: null }) }, (fnName, args) => {
      calledFn = fnName
      calledArgs = args
      return { data: null, error: null }
    })

    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.inviteEmployee({ naam: 'Nieuwe Collega', email: 'new@firm.be', rol: 'medewerker', mag_goedkeuren: false })
    })

    expect(calledFn).toBe('invite_employee')
    expect(calledArgs).toEqual({
      p_naam: 'Nieuwe Collega',
      p_email: 'new@firm.be',
      p_rol: 'medewerker',
      p_mag_goedkeuren: false,
    })
  })

  it('inviteEmployee throws when the RPC returns an error (e.g. duplicate invite)', async () => {
    install({ employees: () => ({ data: [], error: null }) }, () => ({
      data: null,
      error: new Error('already invited'),
    }))

    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(
      result.current.inviteEmployee({ naam: 'X', email: 'x@firm.be', rol: 'medewerker', mag_goedkeuren: false })
    ).rejects.toThrow('already invited')
  })

  it('updateEmployee (e.g. deactivation) updates by id — server-side offboarding-block trigger surfaces as a rejected promise', async () => {
    let updateState: ChainState | undefined
    install({
      employees: (state) => {
        if (state.op === 'update') updateState = state
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.updateEmployee('e1', { actief: false })
    })

    expect(updateState?.payload).toEqual({ actief: false })
    expect(updateState?.calls).toContainEqual({ method: 'eq', args: ['id', 'e1'] })
  })

  it('updateEmployee surfaces the DB offboarding-block error (still has open task instances) instead of swallowing it', async () => {
    install({
      employees: (state) => {
        if (state.op === 'update') {
          return { data: null, error: new Error('cannot deactivate: employee still has open task instances') }
        }
        return { data: [], error: null }
      },
    })

    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(result.current.updateEmployee('e1', { actief: false })).rejects.toThrow(
      'cannot deactivate: employee still has open task instances'
    )
  })
})
