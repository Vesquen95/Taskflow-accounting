import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { KlantenlijstPage } from './KlantenlijstPage'
import type { Client } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({
    employee: {
      id: 'e1',
      firm_id: 'f1',
      auth_user_id: 'auth-1',
      naam: 'Jan',
      email: 'jan@rsm.be',
      rol: 'kantoorbeheerder',
      mag_goedkeuren: true,
      actief: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}))

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    firm_id: 'f1',
    naam: 'Acme BV',
    ondernemingsnummer: 'BE0123.456.789',
    rechtsvorm: 'BV',
    boekjaar_einde_maand: 12,
    boekjaar_einde_dag: 31,
    btw_regime: 'periodieke_aangever',
    btw_aangifte_frequentie: 'kwartaal',
    mandataris: false,
    vertrouwelijk: false,
    standaard_verantwoordelijke_id: 'e1',
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function install(clients: Client[], onQuery?: (state: ChainState) => void) {
  const handlers: SupabaseHandlers = {
    clients: (state) => {
      onQuery?.(state)
      return { data: clients, error: null }
    },
    employees: () => ({ data: [{ id: 'e1', naam: 'Jan' }], error: null }),
    obligation_types: () => ({ data: [], error: null }),
  }
  const mock = createSupabaseMock(handlers)
  ;(supabase.from as Mock).mockImplementation(mock.from)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('KlantenlijstPage — gearchiveerde klanten', () => {
  it('toont standaard enkel de actieve klanten', async () => {
    const queries: ChainState[] = []
    install([client()], (state) => queries.push(state))
    render(<KlantenlijstPage navigate={vi.fn()} />)

    await screen.findByText('Acme BV')
    expect(queries[0].calls).toContainEqual({ method: 'eq', args: ['actief', true] })
  })

  it('laat gearchiveerde klanten terugvinden via het statusfilter', async () => {
    const user = userEvent.setup()
    const queries: ChainState[] = []
    install([client()], (state) => queries.push(state))
    render(<KlantenlijstPage navigate={vi.fn()} />)

    await screen.findByText('Acme BV')
    const filter = screen.getByLabelText('Status')
    expect(screen.getByRole('option', { name: 'Gearchiveerd' })).toBeInTheDocument()

    await user.selectOptions(filter, 'alle')
    await waitFor(() => expect(queries.length).toBeGreaterThan(1))
    const laatste = queries[queries.length - 1]
    expect(laatste.calls).not.toContainEqual({ method: 'eq', args: ['actief', true] })
    expect(laatste.calls).not.toContainEqual({ method: 'eq', args: ['actief', false] })
  })

  it('noemt een niet-actieve klant gearchiveerd, niet inactief', async () => {
    install([client({ actief: false })])
    render(<KlantenlijstPage navigate={vi.fn()} />)

    await screen.findByText('Acme BV')
    // "Gearchiveerd" staat ook in het statusfilter; het gaat hier om de
    // badge in de rij zelf.
    const rij = screen.getByText('Acme BV').closest('tr') as HTMLElement
    expect(within(rij).getByText('Gearchiveerd')).toBeInTheDocument()
    expect(screen.queryByText('Inactief')).not.toBeInTheDocument()
  })
})
