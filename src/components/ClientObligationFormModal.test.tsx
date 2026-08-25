import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientObligationFormModal } from './ClientObligationFormModal'
import { getControlByLabelText } from '../test/formHelpers'
import type { Employee, ObligationType } from '../types'

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

function obligationType(overrides: Partial<ObligationType> = {}): ObligationType {
  return {
    id: 'ot1',
    code: 'btw_aangifte',
    naam: 'BTW-aangifte',
    categorie: 'wettelijk',
    deadline_mechanisme: 'formule',
    standaard_periodiciteit: null,
    ...overrides,
  }
}

const obligationTypes = [
  obligationType({ id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte' }),
  obligationType({ id: 'ot2', code: 'rapportering', naam: 'Periodieke rapportering', categorie: 'service' }),
  obligationType({ id: 'ot3', code: 'jaarafsluiting', naam: 'Jaarafsluiting' }),
]

const employees = [employee({ id: 'e1', naam: 'Jan Janssens' }), employee({ id: 'e2', naam: 'Els Peeters' })]

const onClose = vi.fn()
const onSubmit = vi.fn()

beforeEach(() => {
  onClose.mockReset()
  onSubmit.mockReset()
  onSubmit.mockResolvedValue(undefined)
})

describe('ClientObligationFormModal — type-dependent parameters', () => {
  it('sends an empty parameters object for an obligation type with no configurable parameters (e.g. btw_aangifte)', async () => {
    const user = userEvent.setup()
    render(<ClientObligationFormModal obligationTypes={obligationTypes} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ obligation_type_id: 'ot1', parameters: {}, standaard_toegewezen_medewerker_id: null })
    )
  })

  it('shows and submits frequentie/termijn_dagen parameters for "rapportering"', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ClientObligationFormModal obligationTypes={obligationTypes} employees={employees} onClose={onClose} onSubmit={onSubmit} />
    )

    await user.selectOptions(getControlByLabelText(container, 'Type verplichting'), 'ot2')
    expect(screen.getByText('Frequentie')).toBeInTheDocument()

    await user.selectOptions(getControlByLabelText(container, 'Frequentie'), 'maand')
    const termijnInput = getControlByLabelText(container, 'Termijn (dagen na periode)') as HTMLInputElement
    await user.clear(termijnInput)
    await user.type(termijnInput, '15')

    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ obligation_type_id: 'ot2', parameters: { frequentie: 'maand', termijn_dagen: 15 } })
    )
  })

  it('shows and submits sla_maanden for "jaarafsluiting"', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ClientObligationFormModal obligationTypes={obligationTypes} employees={employees} onClose={onClose} onSubmit={onSubmit} />
    )

    await user.selectOptions(getControlByLabelText(container, 'Type verplichting'), 'ot3')
    const slaInput = getControlByLabelText(container, 'Kantoor-SLA (maanden na boekjaareinde)') as HTMLInputElement
    await user.clear(slaInput)
    await user.type(slaInput, '4')

    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ obligation_type_id: 'ot3', parameters: { sla_maanden: 4 } }))
  })

  it('does not show rapportering/jaarafsluiting fields for other obligation types', async () => {
    render(<ClientObligationFormModal obligationTypes={obligationTypes} employees={employees} onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.queryByText('Frequentie')).not.toBeInTheDocument()
    expect(screen.queryByText('Kantoor-SLA (maanden na boekjaareinde)')).not.toBeInTheDocument()
  })
})

describe('ClientObligationFormModal — assignee fallback (§2.6)', () => {
  it('submits null (falls back to the client default) when no assignee is chosen', async () => {
    const user = userEvent.setup()
    render(<ClientObligationFormModal obligationTypes={obligationTypes} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ standaard_toegewezen_medewerker_id: null }))
  })

  it('submits the chosen employee id when an assignee is picked', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ClientObligationFormModal obligationTypes={obligationTypes} employees={employees} onClose={onClose} onSubmit={onSubmit} />
    )

    await user.selectOptions(getControlByLabelText(container, 'Standaard toegewezen medewerker'), 'e2')
    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ standaard_toegewezen_medewerker_id: 'e2' }))
  })
})

describe('ClientObligationFormModal — validation & error handling', () => {
  it('shows an error and does not call onSubmit when no obligation types exist to choose from', async () => {
    const user = userEvent.setup()
    render(<ClientObligationFormModal obligationTypes={[]} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Kies een type verplichting.')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows the returned error and keeps the modal open when onSubmit rejects', async () => {
    const user = userEvent.setup()
    onSubmit.mockRejectedValue(new Error('Verplichting bestaat al voor deze klant.'))
    render(<ClientObligationFormModal obligationTypes={obligationTypes} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Verplichting bestaat al voor deze klant.')
    expect(onClose).not.toHaveBeenCalled()
  })
})
