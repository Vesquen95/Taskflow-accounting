import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdhocTaskFormModal } from './AdhocTaskFormModal'
import { ClientFormModal } from './ClientFormModal'
import { ClientObligationFormModal } from './ClientObligationFormModal'
import type { Employee, ObligationType } from '../types'

const obligationTypes: ObligationType[] = [
  {
    id: 'ot-av',
    code: 'algemene_vergadering',
    naam: 'Algemene vergadering',
    categorie: 'wettelijk',
    deadline_mechanisme: 'boekjaar_relatief',
    standaard_periodiciteit: 'jaarlijks',
  },
]

// Regression coverage for the a11y label-association fix (htmlFor/id on
// AdhocTaskFormModal, ClientFormModal, ClientObligationFormModal). Uses the
// STANDARD screen.getByLabelText (the same resolution real assistive tech
// relies on). The old getControlByLabelText workaround (src/test/
// formHelpers.ts) has since been removed and the *FormModal.test.tsx files
// converted to screen.getByLabelText directly, so a regression back to
// unassociated labels would now fail loudly across all of them, not just
// here.

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

describe('a11y label verification (no workaround)', () => {
  it('AdhocTaskFormModal: screen.getByLabelText("Titel *") finds the title input directly', () => {
    render(
      <AdhocTaskFormModal
        employees={[employee()]}
        defaultAssigneeId="e1"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    const titleInput = screen.getByLabelText('Titel *')
    expect(titleInput).toBeInstanceOf(HTMLInputElement)
    expect(titleInput).toBeRequired()
  })

  it('ClientFormModal: screen.getByLabelText("Naam *") finds the naam input directly', () => {
    render(<ClientFormModal client={null} employees={[employee()]} obligationTypes={obligationTypes} onClose={vi.fn()} onSubmit={vi.fn()} />)
    const naamInput = screen.getByLabelText('Naam *')
    expect(naamInput).toBeInstanceOf(HTMLInputElement)
  })

  it('ClientObligationFormModal: screen.getByLabelText("Type verplichting") finds the select directly', () => {
    render(
      <ClientObligationFormModal
        obligationTypes={[
          { id: 'ot1', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: null },
        ]}
        employees={[employee()]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    const typeSelect = screen.getByLabelText('Type verplichting')
    expect(typeSelect).toBeInstanceOf(HTMLSelectElement)
  })
})
