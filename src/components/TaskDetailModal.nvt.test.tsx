import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock } from '../test/supabaseMock'
import { TaskDetailModal } from './TaskDetailModal'
import type { Employee, TaskInstanceWithRelations } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({
    employee: {
      id: 'e1', firm_id: 'f1', auth_user_id: 'a1', naam: 'Jan', email: 'jan@rsm.be',
      rol: 'medewerker', niveau: 'senior', mag_goedkeuren: false, actief: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}))

const employees: Employee[] = [
  {
    id: 'e1', firm_id: 'f1', auth_user_id: 'a1', naam: 'Jan', email: 'jan@rsm.be',
    rol: 'medewerker', niveau: 'senior', mag_goedkeuren: false, actief: true,
    created_at: '2026-01-01T00:00:00Z',
  },
]

function task(over: Partial<TaskInstanceWithRelations> = {}): TaskInstanceWithRelations {
  return {
    id: 't1', client_id: 'c1', obligation_type_id: 'ot1', client_obligation_id: null,
    periode_label: '2026-Q1', periode_start: '2026-01-01', periode_eind: '2026-03-31',
    due_date: '2026-04-25', due_date_wettelijk: '2026-04-25', due_date_verschoven: false,
    due_date_handmatig_op: null, status: 'open', toegewezen_medewerker_id: 'e1',
    voorloper_taak_id: null, bron_type: 'automatisch_gegenereerd', voorlopige_datum: false,
    vereist_goedkeuring: true, goedgekeurd_door: null, goedgekeurd_op: null,
    review_vereist: false, review_reden: null, title: null, description: null,
    afgerond_op: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    wacht_op_klant_sinds: null,
    client: { id: 'c1', naam: 'Acme BV', vertrouwelijk: false, actief: true, team_id: null },
    obligation_type: {
      id: 'ot1', code: 'btw_aangifte', naam: 'Btw-aangifte', categorie: 'wettelijk',
      deadline_mechanisme: 'formule', standaard_periodiciteit: 'kwartaal', werkstroom: 'btw',
    },
    toegewezen_medewerker: { id: 'e1', naam: 'Jan' },
    ...over,
  } as TaskInstanceWithRelations
}

function toon(over: Partial<TaskInstanceWithRelations> = {}, metHandler = true) {
  ;(supabase.from as Mock).mockImplementation(
    createSupabaseMock({ task_status_log: () => ({ data: [], error: null }) }).from
  )
  const onNietVanToepassing = vi.fn(async () => {})
  render(
    <TaskDetailModal
      task={task(over)}
      employees={employees}
      onClose={vi.fn()}
      onStatusChange={vi.fn(async () => {})}
      onReassign={vi.fn(async () => {})}
      onMarkReviewHandled={vi.fn(async () => {})}
      onNietVanToepassing={metHandler ? onNietVanToepassing : undefined}
    />
  )
  return { onNietVanToepassing }
}

beforeEach(() => vi.clearAllMocks())

const KNOP = /Niet van toepassing voor deze periode/

describe('TaskDetailModal — niet van toepassing', () => {
  it('biedt het aan bij een terugkerende verplichting', async () => {
    toon()
    expect(await screen.findByRole('button', { name: KNOP })).toBeInTheDocument()
  })

  it('biedt het niet aan bij een losse taak zonder periode', async () => {
    // "Deze periode" bestaat niet voor een ad-hoc taak; die annuleer je.
    // Dezelfde grens die de databank trekt.
    toon({ obligation_type_id: null, periode_label: null, title: 'Los klusje',
           bron_type: 'handmatig_adhoc', vereist_goedkeuring: false })
    await screen.findByText('Acme BV')
    expect(screen.queryByRole('button', { name: KNOP })).toBeNull()
  })

  it('biedt het niet aan bij een taak die al afgesloten is', async () => {
    toon({ status: 'ingediend_afgerond' })
    await screen.findByText('Acme BV')
    expect(screen.queryByRole('button', { name: KNOP })).toBeNull()
  })

  it('vraagt eerst een reden en houdt de knop dicht tot die er is', async () => {
    // Een wettelijke taak die verdwijnt zonder waarom is precies het stille
    // gat waar dit systeem tegen gebouwd is.
    const user = userEvent.setup()
    const { onNietVanToepassing } = toon()
    await user.click(await screen.findByRole('button', { name: KNOP }))
    expect(screen.getByRole('button', { name: 'Markeren' })).toBeDisabled()
    expect(onNietVanToepassing).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(/Waarom was er deze periode niets/), 'Geen omzet')
    expect(screen.getByRole('button', { name: 'Markeren' })).toBeEnabled()
  })

  it('geeft de reden door', async () => {
    const user = userEvent.setup()
    const { onNietVanToepassing } = toon()
    await user.click(await screen.findByRole('button', { name: KNOP }))
    await user.type(screen.getByLabelText(/Waarom was er deze periode niets/), 'Geen omzet')
    await user.click(screen.getByRole('button', { name: 'Markeren' }))
    await waitFor(() => expect(onNietVanToepassing).toHaveBeenCalledWith('t1', 'Geen omzet'))
  })

  it('zegt erbij dat er niets ingediend wordt en dat ze niet terugkomt', async () => {
    const user = userEvent.setup()
    toon()
    await user.click(await screen.findByRole('button', { name: KNOP }))
    expect(screen.getByText(/zonder te beweren dat er iets ingediend is/)).toBeInTheDocument()
    expect(screen.getByText(/niet opnieuw aan/)).toBeInTheDocument()
  })

  it('blijft weg op een scherm dat de handeling niet meegeeft', async () => {
    toon({}, false)
    await screen.findByText('Acme BV')
    expect(screen.queryByRole('button', { name: KNOP })).toBeNull()
  })
})
