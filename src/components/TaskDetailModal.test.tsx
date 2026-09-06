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
    niveau: null,
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
    wacht_op_klant_sinds: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    client: { id: 'c1', naam: 'Client A', vertrouwelijk: false, actief: true, team_id: null },
    obligation_type: { id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' },
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
  const mock = createSupabaseMock({
    task_status_log: () => ({ data: [], error: null }),
    teams: () => ({ data: [], error: null }),
    employee_teams: () => ({ data: [], error: null }),
  })
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

/**
 * De knoppenlijst moet kloppen met wat de database toelaat
 * (enforce_task_instance_transition, migratie 0011). Die regel blijft
 * ongewijzigd — het scherm moet eerlijk zijn.
 *
 * Deze tests waren rood voor de fix: TaskDetailModal bood
 * "Ingediend/afgerond" aan vanuit open/in_uitvoering/wacht_op_klant zonder
 * naar vereist_goedkeuring te kijken, waardoor 204 van de 252 openstaande
 * taken een keuze toonden die de database weigert.
 */
describe('TaskDetailModal — geen keuzes die de database weigert (migratie 0011)', () => {
  const RECHTSTREEKS_AFRONDEN = /^(Ingediend\/afgerond|Afronden)$/i

  it.each(['open', 'in_uitvoering', 'wacht_op_klant'] as const)(
    'biedt vanuit %s géén rechtstreekse afronding aan op een taak die goedkeuring vereist (zonder goedkeuringsrecht)',
    async (status) => {
      mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: false }))
      render(
        <TaskDetailModal
          task={task({ status, vereist_goedkeuring: true })}
          employees={employees}
          onClose={onClose}
          onStatusChange={onStatusChange}
          onReassign={onReassign}
          onMarkReviewHandled={onMarkReviewHandled}
        />
      )

      await screen.findByText('BTW-aangifte')
      expect(screen.queryByRole('button', { name: RECHTSTREEKS_AFRONDEN })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Dien in voor goedkeuring' })).toBeInTheDocument()
    }
  )

  it('biedt rechtstreeks afronden wél aan op een taak zonder goedkeuringsvereiste', async () => {
    const user = userEvent.setup()
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: false }))
    render(
      <TaskDetailModal
        task={task({ status: 'in_uitvoering', vereist_goedkeuring: false })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )

    await user.click(await screen.findByRole('button', { name: RECHTSTREEKS_AFRONDEN }))
    expect(onStatusChange).toHaveBeenCalledTimes(1)
    expect(onStatusChange).toHaveBeenCalledWith('t1', 'ingediend_afgerond')
  })

  it('laat een medewerker zonder goedkeuringsrecht geen enkele vervolgstap zien op wacht_op_goedkeuring', async () => {
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
    for (const label of [
      'Goedkeuren',
      'Terugsturen (afkeuren)',
      'In uitvoering',
      'Wacht op klant',
      'Dien in voor goedkeuring',
    ]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: RECHTSTREEKS_AFRONDEN })).not.toBeInTheDocument()
    expect(screen.queryByText('Status wijzigen')).not.toBeInTheDocument()
    expect(screen.getByText(/Enkel medewerkers met goedkeuringsrecht/)).toBeInTheDocument()
  })
})

/** Afronden in één klik voor wie mag goedkeuren (PLAN §7 punt 3). */
describe('TaskDetailModal — afronden in één klik', () => {
  const AFRONDEN = /^Afronden/

  it('zet een goedkeuringsplichtige taak in twee stappen af: eerst indienen, dan goedkeuren', async () => {
    const user = userEvent.setup()
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: true }))
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

    await user.click(await screen.findByRole('button', { name: AFRONDEN }))

    expect(onStatusChange.mock.calls).toEqual([
      ['t1', 'wacht_op_goedkeuring'],
      ['t1', 'ingediend_afgerond'],
    ])
  })

  it('meldt de tussentoestand wanneer de goedkeuringsstap faalt na een geslaagde indiening', async () => {
    const user = userEvent.setup()
    mockEmployee.mockReturnValue(employee({ id: 'e1', mag_goedkeuren: true }))
    onStatusChange
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Alleen medewerkers met goedkeuringsrecht kunnen deze taak goedkeuren'))
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

    await user.click(await screen.findByRole('button', { name: AFRONDEN }))

    const melding = await screen.findByRole('alert')
    expect(melding).toHaveTextContent(/staat nu op "Wacht op goedkeuring"/i)
    expect(melding).toHaveTextContent(/goedkeuringsrecht/i)
    expect(onClose).not.toHaveBeenCalled()
  })
})

/**
 * Bevinding L — een deadline handmatig verzetten. De databank kan dit al
 * volledig (migratie 0013: due_date_handmatig_op, logregel
 * 'due_date_herberekend', due_date_wettelijk blijft onaangeroerd); enkel het
 * scherm bood het niet aan.
 */
describe('TaskDetailModal — deadline handmatig verzetten (bevinding L)', () => {
  const onDueDateChange = vi.fn()

  beforeEach(() => {
    onDueDateChange.mockReset()
    onDueDateChange.mockResolvedValue(undefined)
  })

  function toon(overrides: Partial<TaskInstanceWithRelations> = {}, metHandler = true) {
    mockEmployee.mockReturnValue(employee({ id: 'e1' }))
    render(
      <TaskDetailModal
        task={task({ status: 'open', ...overrides })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
        onDueDateChange={metHandler ? onDueDateChange : undefined}
      />
    )
  }

  it('stuurt enkel de nieuwe effectieve deadline door', async () => {
    const user = userEvent.setup()
    toon({ due_date: '2026-09-20', due_date_wettelijk: '2026-09-20' })

    const veld = await screen.findByLabelText(/Nieuwe deadline/i)
    expect(veld).toHaveValue('2026-09-20')
    await user.clear(veld)
    await user.type(veld, '2026-10-05')
    await user.click(screen.getByRole('button', { name: /Deadline verzetten/i }))

    expect(onDueDateChange).toHaveBeenCalledWith('t1', '2026-10-05')
  })

  it('houdt de wettelijke datum zichtbaar, zodat de afwijking te zien is', async () => {
    toon({ due_date: '2026-09-20', due_date_wettelijk: '2026-09-20' })

    expect(await screen.findByText(/wettelijke datum blijft 20 sep 2026/i)).toBeInTheDocument()
  })

  it('zegt bij een wettelijke verplichting dat dit een besluit is, met gevolgen', async () => {
    toon({ obligation_type: { id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' } })

    expect(await screen.findByText(/verschuift de wettelijke deadline niet/i)).toBeInTheDocument()
    expect(screen.getByText(/boete/i)).toBeInTheDocument()
  })

  it('waarschuwt scherper zodra de gekozen datum ná de wettelijke deadline ligt', async () => {
    const user = userEvent.setup()
    toon({ due_date: '2026-09-20', due_date_wettelijk: '2026-09-20' })

    const veld = await screen.findByLabelText(/Nieuwe deadline/i)
    expect(screen.queryByRole('alert', { name: /na de wettelijke deadline/i })).not.toBeInTheDocument()

    await user.clear(veld)
    await user.type(veld, '2026-10-05')

    const waarschuwing = await screen.findByRole('alert', { name: /na de wettelijke deadline/i })
    expect(waarschuwing).toHaveTextContent(/20 sep 2026/)
  })

  it('laat een service-taak met rust: geen wettelijke waarschuwing', async () => {
    const user = userEvent.setup()
    toon({
      due_date: '2026-09-20',
      due_date_wettelijk: '2026-09-20',
      vereist_goedkeuring: false,
      obligation_type: { id: 'ot9', code: 'rapportering', naam: 'Kwartaalrapport', categorie: 'service', werkstroom: 'rapportering' },
    })

    const veld = await screen.findByLabelText(/Nieuwe deadline/i)
    await user.clear(veld)
    await user.type(veld, '2026-10-05')

    expect(screen.queryByText(/boete/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert', { name: /na de wettelijke deadline/i })).not.toBeInTheDocument()
  })

  it('toont een reeds verzette deadline als afspraak, met de afwijking t.o.v. de wettelijke datum', async () => {
    toon({
      due_date: '2026-10-05',
      due_date_wettelijk: '2026-09-20',
      due_date_handmatig_op: '2026-08-29T10:00:00Z',
    })

    expect(await screen.findByText(/handmatig verzet/i)).toBeInTheDocument()
    expect(screen.getByText(/15 dagen na de wettelijke datum/i)).toBeInTheDocument()
  })

  it('biedt het verzetten niet aan op een afgesloten taak', async () => {
    toon({ status: 'ingediend_afgerond' })

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByLabelText(/Nieuwe deadline/i)).not.toBeInTheDocument()
  })

  it('biedt het verzetten niet aan wanneer het scherm geen handler meegeeft', async () => {
    toon({}, false)

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByLabelText(/Nieuwe deadline/i)).not.toBeInTheDocument()
  })

  it('toont de weigering van de databank in plaats van te doen alsof het lukte', async () => {
    const user = userEvent.setup()
    onDueDateChange.mockRejectedValueOnce(
      new Error('Wijziging van de deadline vereist een ingelogde, gekoppelde medewerker')
    )
    toon({ due_date: '2026-09-20', due_date_wettelijk: '2026-09-20' })

    const veld = await screen.findByLabelText(/Nieuwe deadline/i)
    await user.clear(veld)
    await user.type(veld, '2026-10-05')
    await user.click(screen.getByRole('button', { name: /Deadline verzetten/i }))

    expect(await screen.findByText(/ingelogde, gekoppelde medewerker/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})


describe('TaskDetailModal — de bak van het team', () => {
  function toonTaak(overrides: Partial<TaskInstanceWithRelations> = {}) {
    mockEmployee.mockReturnValue(employee({ id: 'e1', naam: 'Jan Janssens' }))
    render(
      <TaskDetailModal
        task={task({ status: 'open', ...overrides })}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )
  }

  it('biedt "Ik neem dit op" aan zodra de taak nog van niemand is', async () => {
    // Jezelf opzoeken in een keuzelijst is de omweg; dit is de handeling
    // waarvoor je het scherm opent.
    const user = userEvent.setup()
    toonTaak({ toegewezen_medewerker_id: null, toegewezen_medewerker: null })

    await user.click(await screen.findByRole('button', { name: 'Ik neem dit op' }))

    expect(onReassign).toHaveBeenCalledWith('t1', 'e1')
  })

  it('toont die knop niet wanneer de taak al iemand heeft', async () => {
    toonTaak({ toegewezen_medewerker_id: 'e2' })

    await screen.findByText('BTW-aangifte')
    expect(screen.queryByRole('button', { name: 'Ik neem dit op' })).not.toBeInTheDocument()
  })

  it('kan een taak teruggeven aan het team', async () => {
    // De lege stand is een echte keuze en geen ontbrekende waarde: werk dat je
    // niet afkrijgt hoort terug in de bak, niet op jouw naam te blijven staan.
    const user = userEvent.setup()
    toonTaak({ toegewezen_medewerker_id: 'e1' })

    await user.selectOptions(await screen.findByLabelText('Verantwoordelijke'), '')
    await user.click(screen.getByRole('button', { name: 'Herverdeel' }))

    expect(onReassign).toHaveBeenCalledWith('t1', null)
  })
})

describe('TaskDetailModal — welke voorafbetaling is dit?', () => {
  function vaTaak(nummer: number) {
    return task({
      periode_label: `VA${nummer}-2026`,
      obligation_type: {
        id: 'ot-va',
        code: 'va_venb',
        naam: 'Voorafbetaling VenB (VA1-VA4)',
        categorie: 'wettelijk',
        werkstroom: 'vennootschapsbelasting',
      },
    })
  }

  function toonVa(nummer: number) {
    mockEmployee.mockReturnValue(employee())
    return render(
      <TaskDetailModal
        task={vaTaak(nummer)}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )
  }

  it('zet het nummer in de titel in plaats van vier keer dezelfde naam', () => {
    toonVa(1)
    expect(screen.getByRole('heading', { name: 'Voorafbetaling VA1' })).toBeInTheDocument()
  })

  it('zegt hoeveel deze voorafbetaling waard is', () => {
    toonVa(1)
    expect(screen.getByText(/VA1 van 4 — boekjaar 2026/)).toBeInTheDocument()
    expect(screen.getByText(/weegt het zwaarst/i)).toBeInTheDocument()
  })

  it('zegt bij de laatste dat ze het lichtst weegt', () => {
    toonVa(4)
    expect(screen.getByRole('heading', { name: 'Voorafbetaling VA4' })).toBeInTheDocument()
    expect(screen.getByText(/de lichtste/i)).toBeInTheDocument()
  })

  it('laat het jaartal als periode staan, zonder het nummer te herhalen', () => {
    toonVa(2)
    const periode = screen.getByText('Periode').parentElement!
    expect(periode).toHaveTextContent('2026')
    expect(periode).not.toHaveTextContent('VA2-2026')
  })

  it('laat een gewone verplichting ongemoeid', () => {
    mockEmployee.mockReturnValue(employee())
    render(
      <TaskDetailModal
        task={task()}
        employees={employees}
        onClose={onClose}
        onStatusChange={onStatusChange}
        onReassign={onReassign}
        onMarkReviewHandled={onMarkReviewHandled}
      />
    )
    expect(screen.getByRole('heading', { name: 'BTW-aangifte' })).toBeInTheDocument()
    expect(screen.getByText('Periode').parentElement).toHaveTextContent('2026-Q2')
    expect(screen.queryByText(/van 4 — boekjaar/)).not.toBeInTheDocument()
  })
})
