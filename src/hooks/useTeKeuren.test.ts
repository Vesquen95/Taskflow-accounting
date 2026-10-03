import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState } from '../test/supabaseMock'
import { meldStatusGewijzigd, useTeKeuren } from './useTeKeuren'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

let gevraagd: ChainState[] = []

beforeEach(() => {
  vi.clearAllMocks()
  gevraagd = []
  const mock = createSupabaseMock({
    task_instances: (state) => {
      gevraagd.push(state)
      return { data: null, error: null, count: 4 }
    },
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
})

describe('useTeKeuren', () => {
  it('telt de taken die op goedkeuring wachten', async () => {
    const { result } = renderHook(() => useTeKeuren(true, 'kalender/'))
    await waitFor(() => expect(result.current).toBe(4))
    expect(gevraagd[0].calls).toContainEqual({ method: 'eq', args: ['status', 'wacht_op_goedkeuring'] })
  })

  it('vraagt niets op voor wie niet mag goedkeuren', async () => {
    const { result } = renderHook(() => useTeKeuren(false, 'kalender/'))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('telt opnieuw bij een schermwissel', async () => {
    // Wie net goedkeurde en naar een ander scherm gaat, ziet het getal zakken
    // zonder op de minuut te wachten.
    const { result, rerender } = renderHook(({ sleutel }) => useTeKeuren(true, sleutel), {
      initialProps: { sleutel: 'goedkeuring/' },
    })
    await waitFor(() => expect(result.current).toBe(4))
    const voor = gevraagd.length
    rerender({ sleutel: 'kalender/' })
    await waitFor(() => expect(gevraagd.length).toBe(voor + 1))
  })
  it('telt opnieuw zodra ergens een status wijzigt', async () => {
    // Goedkeuren op het goedkeuringsscherm zelf: geen schermwissel, en toch
    // hoort het getal meteen te zakken.
    const { result } = renderHook(() => useTeKeuren(true, 'goedkeuring/'))
    await waitFor(() => expect(result.current).toBe(4))
    const voor = gevraagd.length
    meldStatusGewijzigd()
    await waitFor(() => expect(gevraagd.length).toBe(voor + 1))
  })
})
