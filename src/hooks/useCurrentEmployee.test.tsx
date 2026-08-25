import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { CurrentEmployeeProvider, useCurrentEmployee } from './useCurrentEmployee'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

const mockUser = vi.fn()
vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: mockUser() }),
}))

function install(handlers: SupabaseHandlers) {
  const mock = createSupabaseMock(handlers)
  ;(supabase.from as Mock).mockImplementation(mock.from)
  return mock
}

function wrapper({ children }: { children: ReactNode }) {
  return <CurrentEmployeeProvider>{children}</CurrentEmployeeProvider>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCurrentEmployee', () => {
  it('does not query and leaves employee null when there is no signed-in auth user', async () => {
    mockUser.mockReturnValue(null)
    const from = vi.fn()
    ;(supabase.from as Mock).mockImplementation(from)

    const { result } = renderHook(() => useCurrentEmployee(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.employee).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })

  it('looks up the employees row by auth_user_id via maybeSingle (0/1 rows both valid)', async () => {
    mockUser.mockReturnValue({ id: 'auth-1' })
    let capturedState: ChainState | undefined
    install({
      employees: (state) => {
        capturedState = state
        return { data: { id: 'e1', naam: 'Jan', auth_user_id: 'auth-1', mag_goedkeuren: true }, error: null }
      },
    })

    const { result } = renderHook(() => useCurrentEmployee(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.employee?.id).toBe('e1')
    expect(capturedState?.calls).toContainEqual({ method: 'eq', args: ['auth_user_id', 'auth-1'] })
  })

  it('treats "no employees row yet" (onboarding not complete) as employee=null, not an error', async () => {
    mockUser.mockReturnValue({ id: 'auth-2' })
    install({ employees: () => ({ data: null, error: null }) })

    const { result } = renderHook(() => useCurrentEmployee(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.employee).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('surfaces a real query error distinctly from the "no profile yet" case', async () => {
    mockUser.mockReturnValue({ id: 'auth-3' })
    install({ employees: () => ({ data: null, error: new Error('rls policy violation') }) })

    const { result } = renderHook(() => useCurrentEmployee(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('rls policy violation')
    expect(result.current.employee).toBeNull()
  })

  it('throws when used outside of the CurrentEmployeeProvider', () => {
    const { result } = renderHook(() => {
      try {
        return useCurrentEmployee()
      } catch (err) {
        return err
      }
    })
    expect(result.current).toBeInstanceOf(Error)
  })
})
