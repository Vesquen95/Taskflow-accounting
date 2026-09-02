import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { TelefoonPage } from './TelefoonPage'
import { VENSTERS, vensterTot } from '../lib/werkstromen'
import type { TaskInstanceWithRelations } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

const ingelogd = {
  id: 'e1',
  firm_id: 'f1',
  auth_user_id: 'auth-1',
  naam: 'Jan',
  email: 'jan@rsm.be',
  rol: 'medewerker',
  mag_goedkeuren: false,
  actief: true,
  created_at: '2026-01-01T00:00:00Z',
}
vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({ employee: ingelogd, loading: false, error: null }),
}))

function task(overrides: Partial<TaskInstanceWithRelations> = {}): TaskInstanceWithRelations {
  return {
    id: 't1',
    client_id: 'c1',
    obligation_type_id: 'ot-btw',
    client_obligation_id: null,
    periode_label: '2026-Q3',
    periode_start: null,
    periode_eind: null,
    due_date: '2026-12-20',
    due_date_wettelijk: '2026-12-20',
    due_date_verschoven: false,
    due_date_handmatig_op: null,
    status: 'open',
    toegewezen_medewerker_id: 'e1',
    voorloper_taak_id: null,
    bron_type: 'automatisch_gegenereerd',
    voorlopige_datum: false,
    vereist_goedkeuring: false,
    goedgekeurd_door: null,
    goedgekeurd_op: null,
    review_vereist: false,
    review_reden: null,
    title: null,
    description: null,
    afgerond_op: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    client: { id: 'c1', naam: 'Klant A', vertrouwelijk: false, actief: true },
    obligation_type: { id: 'ot-btw', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' },
    toegewezen_medewerker: { id: 'e1', naam: 'Jan' },
    ...overrides,
  }
}

const taskCalls: ChainState[] = []

function install(taken: TaskInstanceWithRelations[], extra: SupabaseHandlers = {}) {
  const mock = createSupabaseMock({
    employees: () => ({ data: [{ id: 'e1', naam: 'Jan' }], error: null }),
    task_instances: (state) => {
      taskCalls.push(state)
      return { data: taken, error: null }
    },
    ...extra,
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
  return mock
}

function laatsteQuery(): ChainState {
  return taskCalls[taskCalls.length - 1]
}

function argsVan(state: ChainState, method: string, veld: string): unknown[] | undefined {
  return state.calls.find((c) => c.method === method && c.args[0] === veld)?.args
}

beforeEach(() => {
  vi.clearAllMocks()
  taskCalls.length = 0
})

describe('TelefoonPage — het deadlinevenster', () => {
  it('biedt dezelfde vensters aan als de werkstromen', async () => {
    // Eén lijst voor het hele systeem: hier en op de computer dezelfde keuzes,
    // zodat "dit kwartaal" op je telefoon hetzelfde betekent als aan je bureau.
    install([task()])
    render(<TelefoonPage />)

    const keuze = await screen.findByLabelText('Deadlinevenster')
    expect(Array.from(keuze.querySelectorAll('option')).map((o) => o.textContent)).toEqual(
      VENSTERS.map((v) => v.label)
    )
    expect(VENSTERS.map((v) => v.key)).not.toContain('deze_week')
  })

  it('begint op deze maand', async () => {
    install([task()])
    render(<TelefoonPage />)

    await waitFor(() =>
      expect(argsVan(laatsteQuery(), 'lte', 'due_date')![1]).toBe(vensterTot('deze_maand'))
    )
  })

  it('volgt de gekozen bovengrens', async () => {
    install([task()])
    render(<TelefoonPage />)
    await waitFor(() => expect(argsVan(laatsteQuery(), 'lte', 'due_date')).toBeDefined())

    await userEvent.selectOptions(screen.getByLabelText('Deadlinevenster'), 'volgend_kwartaal')

    await waitFor(() =>
      expect(argsVan(laatsteQuery(), 'lte', 'due_date')![1]).toBe(vensterTot('volgend_kwartaal'))
    )
  })

  it('laat de bovengrens helemaal los bij "Alles"', async () => {
    install([task()])
    render(<TelefoonPage />)
    await waitFor(() => expect(argsVan(laatsteQuery(), 'lte', 'due_date')).toBeDefined())

    await userEvent.selectOptions(screen.getByLabelText('Deadlinevenster'), 'alles')

    await waitFor(() => expect(argsVan(laatsteQuery(), 'lte', 'due_date')).toBeUndefined())
  })

  it('laat het venster ook los zodra je zoekt', async () => {
    // "Wanneer valt de AV van klant X?" is de vraag die je op een telefoon
    // stelt, en het antwoord ligt zelden binnen het venster dat toevallig
    // openstaat.
    install([task()])
    render(<TelefoonPage />)
    await waitFor(() => expect(argsVan(laatsteQuery(), 'lte', 'due_date')).toBeDefined())

    await userEvent.type(screen.getByLabelText('Zoeken'), 'Klant A')

    await waitFor(() => expect(argsVan(laatsteQuery(), 'lte', 'due_date')).toBeUndefined())
  })
})

describe('TelefoonPage — een leeg venster is geen doodlopend eind', () => {
  it('biedt een venster aan dat écht verder reikt', async () => {
    install([])
    render(<TelefoonPage />)

    const knop = await screen.findByRole('button', { name: /Kijk verder/ })
    const huidig = vensterTot('deze_maand')!
    // De knop mag nooit iets aanbieden dat even ver of minder ver reikt: de
    // lijst loopt niet netjes van smal naar breed (op 2 september eindigen
    // "deze maand" en "dit kwartaal" allebei op 30/09).
    const aangeboden = VENSTERS.find((v) => knop.textContent?.toLowerCase().includes(v.label.toLowerCase()))
    expect(aangeboden).toBeDefined()
    const tot = vensterTot(aangeboden!.key)
    expect(tot === undefined || tot > huidig).toBe(true)
  })

  it('houdt op met vooruitkijken bij "Alles"', async () => {
    install([])
    render(<TelefoonPage />)
    await screen.findByRole('button', { name: /Kijk verder/ })

    await userEvent.selectOptions(screen.getByLabelText('Deadlinevenster'), 'alles')

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Kijk verder/ })).toBeNull()
    )
  })

  it('zegt welk venster leeg is', async () => {
    install([])
    render(<TelefoonPage />)
    expect(await screen.findByText(/Niets te doen in het venster "Deze maand"/)).toBeInTheDocument()
  })
})
