import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTable } from './TaskTable'
import type { Employee, TaskInstanceWithRelations } from '../types'
import { stelSchermIn } from '../test/kleinScherm'

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
    client: { id: 'c1', naam: 'Client A', vertrouwelijk: false, actief: true, team_id: null },
    obligation_type: { id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' },
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
        tasks={[task({ client: { id: 'c1', naam: 'Secret Co', vertrouwelijk: true, actief: true, team_id: null } })]}
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
    const onBulkStatus = vi.fn().mockResolvedValue({ gelukt: ['t1', 't2'], mislukt: [] })
    render(<TaskTable tasks={[task({ id: 't1' }), task({ id: 't2' })]} employees={employees} onOpenTask={onOpenTask} onBulkStatus={onBulkStatus} />)

    const headerCheckbox = screen.getByLabelText('Selecteer alle taken')
    await user.click(headerCheckbox)
    expect(screen.getByText('2 geselecteerd')).toBeInTheDocument()

    await user.click(headerCheckbox)
    expect(screen.queryByText(/geselecteerd/)).not.toBeInTheDocument()
  })

  it('clicking a row checkbox selects only that row and does not trigger onOpenTask (stopPropagation)', async () => {
    const user = userEvent.setup()
    const onBulkStatus = vi.fn().mockResolvedValue({ gelukt: ['t1'], mislukt: [] })
    render(<TaskTable tasks={[task({ id: 't1', title: 'Taak 1', obligation_type: null, obligation_type_id: null })]} employees={employees} onOpenTask={onOpenTask} onBulkStatus={onBulkStatus} />)

    await user.click(screen.getByLabelText('Selecteer taak Taak 1'))

    expect(screen.getByText('1 geselecteerd')).toBeInTheDocument()
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  it('bulk-reassigns the selected rows and clears the selection afterwards', async () => {
    const user = userEvent.setup()
    const onBulkReassign = vi.fn().mockResolvedValue({ gelukt: ['t1', 't2'], mislukt: [] })
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
    const onBulkStatus = vi.fn().mockResolvedValue({ gelukt: ['t1'], mislukt: [] })
    render(<TaskTable tasks={[task({ id: 't1' })]} employees={employees} onOpenTask={onOpenTask} onBulkStatus={onBulkStatus} />)

    await user.click(screen.getByLabelText('Selecteer alle taken'))
    const toolbar = screen.getByText('1 geselecteerd').closest('div')!
    await user.selectOptions(within(toolbar).getByLabelText('Zet status op'), 'geannuleerd')

    expect(onBulkStatus).toHaveBeenCalledWith(['t1'], 'geannuleerd')
  })
})

/**
 * Status doorklikken: één klik op de statusknop zet de taak naar de volgende
 * stap in de keten, met exact dezelfde regels als in het detailvenster —
 * beide halen ze hun keuzes uit src/lib/taskStatus.ts, dat de databaseregel
 * (migratie 0011) spiegelt.
 *
 * Rood voor de fix: de status was een dood label, er was geen doorklik.
 */
describe('TaskTable — status doorklikken', () => {
  const onStatusChange = vi.fn()

  beforeEach(() => {
    onStatusChange.mockReset()
    onStatusChange.mockResolvedValue(undefined)
  })

  function renderTable(t: TaskInstanceWithRelations, emp: Employee = employee({ mag_goedkeuren: false })) {
    return render(
      <TaskTable
        tasks={[t]}
        employees={employees}
        onOpenTask={onOpenTask}
        currentEmployee={emp}
        onStatusChange={onStatusChange}
      />
    )
  }

  it('zet een open taak in één klik naar In uitvoering, zonder het detailvenster te openen', async () => {
    const user = userEvent.setup()
    renderTable(task({ status: 'open' }))

    await user.click(screen.getByRole('button', { name: /volgende stap: In uitvoering/i }))

    expect(onStatusChange).toHaveBeenCalledWith('t1', 'in_uitvoering')
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  it('loopt voor een wettelijke taak via wacht op goedkeuring in plaats van rechtstreeks af te ronden', async () => {
    const user = userEvent.setup()
    renderTable(task({ status: 'in_uitvoering', vereist_goedkeuring: true }))

    await user.click(screen.getByRole('button', { name: /volgende stap: Dien in voor goedkeuring/i }))
    // Deze ene stap vraagt eerst een bevestiging: zie de checklistherinnering
    // hieronder. De andere overgangen blijven één klik.
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Dien in voor goedkeuring' })
    )

    expect(onStatusChange).toHaveBeenCalledWith('t1', 'wacht_op_goedkeuring')
  })

  // Het kantoor werkt met checklists per categorie. Taskflow beheert die niet,
  // maar het moment waarop ze vergeten worden is wél te vatten: bij het
  // doorsturen, want dan geef je het dossier uit handen.
  it('herinnert aan de checklist voor het dossier uit handen gaat', async () => {
    const user = userEvent.setup()
    renderTable(task({ status: 'in_uitvoering', vereist_goedkeuring: true }))

    await user.click(screen.getByRole('button', { name: /volgende stap: Dien in voor goedkeuring/i }))

    expect(screen.getByRole('dialog')).toHaveTextContent(/checklist/i)
    // Nog niets doorgestuurd zolang je niet bevestigt.
    expect(onStatusChange).not.toHaveBeenCalled()
  })

  it('stuurt niets door wanneer je de bevestiging annuleert', async () => {
    const user = userEvent.setup()
    renderTable(task({ status: 'in_uitvoering', vereist_goedkeuring: true }))

    await user.click(screen.getByRole('button', { name: /volgende stap: Dien in voor goedkeuring/i }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annuleren' }))

    expect(onStatusChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('vraagt geen bevestiging voor een stap die niet langs goedkeuring gaat', async () => {
    // Anders wordt elke doorklik een dialoog, en dat is precies wat het
    // kantoor niet wilde toen de status doorklikbaar werd.
    const user = userEvent.setup()
    renderTable(task({ status: 'open', vereist_goedkeuring: true }))

    await user.click(screen.getByRole('button', { name: /volgende stap: In uitvoering/i }))

    expect(onStatusChange).toHaveBeenCalledWith('t1', 'in_uitvoering')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rondt een servicetaak zonder goedkeuringsvereiste rechtstreeks af', async () => {
    const user = userEvent.setup()
    renderTable(
      task({
        status: 'in_uitvoering',
        vereist_goedkeuring: false,
        obligation_type: { id: 'ot2', code: 'rapportering', naam: 'Managementrapport', categorie: 'service', werkstroom: 'rapportering' },
      })
    )

    await user.click(screen.getByRole('button', { name: /volgende stap: Afronden/i }))

    expect(onStatusChange).toHaveBeenCalledWith('t1', 'ingediend_afgerond')
  })

  it('laat een taak in wacht_op_goedkeuring goedkeuren door wie het recht heeft', async () => {
    const user = userEvent.setup()
    renderTable(task({ status: 'wacht_op_goedkeuring' }), employee({ mag_goedkeuren: true }))

    await user.click(screen.getByRole('button', { name: /volgende stap: Goedkeuren/i }))

    expect(onStatusChange).toHaveBeenCalledWith('t1', 'ingediend_afgerond')
  })

  it('biedt geen doorklik aan op wacht_op_goedkeuring zonder goedkeuringsrecht, maar zegt waarom', () => {
    renderTable(task({ status: 'wacht_op_goedkeuring' }), employee({ mag_goedkeuren: false }))

    expect(screen.queryByRole('button', { name: /volgende stap/i })).not.toBeInTheDocument()
    expect(screen.getByTitle(/goedkeuringsrecht/i)).toBeInTheDocument()
  })

  it('biedt geen doorklik aan op een afgesloten taak', () => {
    renderTable(task({ status: 'ingediend_afgerond' }))
    expect(screen.queryByRole('button', { name: /volgende stap/i })).not.toBeInTheDocument()
  })

  it('houdt de status een gewoon label zolang er geen statushandler is meegegeven', () => {
    render(<TaskTable tasks={[task({ status: 'open' })]} employees={employees} onOpenTask={onOpenTask} />)
    expect(screen.queryByRole('button', { name: /volgende stap/i })).not.toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
  })

  it('toont een foutmelding wanneer de databank de stap weigert', async () => {
    const user = userEvent.setup()
    onStatusChange.mockRejectedValue(new Error('Taak met status open is afgesloten'))
    renderTable(task({ status: 'open' }))

    await user.click(screen.getByRole('button', { name: /volgende stap/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/afgesloten/i)
  })
})

/** Een badge die op elke regel staat, meldt niets. "Later" verdwijnt dus. */
describe('TaskTable — urgentiebadge alleen wanneer ze iets meldt', () => {
  function overDagen(dagen: number): string {
    const d = new Date()
    d.setDate(d.getDate() + dagen)
    return d.toISOString().slice(0, 10)
  }

  it('toont geen "Later"-badge op een taak die nog ver weg is', () => {
    render(<TaskTable tasks={[task({ due_date: overDagen(90) })]} employees={employees} onOpenTask={onOpenTask} />)
    expect(screen.queryByText('Later')).not.toBeInTheDocument()
  })

  it('toont de badge wel wanneer de deadline dichtbij is', () => {
    render(<TaskTable tasks={[task({ due_date: overDagen(1) })]} employees={employees} onOpenTask={onOpenTask} />)
    expect(screen.getByText('Deze week')).toBeInTheDocument()
  })
})

/**
 * Bulk "Zet status op": even eerlijk als de doorklikbare status. De balk mag
 * alleen aanbieden wat op élke geselecteerde taak kan — één statement dat de
 * trigger op één rij afbreekt, past niets toe — en moet achteraf per taak
 * melden wat er wél en niet gebeurd is.
 *
 * Rood voor de fix: de balk bood vast in_uitvoering/wacht_op_klant/
 * geannuleerd aan, ongeacht de selectie, en toonde geen verslag.
 */
describe('TaskTable — bulkstatus: alleen wat op alle geselecteerde taken kan', () => {
  const onBulkStatus = vi.fn()

  beforeEach(() => {
    onBulkStatus.mockReset()
    onBulkStatus.mockResolvedValue({ gelukt: [], mislukt: [] })
  })

  function renderBulk(tasks: TaskInstanceWithRelations[], emp: Employee = employee({ mag_goedkeuren: false })) {
    return render(
      <TaskTable
        tasks={tasks}
        employees={employees}
        onOpenTask={onOpenTask}
        onBulkStatus={onBulkStatus}
        currentEmployee={emp}
      />
    )
  }

  function statusKeuzes(): string[] {
    const select = screen.getByLabelText('Zet status op') as HTMLSelectElement
    return Array.from(select.options)
      .map((o) => o.value)
      .filter((v) => v !== '')
  }

  it('biedt "Wacht op klant" niet aan wanneer één geselecteerde taak daar al op staat', async () => {
    const user = userEvent.setup()
    renderBulk([task({ id: 't1', status: 'open' }), task({ id: 't2', status: 'wacht_op_klant' })])

    await user.click(screen.getByLabelText('Selecteer alle taken'))

    expect(statusKeuzes()).toEqual(['in_uitvoering', 'geannuleerd'])
  })

  it('biedt zonder goedkeuringsrecht geen "In uitvoering" aan bij een taak in wacht_op_goedkeuring', async () => {
    const user = userEvent.setup()
    renderBulk([task({ id: 't1', status: 'open' }), task({ id: 't2', status: 'wacht_op_goedkeuring' })])

    await user.click(screen.getByLabelText('Selecteer alle taken'))

    expect(statusKeuzes()).toEqual(['geannuleerd'])
  })

  it('herberekent de keuzes zodra de selectie verandert', async () => {
    const user = userEvent.setup()
    renderBulk([
      task({ id: 't1', status: 'open', title: 'Taak 1', obligation_type: null, obligation_type_id: null }),
      task({ id: 't2', status: 'wacht_op_klant', title: 'Taak 2', obligation_type: null, obligation_type_id: null }),
    ])

    await user.click(screen.getByLabelText('Selecteer taak Taak 1'))
    expect(statusKeuzes()).toContain('wacht_op_klant')

    await user.click(screen.getByLabelText('Selecteer taak Taak 2'))
    expect(statusKeuzes()).not.toContain('wacht_op_klant')
  })

  it('toont geen lege keuzelijst maar de reden wanneer er geen gezamenlijke status is', async () => {
    const user = userEvent.setup()
    renderBulk([task({ id: 't1', status: 'open' }), task({ id: 't2', status: 'ingediend_afgerond' })])

    await user.click(screen.getByLabelText('Selecteer alle taken'))

    expect(screen.queryByLabelText('Zet status op')).not.toBeInTheDocument()
    expect(screen.getByText(/afgesloten/i)).toBeInTheDocument()
  })
})

describe('TaskTable — bulkverslag per taak', () => {
  const onBulkStatus = vi.fn()

  beforeEach(() => {
    onBulkStatus.mockReset()
  })

  const takenVanTweeKlanten = [
    task({ id: 't1', status: 'open', client: { id: 'c1', naam: 'Bakkerij Peeters', vertrouwelijk: false, actief: true, team_id: null } }),
    task({ id: 't2', status: 'open', client: { id: 'c2', naam: 'Garage Willems', vertrouwelijk: false, actief: true, team_id: null } }),
  ]

  async function zetStatus(user: ReturnType<typeof userEvent.setup>, waarde: string) {
    await user.click(screen.getByLabelText('Selecteer alle taken'))
    await user.selectOptions(screen.getByLabelText('Zet status op'), waarde)
  }

  it('meldt na een gedeeltelijke mislukking per taak wat er gebeurde en waarom niet', async () => {
    const user = userEvent.setup()
    onBulkStatus.mockResolvedValue({
      gelukt: ['t1'],
      mislukt: [{ taskId: 't2', reden: 'Ongeldige statusovergang: open -> in_uitvoering' }],
    })
    render(
      <TaskTable
        tasks={takenVanTweeKlanten}
        employees={employees}
        onOpenTask={onOpenTask}
        onBulkStatus={onBulkStatus}
        currentEmployee={employee()}
      />
    )

    await zetStatus(user, 'in_uitvoering')

    const verslag = await screen.findByRole('alert')
    expect(within(verslag).getByText(/1 van de 2/)).toBeInTheDocument()
    expect(within(verslag).getByText(/Garage Willems/)).toBeInTheDocument()
    expect(within(verslag).getByText(/Ongeldige statusovergang/)).toBeInTheDocument()
    expect(within(verslag).queryByText(/Bakkerij Peeters/)).not.toBeInTheDocument()
  })

  it('houdt enkel de mislukte taken geselecteerd zodat het kantoor ze kan opvolgen', async () => {
    const user = userEvent.setup()
    onBulkStatus.mockResolvedValue({
      gelukt: ['t1'],
      mislukt: [{ taskId: 't2', reden: 'Geen rechten' }],
    })
    render(
      <TaskTable
        tasks={takenVanTweeKlanten}
        employees={employees}
        onOpenTask={onOpenTask}
        onBulkStatus={onBulkStatus}
        currentEmployee={employee()}
      />
    )

    await zetStatus(user, 'in_uitvoering')

    expect(await screen.findByText('1 geselecteerd')).toBeInTheDocument()
  })

  it('meldt kort dat alles gelukt is en maakt de selectie leeg', async () => {
    const user = userEvent.setup()
    onBulkStatus.mockResolvedValue({ gelukt: ['t1', 't2'], mislukt: [] })
    render(
      <TaskTable
        tasks={takenVanTweeKlanten}
        employees={employees}
        onOpenTask={onOpenTask}
        onBulkStatus={onBulkStatus}
        currentEmployee={employee()}
      />
    )

    await zetStatus(user, 'in_uitvoering')

    const verslag = await screen.findByRole('status')
    expect(within(verslag).getByText(/2 van de 2/)).toBeInTheDocument()
    expect(screen.queryByText(/geselecteerd/)).not.toBeInTheDocument()
  })

  it('meldt het ook wanneer de bulkopdracht zelf stukloopt in plaats van stil te falen', async () => {
    const user = userEvent.setup()
    onBulkStatus.mockRejectedValue(new Error('Geen verbinding met de server'))
    render(
      <TaskTable
        tasks={takenVanTweeKlanten}
        employees={employees}
        onOpenTask={onOpenTask}
        onBulkStatus={onBulkStatus}
        currentEmployee={employee()}
      />
    )

    await zetStatus(user, 'in_uitvoering')

    expect(await screen.findByRole('alert')).toHaveTextContent(/Geen verbinding/)
  })
})

describe('TaskTable op een telefoon', () => {
  let herstel: (() => void) | null = null

  beforeEach(() => {
    herstel = stelSchermIn(true)
  })
  afterEach(() => {
    herstel?.()
    herstel = null
  })

  it('vervangt de tabel door kaarten in plaats van zeven kolommen te laten schuiven', () => {
    render(
      <TaskTable
        tasks={[task({ id: 't1', client: { id: 'c1', naam: 'Klant A', vertrouwelijk: false, actief: true, team_id: null } })]}
        employees={employees}
        onOpenTask={onOpenTask}
      />
    )

    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByText('Klant A')).toBeInTheDocument()
  })

  it('toont elke taak precies één keer', () => {
    // De eerste opzet zette beide varianten in de DOM en verborg er één met
    // CSS. Een schermlezer las dan elke taak twee keer voor, en er bestonden
    // twee knoppen voor dezelfde status.
    render(
      <TaskTable
        tasks={[task({ id: 't1', client: { id: 'c1', naam: 'Klant A', vertrouwelijk: false, actief: true, team_id: null } })]}
        employees={employees}
        onOpenTask={onOpenTask}
        currentEmployee={employee()}
        onStatusChange={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getAllByText('Klant A')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Status Open/i })).toHaveLength(1)
  })

  it('biedt geen aanvinkvakjes of bulkacties aan', () => {
    // Bewust: onderweg zoek je op en verzet je een status. Aanvinken en in
    // bulk toewijzen is bureauwerk, en op een duim is het vooral misklikken.
    render(
      <TaskTable
        tasks={[task()]}
        employees={employees}
        onOpenTask={onOpenTask}
        onBulkReassign={vi.fn()}
        onBulkStatus={vi.fn()}
      />
    )

    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('houdt de tabel op een computer', () => {
    herstel?.()
    herstel = stelSchermIn(false)
    render(<TaskTable tasks={[task()]} employees={employees} onOpenTask={onOpenTask} />)

    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})

describe('TaskTable — hoelang een dossier al op de klant wacht', () => {
  function toon(t: TaskInstanceWithRelations) {
    return render(
      <TaskTable tasks={[t]} employees={employees} onOpenTask={vi.fn()} currentEmployee={null} />
    )
  }

  it('toont de wachttijd naast de status', () => {
    const sinds = new Date(Date.now() - 5 * 86400000).toISOString()
    toon(task({ status: 'wacht_op_klant', wacht_op_klant_sinds: sinds }))
    expect(screen.getByText(/wacht 5 dagen/i)).toBeInTheDocument()
  })

  it('zwijgt bij een taak die niet op de klant wacht', () => {
    // Geen streepje en geen lege badge: een taak die niet wacht heeft hier
    // niets te melden.
    toon(task({ status: 'open', wacht_op_klant_sinds: null }))
    expect(screen.queryByText(/wacht /i)).toBeNull()
  })

  it('zegt met een woord, niet alleen met een kleur, dat het lang duurt', () => {
    // Kleur mag nooit de enige drager van betekenis zijn: wie de amber tint
    // niet ziet, hoort het verschil toch te lezen.
    const kort = new Date(Date.now() - 5 * 86400000).toISOString()
    const lang = new Date(Date.now() - 40 * 86400000).toISOString()

    const { unmount } = toon(task({ status: 'wacht_op_klant', wacht_op_klant_sinds: kort }))
    expect(screen.getByText(/^wacht 5 dagen$/i)).toBeInTheDocument()
    unmount()

    toon(task({ status: 'wacht_op_klant', wacht_op_klant_sinds: lang }))
    expect(screen.getByText(/^wacht al 6 weken$/i)).toBeInTheDocument()
  })

  it('noemt de datum zelf in de tooltip — wie moet bellen wil weten sinds wanneer', () => {
    const sinds = '2026-03-10T09:00:00.000Z'
    toon(task({ status: 'wacht_op_klant', wacht_op_klant_sinds: sinds }))
    expect(screen.getByTitle(/sinds 10 maart 2026/i)).toBeInTheDocument()
  })
})

describe('TaskTable — de vier voorafbetalingen uit elkaar houden', () => {
  function va(nummer: number) {
    return task({
      id: `va${nummer}`,
      periode_label: `VA${nummer}-2026`,
      due_date: `2026-0${nummer}-10`,
      obligation_type: {
        id: 'ot-va',
        code: 'va_venb',
        naam: 'Voorafbetaling VenB (VA1-VA4)',
        categorie: 'wettelijk',
        werkstroom: 'boekhouding',
      },
    })
  }

  it('zet het nummer in de kolom Verplichting, waar het niet wegvalt', () => {
    // Vier taken met dezelfde naam en alleen een datum als verschil is
    // precies wat het kantoor niet kon lezen.
    render(
      <TaskTable tasks={[va(1), va(2), va(3), va(4)]} employees={employees} onOpenTask={onOpenTask} />
    )
    for (const n of [1, 2, 3, 4]) {
      expect(screen.getByText(`Voorafbetaling VA${n}`)).toBeInTheDocument()
    }
    expect(screen.queryByText('Voorafbetaling VenB (VA1-VA4)')).not.toBeInTheDocument()
  })

  it('houdt in de kolom Periode het jaartal over', () => {
    render(<TaskTable tasks={[va(3)]} employees={employees} onOpenTask={onOpenTask} />)
    const rij = screen.getByText('Voorafbetaling VA3').closest('tr')!
    expect(within(rij).getByText('2026')).toBeInTheDocument()
    expect(within(rij).queryByText('VA3-2026')).not.toBeInTheDocument()
  })

  it('doet hetzelfde op een telefoon', () => {
    const herstel = stelSchermIn(true)
    try {
      render(<TaskTable tasks={[va(2)]} employees={employees} onOpenTask={onOpenTask} />)
      expect(screen.getByText('Voorafbetaling VA2')).toBeInTheDocument()
    } finally {
      herstel()
    }
  })
})
