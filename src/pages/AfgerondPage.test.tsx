import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState } from '../test/supabaseMock'
import { AfgerondPage } from './AfgerondPage'
import type { Employee } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

let ingelogd: Partial<Employee> = { id: 'e-p', naam: 'Els', rol: 'medewerker', mag_goedkeuren: true }
vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({ employee: ingelogd, loading: false, error: null }),
}))

function taak(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    client_id: 'c1',
    status: 'ingediend_afgerond',
    vereist_goedkeuring: true,
    toegewezen_medewerker_id: 'e-mw',
    periode_label: '2025',
    title: null,
    afgerond_op: '2026-10-09T15:12:00Z',
    client: { id: 'c1', naam: 'PATO', vertrouwelijk: false, actief: true, team_id: null },
    obligation_type: { id: 'ot', code: 'aangifte_venb_pb', naam: 'Aangifte VenB', categorie: 'wettelijk', werkstroom: 'belastingaangifte' },
    toegewezen_medewerker: { id: 'e-mw', naam: 'Jan' },
    goedgekeurd: { id: 'e-p', naam: 'Els' },
    ...over,
  }
}

let gevraagd: ChainState[] = []
let taken: unknown[] = []
const rpc = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ingelogd = { id: 'e-p', naam: 'Els', rol: 'medewerker', mag_goedkeuren: true }
  gevraagd = []
  taken = [
    taak('t1'),
    taak('t2', {
      vereist_goedkeuring: false,
      title: 'Bijkomend advies',
      obligation_type: null,
      periode_label: null,
      goedgekeurd: null,
      client: { id: 'c2', naam: 'Ilias Thomas', vertrouwelijk: false, actief: true, team_id: null },
    }),
  ]
  const mock = createSupabaseMock({
    task_instances: (state) => {
      gevraagd.push(state)
      return { data: taken, error: null }
    },
    employees: () => ({ data: [], error: null }),
    teams: () => ({ data: [], error: null }),
    employee_teams: () => ({ data: [], error: null }),
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
  rpc.mockResolvedValue({ data: null, error: null })
  ;(supabase.rpc as unknown as Mock).mockImplementation(rpc)
})

const navigate = vi.fn()

describe('AfgerondPage', () => {
  it('toont wat afgerond werd, met wie en wanneer', async () => {
    render(<AfgerondPage navigate={navigate} />)
    expect(await screen.findByText(/goedgekeurd door Els/)).toHaveTextContent('verantwoordelijke Jan')
    expect(screen.getByText('Bijkomend advies', { exact: false })).toBeInTheDocument()
    expect(gevraagd[0].calls).toContainEqual({ method: 'eq', args: ['status', 'ingediend_afgerond'] })
    expect(gevraagd[0].calls.some((c) => c.method === 'gte' && (c.args as unknown[])[0] === 'afgerond_op')).toBe(true)
  })

  it('heropent een taak met een reden', async () => {
    const user = userEvent.setup()
    render(<AfgerondPage navigate={navigate} />)
    await user.click(await screen.findByRole('button', { name: 'Heropenen: PATO — Aangifte VenB 2025' }))
    const bevestig = screen.getByRole('button', { name: 'Heropenen' })
    // Zonder reden kan het niet: die komt in de historiek.
    expect(bevestig).toBeDisabled()
    expect(screen.getByText(/De goedkeuring vervalt/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Waarom wordt deze taak heropend?'), 'Verkeerde aanslagjaarcode')
    await user.click(bevestig)
    expect(rpc).toHaveBeenCalledWith('taak_heropenen', { p_task_id: 't1', p_reden: 'Verkeerde aanslagjaarcode' })
    expect(await screen.findByRole('status')).toHaveTextContent('PATO — Aangifte VenB 2025 is heropend')
  })

  it('biedt een medewerker alleen zijn eigen taak zonder goedkeuring aan', async () => {
    ingelogd = { id: 'e-mw', naam: 'Jan', rol: 'medewerker', mag_goedkeuren: false }
    taken = [taak('t1'), taak('t2', { vereist_goedkeuring: false, client: { id: 'c2', naam: 'Ilias Thomas', vertrouwelijk: false, actief: true, team_id: null } })]
    render(<AfgerondPage navigate={navigate} />)
    const lijst = await screen.findByRole('list')
    const knoppen = within(lijst).getAllByRole('button', { name: /^Heropenen:/ })
    expect(knoppen).toHaveLength(1)
    expect(knoppen[0]).toHaveAccessibleName(/Ilias Thomas/)
  })

  it('kiest de periode', async () => {
    const user = userEvent.setup()
    render(<AfgerondPage navigate={navigate} />)
    await screen.findByText(/goedgekeurd door Els/)
    await user.selectOptions(screen.getByLabelText('Afgerond'), '7')
    expect(gevraagd.length).toBeGreaterThan(1)
  })
})
