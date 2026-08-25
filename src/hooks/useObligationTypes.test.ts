import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type SupabaseHandlers } from '../test/supabaseMock'
import { useObligationTypes } from './useObligationTypes'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

function install(handlers: SupabaseHandlers) {
  const mock = createSupabaseMock(handlers)
  ;(supabase.from as Mock).mockImplementation(mock.from)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useObligationTypes', () => {
  it('loads the fixed obligation-type catalogue', async () => {
    install({
      obligation_types: () => ({
        data: [
          { id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: null },
        ],
        error: null,
      }),
    })

    const { result } = renderHook(() => useObligationTypes())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.obligationTypes).toHaveLength(1)
    expect(result.current.obligationTypes[0].code).toBe('btw_aangifte')
    expect(result.current.error).toBeNull()
  })

  it('surfaces an error message instead of throwing', async () => {
    install({ obligation_types: () => ({ data: null, error: { message: 'connection refused' } }) })

    const { result } = renderHook(() => useObligationTypes())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('connection refused')
    expect(result.current.obligationTypes).toEqual([])
  })
})
