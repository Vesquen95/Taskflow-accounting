import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState } from '../test/supabaseMock'
import { GoedkeuringPage } from './GoedkeuringPage'
import type { TaskInstanceWithRelations } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

const ingelogd = {
  id: 'e1',
  firm_id: 'f1',
  auth_user_id: 'auth-1',
  naam: 'Wibren',
  email: 'wibren@rsm.be',
  rol: 'medewerker',
  niveau: 'partner',
  mag_goedkeuren: true,
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
    obligation_type_id: 'ot1',
    client_obligation_id: null,
    periode_label: '2025',
    periode_start: null,
    periode_eind: null,
    due_date: '2026-03-31',
    due_date_wettelijk: '2026-03-31',
    due_date_verschoven: false,
    due_date_handmatig_op: null,
    status: 'wacht_op_goedkeuring',
    toegewezen_medewerker_id: 'e2',
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
    client: { id: 'c1', naam: 'Pattyn Diepvries', vertrouwelijk: false, actief: true, team_id: null },
    obligation_type: { id: 'ot1', code: 'aangifte_venb', naam: 'Aangifte VenB', categorie: 'wettelijk', werkstroom: 'vennootschapsbelasting' },
    toegewezen_medewerker: { id: 'e2', naam: 'Leen' },
    ...overrides,
  }
}

const taskCalls: ChainState[] = []

function install(taken: TaskInstanceWithRelations[]) {
  const mock = createSupabaseMock({
    employees: () => ({ data: [{ id: 'e1', naam: 'Wibren' }, { id: 'e2', naam: 'Leen' }], error: null }),
    teams: () => ({
      data: [{ id: 't-zav1', firm_id: 'f1', code: 'ZAV1', naam: 'Zaventem 1', vestiging: 'Zaventem', actief: true, created_at: '2026-01-01T00:00:00Z' }],
      error: null,
    }),
    employee_teams: () => ({ data: [], error: null }),
    task_instances: (state) => {
      taskCalls.push(state)
      return { data: taken, error: null }
    },
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
  return mock
}

function argsVan(state: ChainState, method: string, veld: string): unknown[] | undefined {
  return state.calls.find((c) => c.method === method && c.args[0] === veld)?.args
}

beforeEach(() => {
  vi.clearAllMocks()
  taskCalls.length = 0
})

describe('GoedkeuringPage', () => {
  it('vraagt alleen de taken op die op goedkeuring wachten', async () => {
    install([task()])
    render(<GoedkeuringPage />)

    await waitFor(() => expect(taskCalls.length).toBeGreaterThan(0))
    expect(argsVan(taskCalls[0], 'in', 'status')).toEqual(['status', ['wacht_op_goedkeuring']])
  })

  it('zet geen deadlinevenster — een aangifte die sinds maart wacht hoort hier in september nog te staan', async () => {
    // Rood voor de fix: met het venster van een werkstroom (deze maand) viel
    // precies het oudste werk uit beeld, en dat is het werk waar dit scherm
    // voor bestaat.
    install([task()])
    render(<GoedkeuringPage />)

    await waitFor(() => expect(taskCalls.length).toBeGreaterThan(0))
    expect(argsVan(taskCalls[0], 'lte', 'due_date')).toBeUndefined()
    expect(argsVan(taskCalls[0], 'gte', 'due_date')).toBeUndefined()
  })

  it('toont wat collega\'s indienden', async () => {
    install([task()])
    render(<GoedkeuringPage />)

    expect(await screen.findByText('Pattyn Diepvries')).toBeInTheDocument()
    expect(screen.getByText(/Ingediend door collega's/)).toBeInTheDocument()
  })

  it('zet je eigen taken apart, met de four-eyes-waarschuwing erboven', async () => {
    // De waarschuwing staat boven de lijst en niet pas in het detailvenster:
    // wie in bulk goedkeurt, opent geen enkele taak en zou ze anders nooit zien.
    install([
      task(),
      task({
        id: 't2',
        toegewezen_medewerker_id: 'e1',
        toegewezen_medewerker: { id: 'e1', naam: 'Wibren' },
        client: { id: 'c2', naam: 'Eigen Dossier bv', vertrouwelijk: false, actief: true, team_id: null },
      }),
    ])
    render(<GoedkeuringPage />)

    expect(await screen.findByText('Door jou ingediend')).toBeInTheDocument()
    expect(screen.getByText(/four-eyes-principe is dan niet gerespecteerd/i)).toBeInTheDocument()
  })

  it('zwijgt over four-eyes wanneer er niets van jezelf tussen staat', async () => {
    install([task()])
    render(<GoedkeuringPage />)

    await screen.findByText('Pattyn Diepvries')
    expect(screen.queryByText('Door jou ingediend')).not.toBeInTheDocument()
    expect(screen.queryByText(/four-eyes/i)).not.toBeInTheDocument()
  })

  it('zegt het gewoon wanneer er niets wacht', async () => {
    install([])
    render(<GoedkeuringPage />)

    expect(await screen.findByText('Er wacht niets op je goedkeuring.')).toBeInTheDocument()
  })
})
