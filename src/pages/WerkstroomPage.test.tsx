import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState, type SupabaseHandlers } from '../test/supabaseMock'
import { WerkstroomPage } from './WerkstroomPage'
import { ingangVoorPad, vensterTot } from '../lib/werkstromen'
import type { ObligationType, TaskInstanceWithRelations } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

// De pagina heeft de ingelogde medewerker nodig om te weten welke statusstap
// deze persoon mag zetten. Zonder provider valt de hook om, dus die mocken we.
const ingelogd = {
  id: 'e1',
  firm_id: 'f1',
  auth_user_id: 'auth-1',
  naam: 'Jan',
  email: 'jan@rsm.be',
  rol: 'kantoorbeheerder',
  mag_goedkeuren: true,
  actief: true,
  created_at: '2026-01-01T00:00:00Z',
}
vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({ employee: ingelogd, loading: false, error: null }),
}))

const obligationTypes: ObligationType[] = [
  { id: 'ot-btw', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: null, werkstroom: 'btw' },
  { id: 'ot-lst', code: 'btw_klantenlisting', naam: 'BTW-klantenlisting', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: null, werkstroom: 'btw' },
  { id: 'ot-jaf', code: 'jaarafsluiting', naam: 'Jaarafsluiting', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: null, werkstroom: 'afsluiting' },
]

function task(overrides: Partial<TaskInstanceWithRelations> = {}): TaskInstanceWithRelations {
  return {
    id: 't1',
    client_id: 'c1',
    obligation_type_id: 'ot-btw',
    client_obligation_id: null,
    periode_label: '2026-Q1',
    periode_start: null,
    periode_eind: null,
    due_date: '2026-09-20',
    due_date_wettelijk: '2026-09-20',
    due_date_verschoven: false,
    due_date_handmatig_op: null,
    status: 'open',
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
    client: { id: 'c1', naam: 'Klant A', vertrouwelijk: false, actief: true, team_id: null },
    obligation_type: { id: 'ot-btw', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' },
    toegewezen_medewerker: { id: 'e1', naam: 'Jan' },
    ...overrides,
  }
}

const taskCalls: ChainState[] = []

function install(taken: TaskInstanceWithRelations[], extra: SupabaseHandlers = {}) {
  const mock = createSupabaseMock({
    obligation_types: () => ({ data: obligationTypes, error: null }),
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

/** De laatste task_instances-query — daarvoor moeten de filters kloppen; de
 *  eerdere zijn de smalle startronde en de ronde vóór de catalogus binnen was. */
function laatsteQuery(): ChainState {
  return taskCalls[taskCalls.length - 1]
}

function argsVan(state: ChainState, method: string, veld: string): unknown[] | undefined {
  return state.calls.find((c) => c.method === method && c.args[0] === veld)?.args
}

const btw = ingangVoorPad('btw')!
const adhoc = ingangVoorPad('adhoc')!

beforeEach(() => {
  vi.clearAllMocks()
  taskCalls.length = 0
})

describe('WerkstroomPage', () => {
  it('vraagt enkel de verplichtingstypes van deze werkstroom op', async () => {
    install([task()])
    render(<WerkstroomPage ingang={btw} />)

    await waitFor(() =>
      expect(argsVan(laatsteQuery(), 'in', 'obligation_type_id')).toEqual([
        'obligation_type_id',
        ['ot-btw', 'ot-lst'],
      ])
    )
    // De jaarafsluiting hoort in een andere ingang en mag hier niet meekomen.
    expect(argsVan(laatsteQuery(), 'in', 'obligation_type_id')?.[1]).not.toContain('ot-jaf')
  })

  it('haalt bij het openen niet eerst alle taken van het kantoor op', async () => {
    install([task()])
    render(<WerkstroomPage ingang={btw} />)

    // Ook de allereerste ronde is al begrensd op type én deadline.
    await waitFor(() => expect(taskCalls.length).toBeGreaterThan(0))
    expect(argsVan(taskCalls[0], 'in', 'obligation_type_id')).toBeDefined()
    expect(argsVan(taskCalls[0], 'lte', 'due_date')).toBeDefined()
  })

  it('vraagt bij het openen één keer naar de taken, niet twee keer', async () => {
    install([task()])
    render(<WerkstroomPage ingang={btw} />)

    await screen.findByText('Klant A')
    await new Promise((r) => setTimeout(r, 50))
    expect(taskCalls).toHaveLength(1)
  })

  it('begrenst het deadlinevenster bovenaan en volgt de gekozen keuze', async () => {
    install([task()])
    render(<WerkstroomPage ingang={btw} />)

    // De eerste ronde staat op "deze maand".
    await waitFor(() =>
      expect(argsVan(laatsteQuery(), 'lte', 'due_date')![1]).toBe(vensterTot('deze_maand'))
    )

    await userEvent.selectOptions(screen.getByLabelText('Deadlinevenster'), 'dit_kwartaal')

    // Precies de bovengrens van het gekozen venster, en niet "ergens ruimer":
    // elk venster is een einddatum, geen rangorde.
    await waitFor(() =>
      expect(argsVan(laatsteQuery(), 'lte', 'due_date')![1]).toBe(vensterTot('dit_kwartaal'))
    )
  })

  it('laat het venster helemaal los bij "Alles"', async () => {
    install([task()])
    render(<WerkstroomPage ingang={btw} />)
    await waitFor(() => expect(argsVan(laatsteQuery(), 'lte', 'due_date')).toBeDefined())

    await userEvent.selectOptions(screen.getByLabelText('Deadlinevenster'), 'alles')

    await waitFor(() => expect(argsVan(laatsteQuery(), 'lte', 'due_date')).toBeUndefined())
  })

  it('vraagt voor de ad-hoc ingang de taken zonder verplichtingstype op', async () => {
    install([task({ obligation_type_id: null, obligation_type: null, title: 'Losse taak' })])
    render(<WerkstroomPage ingang={adhoc} />)

    await waitFor(() =>
      expect(argsVan(laatsteQuery(), 'is', 'obligation_type_id')).toEqual([
        'obligation_type_id',
        null,
      ])
    )
    expect(argsVan(laatsteQuery(), 'in', 'obligation_type_id')).toBeUndefined()
  })

  it('biedt de deadlinevensters die het kantoor plant, met "Alles" als laatste', async () => {
    install([task()])
    render(<WerkstroomPage ingang={btw} />)

    const keuze = await screen.findByLabelText('Deadlinevenster')
    expect(
      Array.from(keuze.querySelectorAll('option')).map((o) => o.textContent)
    ).toEqual(['Deze maand', 'Volgende maand', 'Dit kwartaal', 'Volgend kwartaal', 'Alles'])
  })

  it('toont de taken in blokken per maand, met de achterstand vooraan', async () => {
    // Lokale datum, net als de groepering zelf: met toISOString zou een taak
    // rond middernacht in de verkeerde maand belanden.
    const isoLokaal = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const gisteren = isoLokaal(new Date(Date.now() - 86400000))
    const overEenWeek = isoLokaal(new Date(Date.now() + 7 * 86400000))
    const maandKop = new Date(`${overEenWeek.slice(0, 7)}-01T00:00:00`).toLocaleDateString(
      'nl-BE',
      { month: 'long', year: 'numeric' }
    )
    install([
      task({ id: 't-laat', due_date: gisteren, client: { id: 'c1', naam: 'Achterstand BV', vertrouwelijk: false, actief: true, team_id: null } }),
      task({ id: 't-straks', due_date: overEenWeek, client: { id: 'c2', naam: 'Op tijd BV', vertrouwelijk: false, actief: true, team_id: null } }),
    ])
    render(<WerkstroomPage ingang={btw} />)

    await screen.findByRole('heading', { name: 'Te laat' })
    const koppen = screen.getAllByRole('heading', { level: 2 })
    // De achterstand staat vooraan, en de rest in een eigen blok erna.
    expect(koppen[0]).toHaveTextContent('Te laat')
    expect(koppen.length).toBeGreaterThan(1)
    // De blokkop noemt de maand mét jaartal en niets meer: de exacte dag staat
    // per regel in de kolom Deadline en hoort niet dubbel in de kop.
    expect(koppen[1].textContent).toBe(maandKop)
    expect(screen.getByText('Achterstand BV')).toBeInTheDocument()
    expect(screen.getByText('Op tijd BV')).toBeInTheDocument()
  })

  it('zegt het wanneer er in dit venster niets te doen valt', async () => {
    install([])
    render(<WerkstroomPage ingang={btw} />)

    expect(await screen.findByText(/Geen btw-taken in dit venster/)).toBeInTheDocument()
  })

  // De doorklikbare status kwam er eerst alleen op Werklijst, Mijn taken en
  // Escalatie: TaskBlocks gaf de twee props niet door, dus juist de schermen
  // waar het kantoor dagelijks werkt bleven achter. Zonder deze test is dat
  // gat onzichtbaar -- de statuskolom staat er dan gewoon, alleen als label.
  it('maakt de status ook hier doorklikbaar naar de volgende stap', async () => {
    install([task({ status: 'open' })])
    render(<WerkstroomPage ingang={btw} />)

    const knop = await screen.findByRole('button', { name: /Status Open .* volgende stap/i })
    expect(knop).toBeInTheDocument()
  })
})
