import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState } from '../test/supabaseMock'
import { TeFacturerenPage } from './TeFacturerenPage'
import type { Employee, FactuurpostMetRelaties } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

let ingelogd: Partial<Employee> = { id: 'e-partner', rol: 'medewerker', mag_goedkeuren: true }
vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({ employee: ingelogd, loading: false, error: null }),
}))

function post(over: Partial<FactuurpostMetRelaties> = {}): FactuurpostMetRelaties {
  return {
    id: 'p1',
    client_id: 'c1',
    task_instance_id: null,
    omschrijving: 'Bijkomend advies',
    uitgevoerd_op: '2026-10-01',
    notitie: null,
    status: 'te_factureren',
    factuurreferentie: null,
    aangemaakt_door: 'e-mw',
    aangemaakt_op: '2026-10-01T10:00:00Z',
    afgehandeld_door: null,
    afgehandeld_op: null,
    client: { id: 'c1', naam: 'PATO', vertrouwelijk: false, team_id: null },
    aangemaakt: { id: 'e-mw', naam: 'Jan Janssens' },
    afgehandeld: null,
    ...over,
  }
}

let posten: FactuurpostMetRelaties[] = []
let gevraagd: ChainState[] = []
const rpc = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ingelogd = { id: 'e-partner', rol: 'medewerker', mag_goedkeuren: true }
  gevraagd = []
  posten = [
    post(),
    post({ id: 'p2', omschrijving: 'Aangifte VenB — 2025', task_instance_id: 't1' }),
    post({ id: 'p3', client_id: 'c2', omschrijving: 'Herstructurering', client: { id: 'c2', naam: 'Ilias Thomas', vertrouwelijk: false, team_id: null } }),
  ]
  const mock = createSupabaseMock({
    factuurposten: (state) => {
      gevraagd.push(state)
      return { data: posten, error: null }
    },
    teams: () => ({ data: [], error: null }),
    employee_teams: () => ({ data: [], error: null }),
    clients: () => ({ data: [{ id: 'c1', naam: 'PATO' }, { id: 'c2', naam: 'Ilias Thomas' }], error: null }),
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
  rpc.mockResolvedValue({ data: 1, error: null })
  ;(supabase.rpc as unknown as Mock).mockImplementation(rpc)
})

const navigate = vi.fn()

describe('TeFacturerenPage', () => {
  it('toont de posten per klant, alfabetisch', async () => {
    render(<TeFacturerenPage navigate={navigate} />)
    const blokken = await screen.findAllByRole('region')
    expect(blokken.map((b) => b.getAttribute('aria-label'))).toEqual(['Ilias Thomas', 'PATO'])
    expect(within(blokken[1]).getByText('2 posten')).toBeInTheDocument()
    expect(within(blokken[1]).getByText('Aangifte VenB — 2025')).toBeInTheDocument()
    expect(gevraagd[0].calls).toContainEqual({ method: 'eq', args: ['status', 'te_factureren'] })
  })

  it('vinkt alles van één klant af, met factuurnummer', async () => {
    const user = userEvent.setup()
    render(<TeFacturerenPage navigate={navigate} />)
    const pato = await screen.findByRole('region', { name: 'PATO' })
    await user.type(within(pato).getByLabelText('Factuurnummer voor PATO'), 'F-2026-0142')
    await user.click(within(pato).getByRole('button', { name: 'Alle 2 gefactureerd' }))
    expect(rpc).toHaveBeenCalledWith('factuurposten_afhandelen', {
      p_ids: ['p1', 'p2'],
      p_status: 'gefactureerd',
      p_factuurreferentie: 'F-2026-0142',
    })
    expect(await screen.findByRole('status')).toHaveTextContent('2 posten afgevinkt als gefactureerd')
  })

  it('vinkt alleen de geselecteerde posten af', async () => {
    const user = userEvent.setup()
    render(<TeFacturerenPage navigate={navigate} />)
    const pato = await screen.findByRole('region', { name: 'PATO' })
    await user.click(within(pato).getByRole('checkbox', { name: 'Selecteer Bijkomend advies' }))
    await user.click(within(pato).getByRole('button', { name: '1 geselecteerd als gefactureerd' }))
    expect(rpc).toHaveBeenCalledWith('factuurposten_afhandelen', expect.objectContaining({ p_ids: ['p1'] }))
  })

  it('laat een medewerker zonder goedkeuringsrecht niet afvinken', async () => {
    // Afvinken betekent geld; de databank weigert het ook, dit scherm belooft het niet.
    ingelogd = { id: 'e-mw', rol: 'medewerker', mag_goedkeuren: false }
    render(<TeFacturerenPage navigate={navigate} />)
    await screen.findByRole('region', { name: 'PATO' })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /gefactureerd/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Niet factureren' })).not.toBeInTheDocument()
    // Wel zijn eigen posten aanpassen.
    expect(screen.getAllByRole('button', { name: 'Aanpassen' })).toHaveLength(3)
  })

  it('zet een losse prestatie op de lijst', async () => {
    const user = userEvent.setup()
    render(<TeFacturerenPage navigate={navigate} />)
    await user.click(screen.getByRole('button', { name: 'Post toevoegen' }))
    const formulier = screen.getByRole('form', { name: 'Nieuwe post' })
    await waitFor(() => expect(within(formulier).getAllByRole('option')).toHaveLength(3))
    await user.selectOptions(within(formulier).getByLabelText('Klant'), 'c2')
    await user.type(within(formulier).getByLabelText('Omschrijving'), 'Telefonisch advies')
    await user.click(within(formulier).getByRole('button', { name: 'Op de lijst zetten' }))
    expect(rpc).toHaveBeenCalledWith(
      'factuurpost_toevoegen',
      expect.objectContaining({ p_client_id: 'c2', p_omschrijving: 'Telefonisch advies', p_task_instance_id: null })
    )
  })

  it('toont bij afgehandelde posten wie het deed en het factuurnummer', async () => {
    const user = userEvent.setup()
    render(<TeFacturerenPage navigate={navigate} />)
    await screen.findByRole('region', { name: 'PATO' })
    posten = [
      post({
        status: 'gefactureerd',
        afgehandeld_door: 'e-partner',
        afgehandeld_op: '2026-10-05T14:00:00Z',
        factuurreferentie: 'F-7',
        afgehandeld: { id: 'e-partner', naam: 'Els Peeters' },
      }),
    ]
    await user.click(screen.getByRole('tab', { name: 'Gefactureerd' }))
    expect(await screen.findByText(/gefactureerd door Els Peeters/)).toHaveTextContent('factuur F-7')
    expect(screen.getByRole('button', { name: 'Terugzetten' })).toBeInTheDocument()
  })
})
