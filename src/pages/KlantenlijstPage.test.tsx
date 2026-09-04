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
      niveau: null,
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
    klantsoort: 'rechtspersoon',
    ondernemingsnummer: 'BE0123.456.789',
    rechtsvorm: 'BV',
    boekjaar_einde_maand: 12,
    boekjaar_einde_dag: 31,
    btw_regime: 'periodieke_aangever',
    btw_aangifte_frequentie: 'kwartaal',
    mandataris: false,
    vertrouwelijk: false,
    standaard_verantwoordelijke_id: 'e1',
    team_id: null,
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
      // Het scherm kent sinds de teams ook een teamkolom en een teamfilter.
      // De codes uit de voorbeeldrijen van het sjabloon moeten erbij zijn:
      // een onbekende teamcode is een rijfout, en dan zou het sjabloon zijn
      // eigen voorbeeld afkeuren.
      teams: () => ({
        data: [
          { id: 't1', firm_id: 'f1', code: 'ZAV1', naam: 'Zaventem 1', vestiging: 'Zaventem', actief: true, created_at: '2026-01-01T00:00:00Z' },
          { id: 't2', firm_id: 'f1', code: 'AAL', naam: 'Aalst', vestiging: 'Aalst', actief: true, created_at: '2026-01-01T00:00:00Z' },
        ],
        error: null,
      }),
      employee_teams: () => ({ data: [], error: null }),
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

describe('KlantenlijstPage — klanten importeren uit Excel', () => {
  /** Zet een echt sjabloonbestand klaar zoals een medewerker het aanlevert. */
  async function sjabloonBestand() {
    const { bouwSjabloonBlob } = await import('../lib/klantImportBestand')
    return new File([await bouwSjabloonBlob()], 'klanten.xlsx')
  }

  function installMetInsert(clients: Client[]) {
    const inserts: Array<Record<string, unknown>> = []
    const handlers: SupabaseHandlers = {
      clients: (state) => {
        if (state.op === 'insert') {
          inserts.push(state.payload as Record<string, unknown>)
          return { data: client({ id: `c${inserts.length}` }), error: null }
        }
        return { data: clients, error: null }
      },
      employees: () => ({ data: [{ id: 'e1', naam: 'Jan' }], error: null }),
      // Het scherm kent sinds de teams ook een teamkolom en een teamfilter.
      // De codes uit de voorbeeldrijen van het sjabloon moeten erbij zijn:
      // een onbekende teamcode is een rijfout, en dan zou het sjabloon zijn
      // eigen voorbeeld afkeuren.
      teams: () => ({
        data: [
          { id: 't1', firm_id: 'f1', code: 'ZAV1', naam: 'Zaventem 1', vestiging: 'Zaventem', actief: true, created_at: '2026-01-01T00:00:00Z' },
          { id: 't2', firm_id: 'f1', code: 'AAL', naam: 'Aalst', vestiging: 'Aalst', actief: true, created_at: '2026-01-01T00:00:00Z' },
        ],
        error: null,
      }),
      employee_teams: () => ({ data: [], error: null }),
      obligation_types: () => ({ data: [], error: null }),
    }
    const mock = createSupabaseMock(handlers)
    ;(supabase.from as Mock).mockImplementation(mock.from)
    ;(supabase.rpc as Mock).mockResolvedValue({ data: 4, error: null })
    return inserts
  }

  it('leest het eigen sjabloon in en toont het voorbeeld voor er iets opgeslagen wordt', async () => {
    const user = userEvent.setup()
    const inserts = installMetInsert([client()])
    render(<KlantenlijstPage navigate={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Importeren uit Excel' }))
    await user.upload(await screen.findByLabelText(/Excel-bestand/i), await sjabloonBestand())

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('table')).toHaveTextContent('Voorbeeld BV')
    expect(inserts).toHaveLength(0)
  })

  it('maakt de klanten aan zonder vertrouwelijk of standaard verantwoordelijke', async () => {
    const user = userEvent.setup()
    const inserts = installMetInsert([client()])
    render(<KlantenlijstPage navigate={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Importeren uit Excel' }))
    await user.upload(await screen.findByLabelText(/Excel-bestand/i), await sjabloonBestand())
    await user.click(await screen.findByRole('button', { name: /2 klanten importeren/i }))

    await waitFor(() => expect(inserts).toHaveLength(2))
    // block_unaudited_confidentiality_change() (migratie 0009) weigert bij een
    // INSERT elke andere waarde voor een gewone medewerker; de import belooft
    // ze dus niet.
    expect(inserts.every((i) => i.vertrouwelijk === false)).toBe(true)
    expect(inserts.every((i) => i.standaard_verantwoordelijke_id === null)).toBe(true)
    expect(inserts.every((i) => i.firm_id === 'f1' && i.actief === true)).toBe(true)
    expect(inserts[0]).toMatchObject({
      naam: 'Voorbeeld BV',
      klantsoort: 'rechtspersoon',
      ondernemingsnummer: 'BE0123.456.749',
      btw_regime: 'periodieke_aangever',
      btw_aangifte_frequentie: 'kwartaal',
      mandataris: true,
    })
    expect(inserts[1]).toMatchObject({
      naam: 'Tweede Voorbeeld VZW',
      klantsoort: 'rechtspersoon',
      ondernemingsnummer: null,
      btw_regime: 'vrijgesteld_kleine_onderneming',
      btw_aangifte_frequentie: null,
    })
    expect(await screen.findByText(/2 klanten aangemaakt/i)).toBeInTheDocument()

    // De trigger sync_btw_obligations maakt de btw-verplichtingen aan, maar
    // niet de taken. Zonder deze oproep zou een geïmporteerde klant met een
    // lege kalender achterblijven.
    expect((supabase.rpc as Mock).mock.calls.filter((c) => c[0] === 'sync_client_tasks')).toHaveLength(2)
  })
})
