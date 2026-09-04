import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState } from '../test/supabaseMock'
import { KalenderPage } from './KalenderPage'
import type { TaskInstanceWithRelations } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({ employee: null, loading: false, error: null }),
}))

/** Vandaag als ISO-datum, los van de implementatie berekend. */
function vandaagIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function task(i: number, dueDate: string): TaskInstanceWithRelations {
  return {
    id: `t${i}`,
    client_id: 'c1',
    obligation_type_id: 'ot1',
    client_obligation_id: null,
    periode_label: '2029-Q1',
    periode_start: null,
    periode_eind: null,
    due_date: dueDate,
    due_date_wettelijk: dueDate,
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
    wacht_op_klant_sinds: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    client: { id: 'c1', naam: `Klant ${i}`, vertrouwelijk: false, actief: true, team_id: null },
    obligation_type: { id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' },
    toegewezen_medewerker: { id: 'e1', naam: 'Jan' },
  }
}

/** 50 taken in dezelfde maand: precies één volle pagina. */
const pagina1 = Array.from({ length: 50 }, (_, i) =>
  task(i + 1, `2029-03-${String((i % 28) + 1).padStart(2, '0')}`)
)

const lijstQueries: ChainState[] = []
const tellingQueries: ChainState[] = []

function isTelling(state: ChainState) {
  const opties = state.calls.find((c) => c.method === 'select')?.args[1] as { head?: boolean } | undefined
  return opties?.head === true
}

function install({ totaal = 247, achterstand = 12 }: { totaal?: number; achterstand?: number } = {}) {
  const mock = createSupabaseMock({
    employees: () => ({ data: [{ id: 'e1', naam: 'Jan' }], error: null }),
    task_instances: (state) => {
      if (isTelling(state)) {
        tellingQueries.push(state)
        return { data: null, error: null, count: achterstand }
      }
      lijstQueries.push(state)
      return { data: pagina1, error: null, count: totaal }
    },
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
}

beforeEach(() => {
  vi.clearAllMocks()
  lijstQueries.length = 0
  tellingQueries.length = 0
})

describe('KalenderPage — serverside paginering (bevinding M-2)', () => {
  it('vraagt ten hoogste 50 taken op, en haalt dus niet de hele horizon binnen', async () => {
    install()
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    expect(lijstQueries).toHaveLength(1)
    expect(lijstQueries[0].calls).toContainEqual({ method: 'range', args: [0, 49] })
  })

  it('toont het exacte totaal, niet het aantal opgehaalde rijen', async () => {
    install({ totaal: 247 })
    render(<KalenderPage />)

    expect(await screen.findByText(/Taken 1–50 van 247/)).toBeInTheDocument()
    expect(screen.getByText(/Pagina 1 van 5/)).toBeInTheDocument()
  })

  it('bladert serverside naar de volgende schijf', async () => {
    const user = userEvent.setup()
    install({ totaal: 247 })
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    await user.click(screen.getByRole('button', { name: /Volgende/ }))

    await waitFor(() => expect(lijstQueries).toHaveLength(2))
    expect(lijstQueries[1].calls).toContainEqual({ method: 'range', args: [50, 99] })
    expect(await screen.findByText(/Taken 51–100 van 247/)).toBeInTheDocument()
  })

  it('een maandblok dat over de paginagrens valt telt enkel wat op deze pagina staat', async () => {
    install({ totaal: 247 })
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    expect(screen.getByText('50 taken op deze pagina')).toBeInTheDocument()
  })

  it('op één enkele pagina telt het maandblok gewoon zijn taken', async () => {
    install({ totaal: 50 })
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    expect(screen.getByText('50 taken')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Volgende/ })).not.toBeInTheDocument()
  })
})

describe('KalenderPage — de te late taken uit het verleden', () => {
  it('meldt in de kop hoeveel taken te laat zijn', async () => {
    install({ achterstand: 12 })
    render(<KalenderPage />)

    expect(await screen.findByText(/12 taken te laat/)).toBeInTheDocument()
  })

  it('begint bij vandaag: het vinkje staat aan en de query heeft een ondergrens', async () => {
    // Met honderd dossiers loopt de achterstand maanden terug. Wie binnenkomt
    // op de oudste maand moet eerst pagina's vooruit klikken voor hij ziet wat
    // er deze week moet.
    install()
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    expect(screen.getByRole('checkbox', { name: /te late taken/i })).toBeChecked()
    expect(lijstQueries[0].calls).toContainEqual({ method: 'gte', args: ['due_date', vandaagIso()] })
  })

  it('zegt meteen hoeveel er verborgen is, met één klik terug', async () => {
    // Verbergen mag, stil verbergen niet: de balk staat er vanaf het eerste
    // scherm, niet pas nadat je zelf iets aanvinkt.
    install({ achterstand: 12 })
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    const melding = await screen.findByRole('status', { name: /verborgen achterstand/i })
    expect(within(melding).getByText(/12 te late taken verborgen/)).toBeInTheDocument()
  })

  it('haalt de achterstand er weer bij zodra je het vinkje uitzet', async () => {
    const user = userEvent.setup()
    install({ achterstand: 12 })
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    await user.click(screen.getByRole('checkbox', { name: /te late taken/i }))

    await waitFor(() => expect(lijstQueries).toHaveLength(2))
    // Geen ondergrens meer: de achterstand zit gewoon in de lijst.
    expect(lijstQueries[1].calls.some((c) => c.method === 'gte')).toBe(false)
    expect(screen.queryByRole('status', { name: /verborgen achterstand/i })).toBeNull()
  })

  it('zet het bladeren terug op pagina 1 wanneer het vinkje verandert', async () => {
    const user = userEvent.setup()
    install({ totaal: 247 })
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    await user.click(screen.getByRole('button', { name: /Volgende/ }))
    await waitFor(() => expect(lijstQueries).toHaveLength(2))

    await user.click(screen.getByRole('checkbox', { name: /te late taken/i }))
    await waitFor(() => expect(lijstQueries).toHaveLength(3))
    expect(lijstQueries[2].calls).toContainEqual({ method: 'range', args: [0, 49] })
  })

  it('telt de achterstand met een aparte kop-telling, ook als ze verborgen is', async () => {
    install({ achterstand: 12 })
    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    expect(tellingQueries).toHaveLength(1)
    expect(tellingQueries[0].calls).toContainEqual({ method: 'lt', args: ['due_date', vandaagIso()] })
  })
})

describe('KalenderPage — de lijst krimpt onder je voeten', () => {
  it('springt terug naar pagina 1 in plaats van een lege pagina zonder uitweg te tonen', async () => {
    const user = userEvent.setup()
    const mock = createSupabaseMock({
      employees: () => ({ data: [{ id: 'e1', naam: 'Jan' }], error: null }),
      task_instances: (state) => {
        if (isTelling(state)) return { data: null, error: null, count: 0 }
        lijstQueries.push(state)
        const range = state.calls.find((c) => c.method === 'range')?.args as [number, number] | undefined
        // Pagina 2 is intussen leeg: de taken zijn afgewerkt.
        if (range && range[0] > 0) return { data: [], error: null, count: 50 }
        return { data: pagina1, error: null, count: 247 }
      },
    })
    ;(supabase.from as Mock).mockImplementation(mock.from)

    render(<KalenderPage />)
    await screen.findByText('Klant 1')

    await user.click(screen.getByRole('button', { name: /Volgende/ }))

    await waitFor(() => expect(lijstQueries).toHaveLength(3))
    expect(lijstQueries[2].calls).toContainEqual({ method: 'range', args: [0, 49] })
    expect(await screen.findByText('Klant 1')).toBeInTheDocument()
  })
})
