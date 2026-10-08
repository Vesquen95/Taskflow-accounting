import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock } from '../test/supabaseMock'
import { TeFacturerenKnop } from './TeFacturerenKnop'
import type { TaskInstanceWithRelations } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

const taak = {
  id: 't1',
  client_id: 'c1',
  title: null,
  periode_label: 'VA3-2026',
  obligation_type: { id: 'ot', code: 'va_venb', naam: 'Voorafbetaling VenB (VA1-VA4)', categorie: 'wettelijk', werkstroom: 'belastingaangifte' },
  client: { id: 'c1', naam: 'PATO', vertrouwelijk: false, actief: true, team_id: null },
} as unknown as TaskInstanceWithRelations

let open: unknown = null
const rpc = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  open = null
  const mock = createSupabaseMock({ factuurposten: () => ({ data: open, error: null }) })
  ;(supabase.from as Mock).mockImplementation(mock.from)
  rpc.mockResolvedValue({ data: 'p1', error: null })
  ;(supabase.rpc as unknown as Mock).mockImplementation(rpc)
})

describe('TeFacturerenKnop', () => {
  it('zet de taak met haar naam en periode op de lijst', async () => {
    render(<TeFacturerenKnop task={taak} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Op de lijst te factureren' }))
    expect(rpc).toHaveBeenCalledWith(
      'factuurpost_toevoegen',
      expect.objectContaining({ p_client_id: 'c1', p_task_instance_id: 't1', p_omschrijving: 'Voorafbetaling VA3 — 2026' })
    )
  })

  it('zegt het als de taak er al op staat, in plaats van een tweede regel te maken', async () => {
    open = { id: 'p1', aangemaakt_op: '2026-10-02T09:00:00Z', aangemaakt: { naam: 'Jan Janssens' } }
    render(<TeFacturerenKnop task={taak} />)
    expect(await screen.findByText(/Staat op de lijst te factureren/)).toHaveTextContent('Jan Janssens')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
