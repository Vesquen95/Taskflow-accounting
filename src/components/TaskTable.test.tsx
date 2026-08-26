import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTable } from './TaskTable'
import type { Employee, TaskInstanceWithRelations } from '../types'

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    firm_id: 'f1',
    auth_user_id: 'auth-1',
    naam: 'Jan Janssens',
    email: 'jan@firm.be',
    rol: 'medewerker',
    mag_goedkeuren: false,
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function task(overrides: Partial<TaskInstanceWithRelations> = {}): TaskInstanceWithRelations {
  return {
    id: 't1',
    client_id: 'c1',
    obligation_type_id: 'ot1',
    client_obligation_id: null,
    periode_label: '2026-Q2',
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
    client: { id: 'c1', naam: 'Client A', vertrouwelijk: false, actief: true },
    obligation_type: { id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk' },
    toegewezen_medewerker: { id: 'e1', naam: 'Jan Janssens' },
    ...overrides,
  }
}

const employees = [employee({ id: 'e1', naam: 'Jan Janssens' }), employee({ id: 'e2', naam: 'Els Peeters' })]
const onOpenTask = vi.fn()

beforeEach(() => {
  onOpenTask.mockReset()
})

describe('TaskTable — empty state', () => {
  it('shows the empty-state message instead of a table when there are no tasks', () => {
    render(<TaskTable tasks={[]} employees={employees} onOpenTask={onOpenTask} />)
    expect(screen.getByText('Geen taken gevonden voor deze filters.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('supports a custom empty message', () => {
    render(<TaskTable tasks={[]} employees={employees} onOpenTask={onOpenTask} emptyMessage="Geen escalaties." />)
    expect(screen.getByText('Geen escalaties.')).toBeInTheDocument()
  })
})

describe('TaskTable — row rendering', () => {
  it('opens the task detail on row click', async () => {
    const user = userEvent.setup()
    const t = task()
    render(<TaskTable tasks={[t]} employees={employees} onOpenTask={onOpenTask} />)

    await user.click(screen.getByText('BTW-aangifte'))
    expect(onOpenTask).toHaveBeenCalledWith(t)
  })

  it('shows a review badge on tasks flagged review_vereist', () => {
    render(<TaskTable tasks={[task({ review_vereist: true })]} employees={employees} onOpenTask={onOpenTask} />)
    expect(screen.getByText('review')).toBeInTheDocument()
  })

  it('shows a confidential-client lock icon for vertrouwelijke clients', () => {
    render(
      <TaskTable
        tasks={[task({ client: { id: 'c1', naam: 'Secret Co', vertrouwelijk: true, actief: true } })]}
        employees={employees}
        onOpenTask={onOpenTask}
      />
    )
    expect(screen.getByLabelText('Vertrouwelijk')).toBeInTheDocument()
  })

  it('shows a shift indicator when due_date_verschoven is true (weekend/holiday shift)', () => {
    render(<TaskTable tasks={[task({ due_date_verschoven: true })]} employees={employees} onOpenTask={onOpenTask} />)
    expect(screen.getByTitle('Verschoven t.o.v. de wettelijke datum door weekend/feestdag')).toBeInTheDocument()
  })

  it('renders an ad-hoc task by its title when there is no obligation_type', () => {
    render(
      <TaskTable
        tasks={[task({ obligation_type_id: null, obligation_type: null, title: 'Bel de klant' })]}
        employees={employees}
        onOpenTask={onOpenTask}
      />
    )
    expect(screen.getByText('Bel de klant')).toBeInTheDocument()
  })

  it('can hide the client column (e.g. within a single-client Klantdossier view)', () => {
    render(<TaskTable tasks={[task()]} employees={employees} onOpenTask={onOpenTask} showClientColumn={false} />)
    expect(screen.queryByText('Klant')).not.toBeInTheDocument()
    expect(screen.queryByText('Client A')).not.toBeInTheDocument()
  })
})

describe('TaskTable — bulk actions', () => {
  it('does not render selection checkboxes/bulk toolbar when neither bulk handler is provided', () => {
    render(<TaskTable tasks={[task()]} employees={employees} onOpenTask={onOpenTask} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('selects all/none via the header checkbox', async () => {
    const user = userEvent.setup()
    const onBulkStatus = vi.fn().mockResolvedValue(undefined)
    render(<TaskTable tasks={[task({ id: 't1' }), task({ id: 't2' })]} employees={employees} onOpenTask={onOpenTask} onBulkStatus={onBulkStatus} />)

    const headerCheckbox = screen.getByLabelText('Selecteer alle taken')
    await user.click(headerCheckbox)
    expect(screen.getByText('2 geselecteerd')).toBeInTheDocument()

    await user.click(headerCheckbox)
    expect(screen.queryByText(/geselecteerd/)).not.toBeInTheDocument()
  })

  it('clicking a row checkbox selects only that row and does not trigger onOpenTask (stopPropagation)', async () => {
    const user = userEvent.setup()
    const onBulkStatus = vi.fn().mockResolvedValue(undefined)
    render(<TaskTable tasks={[task({ id: 't1', title: 'Taak 1', obligation_type: null, obligation_type_id: null })]} employees={employees} onOpenTask={onOpenTask} onBulkStatus={onBulkStatus} />)

    await user.click(screen.getByLabelText('Selecteer taak Taak 1'))

    expect(screen.getByText('1 geselecteerd')).toBeInTheDocument()
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  it('bulk-reassigns the selected rows and clears the selection afterwards', async () => {
    const user = userEvent.setup()
    const onBulkReassign = vi.fn().mockResolvedValue(undefined)
    render(
      <TaskTable
        tasks={[task({ id: 't1' }), task({ id: 't2' })]}
        employees={employees}
        onOpenTask={onOpenTask}
        onBulkReassign={onBulkReassign}
      />
    )

    await user.click(screen.getByLabelText('Selecteer alle taken'))
    const toolbar = screen.getByText('2 geselecteerd').closest('div')!
    await user.selectOptions(within(toolbar).getByLabelText('Herverdeel naar'), 'e2')

    expect(onBulkReassign).toHaveBeenCalledWith(['t1', 't2'], 'e2')
    expect(screen.queryByText(/geselecteerd/)).not.toBeInTheDocument()
  })

  it('bulk-updates status for the selected rows', async () => {
    const user = userEvent.setup()
    const onBulkStatus = vi.fn().mockResolvedValue(undefined)
    render(<TaskTable tasks={[task({ id: 't1' })]} employees={employees} onOpenTask={onOpenTask} onBulkStatus={onBulkStatus} />)

    await user.click(screen.getByLabelText('Selecteer alle taken'))
    const toolbar = screen.getByText('1 geselecteerd').closest('div')!
    await user.selectOptions(within(toolbar).getByLabelText('Zet status op'), 'geannuleerd')

    expect(onBulkStatus).toHaveBeenCalledWith(['t1'], 'geannuleerd')
  })
})
