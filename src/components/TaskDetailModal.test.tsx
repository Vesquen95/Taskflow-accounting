import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { TaskDetailModal } from './TaskDetailModal'
import { supabase } from '../lib/supabase'
import { createSupabaseMock } from '../test/supabaseMock'
import type { Employee, TaskInstanceWithRelations } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

const mockEmployee = vi.fn()
vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({ employee: mockEmployee(), loading: false, error: null, reload: vi.fn() }),
}))

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
    status: 'wacht_op_goedkeuring',
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

const employees = [employee({ id: 'e1', naam: 'Jan Janssens' }), employee({ id: 'e2', naam: 'Els Peeters', mag_goedkeuren: true })]

const onClose = vi.fn()
const onStatusChange = vi.fn()
const onReassign = vi.fn()
const onMarkReviewHandled = vi.fn()

function installSupabase() {
  const mock = createSupabaseMock({ task_status_log: () => ({ data: [], error: null }) })
  ;(supabase.from as Mock).mockImplementation(mock.from)
}

beforeEach(() => {
  vi.clearAllMocks()
  onStatusChange.mockResolvedValue(undefined)
  onReassign.mockResolvedValue(undefined)
  onMarkReviewHandled.mockResolvedValue(undefined)
  installSupabase()
})

describe('TaskDetailModal — four-eyes warning (§5/§7 decision 3: allowed, but must warn)', () => {
  it('shows the four-eyes warning when the current employee is both assignee and (would-be) approver', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: true }))
    render(
      <TaskDetailModal
        task={task({ toegewezen_medewerker_id: 'e1', status: 'wacht_op_goedkeuring' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    expect(await screen.findByText(/four-eyes-principe niet gerespecteerd/i)).toBeInTheDocument()
  })

  it('does NOT show the four-eyes warning when the approver differs from the assignee', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e2', mag_goedkeuren: true }))
    render(
      <TaskDetailModal
        task={task({ toegewezen_medewerker_id: 'e1', status: 'wacht_op_goedkeuring' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByText(/four-eyes-principe niet gerespecteerd/i)).not.toBeInTheDocument()
  })

  it('does NOT show the four-eyes warning when the task is not in wacht_op_goedkeuring, even for the assignee', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: true }))
    render(
      <TaskDetailModal
        task={task({ toegewezen_medewerker_id: 'e1', status: 'in_uitvoering' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByText(/four-eyes-principe niet gerespecteerd/i)).not.toBeInTheDocument()
  })

  it('does NOT block the self-approval action — four-eyes is a warning, not a hard block (§7 decision 3)', async () => {
    const user = userEvent.setup()
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: true }))
    render(
      <TaskDetailModal
        task={task({ toegewezen_medewerker_id: 'e1', status: 'wacht_op_goedkeuring' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await screen.findByText(/four-eyes-principe niet gerespecteerd/i)
    await user.click(screen.getByRole('button', { name: 'Goedkeuren' }))
    expect(onStatusChange).toHaveBeenCalledWith('t1', 'ingediend_afgerond')
  })
})

describe('TaskDetailModal — approval gating (mag_goedkeuren, §5)', () => {
  it('hides Goedkeuren/Terugsturen and shows an explanatory note for an employee without mag_goedkeuren', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e2', mag_goedkeuren: false }))
    render(
      <TaskDetailModal
        task={task({ status: 'wacht_op_goedkeuring' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByRole('button', { name: 'Goedkeuren' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Terugsturen (afkeuren)' })).not.toBeInTheDocument()
    expect(screen.getByText(/Enkel medewerkers met goedkeuringsrecht/)).toBeInTheDocument()
    // Cancelling is still allowed regardless of approval rights.
    expect(screen.getByRole('button', { name: 'Geannuleerd' })).toBeInTheDocument()
  })

  it('shows Goedkeuren/Terugsturen for an employee with mag_goedkeuren', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e2', mag_goedkeuren: true }))
    render(
      <TaskDetailModal
        task={task({ status: 'wacht_op_goedkeuring' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    expect(await screen.findByRole('button', { name: 'Goedkeuren' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Terugsturen (afkeuren)' })).toBeInTheDocument()
  })

  it('never offers "Dien in voor goedkeuring" when the task does not require approval (vereist_goedkeuring=false)', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: true }))
    render(
      <TaskDetailModal
        task={task({ status: 'open', vereist_goedkeuring: false })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByRole('button', { name: 'Dien in voor goedkeuring' })).not.toBeInTheDocument()
  })

  it('offers "Dien in voor goedkeuring" from open when vereist_goedkeuring=true', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: false }))
    render(
      <TaskDetailModal
        task={task({ status: 'open', vereist_goedkeuring: true })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    expect(await screen.findByRole('button', { name: 'Dien in voor goedkeuring' })).toBeInTheDocument()
  })

  it('offers no further status transitions from a final status (ingediend_afgerond)', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: true }))
    render(
      <TaskDetailModal
        task={task({ status: 'ingediend_afgerond' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByText('Status wijzigen')).not.toBeInTheDocument()
  })
})

describe('TaskDetailModal — review_vereist (mid-year change, §3.3)', () => {
  it('shows the review banner and reason, and lets the user mark review handled', async () => {
    const user = userEvent.setup()
    mockEmployee.mockReturnValue(employee({ id: 'e1' }))
    render(
      <TaskDetailModal
        task={task({ review_vereist: true, review_reden: 'BTW-frequentie gewijzigd van kwartaal naar maand.' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    expect(await screen.findByText('Review vereist')).toBeInTheDocument()
    expect(screen.getByText('BTW-frequentie gewijzigd van kwartaal naar maand.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Markeer review als afgehandeld' }))
    expect(onMarkReviewHandled).toHaveBeenCalledWith('t1')
    expect(onClose).toHaveBeenCalled()
  })

  it('does not show the review banner/button when review_vereist is false', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e1' }))
    render(
      <TaskDetailModal
        task={task({ review_vereist: false })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByText('Review vereist')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Markeer review als afgehandeld' })).not.toBeInTheDocument()
  })
})

describe('TaskDetailModal — status change error handling', () => {
  it('shows an error and keeps the modal open when onStatusChange rejects', async () => {
    const user = userEvent.setup()
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: true }))
    onStatusChange.mockRejectedValue(new Error('Transitie niet toegestaan door databasetrigger.'))
    render(
      <TaskDetailModal
        task={task({ status: 'wacht_op_goedkeuring' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await user.click(await screen.findByRole('button', { name: 'Goedkeuren' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Transitie niet toegestaan door databasetrigger.')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('TaskDetailModal — deadline display', () => {
  it('shows the shifted-date note with the raw wettelijk date when due_date_verschoven', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e1' }))
    render(
      <TaskDetailModal
        task={task({ due_date: '2026-09-21', due_date_wettelijk: '2026-09-20', due_date_verschoven: true })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    expect(await screen.findByText(/verschoven door weekend\/feestdag/)).toBeInTheDocument()
  })

  it('shows a "voorlopige datum" note for a provisional date (e.g. neerlegging before AV completes)', async () => {
    mockEmployee.mockReturnValue(employee({ id: 'e1' }))
    render(
      <TaskDetailModal
        task={task({ voorlopige_datum: true })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    expect(await screen.findByText('(voorlopige datum)')).toBeInTheDocument()
  })
})

describe('TaskDetailModal — reassignment', () => {
  it('disables the Herverdeel button until a different assignee is chosen', async () => {
    const user = userEvent.setup()
    mockEmployee.mockReturnValue(employee({ id: 'e1' }))
    render(
      <TaskDetailModal
        task={task({ toegewezen_medewerker_id: 'e1' })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await screen.findByText('BTW-aangifte')
    expect(screen.getByRole('button', { name: 'Herverdeel' })).toBeDisabled()

    await user.selectOptions(screen.getByDisplayValue('Jan Janssens'), 'e2')
    expect(screen.getByRole('button', { name: 'Herverdeel' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Herverdeel' }))
    expect(onReassign).toHaveBeenCalledWith('t1', 'e2')
  })
})
