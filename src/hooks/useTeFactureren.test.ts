import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState } from '../test/supabaseMock'
import { meldFactuurpostenGewijzigd } from '../lib/facturatie'
import { useTeFactureren } from './useTeFactureren'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

let gevraagd: ChainState[] = []
let aantal = 3

beforeEach(() => {
  vi.clearAllMocks()
  gevraagd = []
  aantal = 3
  const mock = createSupabaseMock({
    factuurposten: (state) => {
      gevraagd.push(state)
      return { data: null, error: null, count: aantal }
    },
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
})

describe('useTeFactureren', () => {
  it('telt de posten die nog te factureren zijn', async () => {
    const { result } = renderHook(() => useTeFactureren('kalender/'))
    await waitFor(() => expect(result.current).toBe(3))
    expect(gevraagd[0].calls).toContainEqual({ method: 'eq', args: ['status', 'te_factureren'] })
  })

  it('telt opnieuw zodra er ergens een post bijkomt of afgevinkt wordt', async () => {
    const { result } = renderHook(() => useTeFactureren('facturatie/'))
    await waitFor(() => expect(result.current).toBe(3))
    aantal = 1
    meldFactuurpostenGewijzigd()
    await waitFor(() => expect(result.current).toBe(1))
  })
})
