import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { KlantDossierPage } from './KlantDossierPage'
import { meldFactuurpostenGewijzigd } from '../lib/facturatie'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

// TaskDetailModal hangt aan de ingelogde medewerker; de pagina rendert hem
// pas bij een klik, maar de mock houdt de test onafhankelijk van de provider.
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

function task(id: string, status: string) {
  return {
    id,
    client_id: 'c1',
    obligation_type_id: 'ot-btw',
    client_obligation_id: null,
    periode_label: '2026-Q1',
    periode_start: null,
    periode_eind: null,
    due_date: '2026-10-20',
    due_date_wettelijk: '2026-10-20',
    due_date_verschoven: false,
    due_date_handmatig_op: null,
    status,
    toegewezen_medewerker_id: 'e1',
    voorloper_taak_id: null,
    bron_type: 'automatisch_gegenereerd',
    voorlopige_datum: false,
    vereist_goedkeuring: true,
    goedgekeurd_door: null,
    goedgekeurd_op: null,
    review_vereist: false,
    review_reden: null,
    title: null,
    description: null,
    afgerond_op: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    obligation_type: { id: 'ot-btw', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' },
    toegewezen_medewerker: { id: 'e1', naam: 'Jan' },
  }
}

function handlers(clientOverrides: Record<string, unknown> = {}, taken = [task('t1', 'open'), task('t2', 'in_uitvoering'), task('t3', 'ingediend_afgerond'), task('t4', 'geannuleerd')]): SupabaseHandlers {
  return {
    clients: (state) => {
      if (state.op === 'update') return { data: null, error: null }
      return {
        data: {
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
          ...clientOverrides,
        },
        error: null,
      }
    },
    client_obligations: () => ({ data: [], error: null }),
    task_instances: () => ({ data: taken, error: null }),
    client_change_log: () => ({ data: [], error: null }),
    employees: () => ({ data: [{ id: 'e1', naam: 'Jan' }], error: null }),
    obligation_types: () => ({ data: [], error: null }),
  }
}

function install(h: SupabaseHandlers) {
  const mock = createSupabaseMock(h, {}, () => ({ data: 3, error: null }))
  ;(supabase.from as Mock).mockImplementation(mock.from)
  ;(supabase.rpc as Mock).mockImplementation(mock.rpc)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('KlantDossierPage — archiveren', () => {
  it('vraagt een bevestiging die het aantal te annuleren taken noemt', async () => {
    const user = userEvent.setup()
    install(handlers())
    render(<KlantDossierPage clientId="c1" navigate={vi.fn()} />)

    await screen.findByRole('heading', { name: /Acme BV/ })
    await user.click(screen.getByRole('button', { name: 'Archiveren' }))

    // Twee van de vier taken staan nog open (open + in uitvoering); de
    // afgeronde en de al geannuleerde tellen niet mee.
    expect(await screen.findByRole('dialog')).toHaveTextContent('2 openstaande taken')
  })

  it('zet actief op false zodra de archivering bevestigd is', async () => {
    const user = userEvent.setup()
    const updates: ChainState[] = []
    const h = handlers()
    const basis = h.clients
    h.clients = (state) => {
      if (state.op === 'update') updates.push(state)
      return basis(state)
    }
    install(h)
    render(<KlantDossierPage clientId="c1" navigate={vi.fn()} />)

    await screen.findByRole('heading', { name: /Acme BV/ })
    await user.click(screen.getByRole('button', { name: 'Archiveren' }))
    await user.click(await screen.findByRole('button', { name: 'Archiveren en 2 taken annuleren' }))

    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0].payload).toEqual({ actief: false })
    expect(updates[0].calls).toContainEqual({ method: 'eq', args: ['id', 'c1'] })
  })

  it('archiveert niets zolang er niet bevestigd is', async () => {
    const user = userEvent.setup()
    const updates: ChainState[] = []
    const h = handlers()
    const basis = h.clients
    h.clients = (state) => {
      if (state.op === 'update') updates.push(state)
      return basis(state)
    }
    install(h)
    render(<KlantDossierPage clientId="c1" navigate={vi.fn()} />)

    await screen.findByRole('heading', { name: /Acme BV/ })
    await user.click(screen.getByRole('button', { name: 'Archiveren' }))
    await user.click(await screen.findByRole('button', { name: 'Annuleren' }))

    expect(updates).toHaveLength(0)
  })
})

describe('KlantDossierPage — een gearchiveerd dossier', () => {
  it('biedt heractiveren aan i.p.v. archiveren, en laat de generator meteen bijwerken', async () => {
    const user = userEvent.setup()
    const updates: ChainState[] = []
    const h = handlers({ actief: false }, [task('t4', 'geannuleerd')])
    const basis = h.clients
    h.clients = (state) => {
      if (state.op === 'update') updates.push(state)
      return basis(state)
    }
    const mock = install(h)
    render(<KlantDossierPage clientId="c1" navigate={vi.fn()} />)

    await screen.findByRole('heading', { name: /Acme BV/ })
    expect(screen.queryByRole('button', { name: 'Archiveren' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Heractiveren' }))

    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0].payload).toEqual({ actief: true })
    // De verplichtingen lopen nog: de taken horen meteen terug te komen, niet
    // pas bij de maandelijkse onderhoudsronde.
    expect(mock.rpc).toHaveBeenCalledWith('sync_client_tasks', { p_client_id: 'c1' })
  })
})

describe('KlantDossierPage — de wijzigingshistoriek leesbaar', () => {
  function metLog() {
    const h = handlers()
    h.employees = () => ({
      data: [
        { id: 'e1', naam: 'Jan' },
        { id: '8f3c1a2b-0000-4000-8000-000000000002', naam: 'Els Peeters' },
        { id: '8f3c1a2b-0000-4000-8000-000000000003', naam: 'Rik Claes' },
      ],
      error: null,
    })
    h.client_change_log = () => ({
      data: [
        {
          id: 'l1',
          client_id: 'c1',
          veld: 'taken_volgen_verantwoordelijke',
          oude_waarde: '6 openstaande taken stonden op 8f3c1a2b-0000-4000-8000-000000000002',
          nieuwe_waarde: '8f3c1a2b-0000-4000-8000-000000000003',
          actor_employee_id: 'e1',
          created_at: '2026-09-06T10:00:00Z',
          actor: { id: 'e1', naam: 'Jan' },
        },
      ],
      error: null,
    })
    return h
  }

  it('zegt in gewone taal wat er gebeurde, met namen in plaats van uuids', async () => {
    install(metLog())
    render(<KlantDossierPage clientId="c1" navigate={vi.fn()} />)

    const regel = await screen.findByText(/Openstaande taken mee verplaatst/)
    const li = regel.closest('li')!
    expect(li).toHaveTextContent('6 openstaande taken stonden op Els Peeters')
    expect(li).toHaveTextContent('Rik Claes')
    expect(li.textContent).not.toMatch(/8f3c1a2b/)
  })
})

describe('KlantDossierPage — te factureren', () => {
  const openPost = {
    id: 'p1',
    client_id: 'c1',
    task_instance_id: null,
    omschrijving: 'Bijkomend advies',
    uitgevoerd_op: '2026-10-01',
    notitie: null,
    status: 'te_factureren',
    factuurreferentie: null,
    aangemaakt_door: 'e1',
    aangemaakt_op: '2026-10-01T10:00:00Z',
    afgehandeld_door: null,
    afgehandeld_op: null,
    client: { id: 'c1', naam: 'Acme BV', vertrouwelijk: false, team_id: null },
    aangemaakt: { id: 'e1', naam: 'Jan' },
    afgehandeld: null,
  }

  it('toont wat er voor deze klant nog te factureren is, en alleen dat', async () => {
    const gevraagd: ChainState[] = []
    install({
      ...handlers(),
      factuurposten: (state) => {
        gevraagd.push(state)
        return { data: [openPost], error: null }
      },
    })
    render(<KlantDossierPage clientId="c1" navigate={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Te factureren (1)' })).toBeInTheDocument()
    expect(screen.getByText('Bijkomend advies')).toBeInTheDocument()
    expect(gevraagd[0].calls).toContainEqual({ method: 'eq', args: ['client_id', 'c1'] })
    expect(gevraagd[0].calls).toContainEqual({ method: 'eq', args: ['status', 'te_factureren'] })
  })

  it('zet een post op de lijst voor deze klant, zonder klant te moeten kiezen', async () => {
    const user = userEvent.setup()
    install({ ...handlers(), factuurposten: () => ({ data: [], error: null }) })
    render(<KlantDossierPage clientId="c1" navigate={vi.fn()} />)

    expect(await screen.findByText('Niets te factureren voor deze klant.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+ Post toevoegen' }))
    const formulier = screen.getByRole('form', { name: 'Nieuwe post' })
    expect(screen.queryByLabelText('Klant')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Omschrijving'), 'Telefonisch advies')
    await user.click(screen.getByRole('button', { name: 'Op de lijst zetten' }))

    expect(supabase.rpc).toHaveBeenCalledWith(
      'factuurpost_toevoegen',
      expect.objectContaining({ p_client_id: 'c1', p_omschrijving: 'Telefonisch advies' })
    )
    await waitFor(() => expect(formulier).not.toBeInTheDocument())
  })

  it('brengt je naar het volledige overzicht', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    install({ ...handlers(), factuurposten: () => ({ data: [openPost], error: null }) })
    render(<KlantDossierPage clientId="c1" navigate={navigate} />)

    await user.click(await screen.findByRole('button', { name: 'Alles bekijken' }))
    expect(navigate).toHaveBeenCalledWith('facturatie')
  })
  it('werkt bij zodra ergens anders een post op de lijst komt', async () => {
    // Het taakvenster ligt bovenop het dossier; "Op de lijst te factureren"
    // daar hoort meteen zichtbaar te zijn in het blok eronder.
    let antwoord: unknown[] = []
    install({ ...handlers(), factuurposten: () => ({ data: antwoord, error: null }) })
    render(<KlantDossierPage clientId="c1" navigate={vi.fn()} />)

    expect(await screen.findByText('Niets te factureren voor deze klant.')).toBeInTheDocument()
    antwoord = [openPost]
    meldFactuurpostenGewijzigd()
    expect(await screen.findByText('Bijkomend advies')).toBeInTheDocument()
  })
})
