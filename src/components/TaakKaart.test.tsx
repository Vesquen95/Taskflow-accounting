import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TaakKaart } from './TaakKaart'
import type { Employee, TaskInstanceWithRelations } from '../types'

const medewerker: Employee = {
  id: 'e1',
  firm_id: 'f1',
  auth_user_id: 'auth-1',
  naam: 'Jan',
  email: 'jan@rsm.be',
  rol: 'medewerker',
  niveau: null,
  mag_goedkeuren: false,
  actief: true,
  created_at: '2026-01-01T00:00:00Z',
}

function taak(overrides: Partial<TaskInstanceWithRelations> = {}): TaskInstanceWithRelations {
  return {
    id: 't1',
    client_id: 'c1',
    obligation_type_id: 'ot-btw',
    client_obligation_id: null,
    periode_label: '2026-Q3',
    periode_start: null,
    periode_eind: null,
    due_date: '2026-10-26',
    due_date_wettelijk: '2026-10-25',
    due_date_verschoven: true,
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
    wacht_op_klant_sinds: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    client: { id: 'c1', naam: 'Klant A', vertrouwelijk: false, actief: true, team_id: null },
    obligation_type: { id: 'ot-btw', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', werkstroom: 'btw' },
    toegewezen_medewerker: { id: 'e1', naam: 'Jan' },
    ...overrides,
  }
}

describe('TaakKaart', () => {
  it('zet klant, taak en deadline onder elkaar in plaats van in zeven kolommen', () => {
    render(<ul><TaakKaart task={taak()} onOpen={vi.fn()} /></ul>)

    expect(screen.getByText('Klant A')).toBeInTheDocument()
    expect(screen.getByText(/BTW-aangifte/)).toBeInTheDocument()
    expect(screen.getByText(/2026-Q3/)).toBeInTheDocument()
    // De verantwoordelijke hoort erbij: op een gedeeld kantoor is "is dit van
    // mij" de tweede vraag na "welke klant".
    expect(screen.getByText(/Jan/)).toBeInTheDocument()
  })

  it('opent de taak bij een tik op de kaart', async () => {
    const onOpen = vi.fn()
    render(<ul><TaakKaart task={taak()} onOpen={onOpen} /></ul>)

    await userEvent.click(screen.getByText('Klant A'))

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0].id).toBe('t1')
  })

  it('maakt de status aantikbaar zonder de kaart te openen', async () => {
    // Dit is het tweede waarvoor het telefoonscherm bestaat: een taak
    // onderweg op "in uitvoering" zetten.
    const onOpen = vi.fn()
    const onStatusChange = vi.fn().mockResolvedValue(undefined)
    render(
      <ul>
        <TaakKaart
          task={taak()}
          onOpen={onOpen}
          currentEmployee={medewerker}
          onStatusChange={onStatusChange}
        />
      </ul>
    )

    await userEvent.click(screen.getByRole('button', { name: /Status Open .* volgende stap/i }))

    expect(onStatusChange).toHaveBeenCalledWith('t1', 'in_uitvoering')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('zet de statusknop naast de kaartknop en niet erin', () => {
    // Een knop in een knop is ongeldige HTML: dan wordt het toeval welke van
    // de twee een tik opvangt, en juist op een telefoon zit je er sneller naast.
    const { container } = render(
      <ul>
        <TaakKaart
          task={taak()}
          onOpen={vi.fn()}
          currentEmployee={medewerker}
          onStatusChange={vi.fn().mockResolvedValue(undefined)}
        />
      </ul>
    )

    expect(container.querySelector('button button')).toBeNull()
  })

  it('toont het slotje bij een vertrouwelijke klant', () => {
    render(
      <ul>
        <TaakKaart
          task={taak({ client: { id: 'c1', naam: 'Stil BV', vertrouwelijk: true, actief: true, team_id: null } })}
          onOpen={vi.fn()}
        />
      </ul>
    )
    expect(screen.getByLabelText('Vertrouwelijk')).toBeInTheDocument()
  })
})
