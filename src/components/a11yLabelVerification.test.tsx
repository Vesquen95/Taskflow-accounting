import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdhocTaskFormModal } from './AdhocTaskFormModal'
import { ClientFormModal } from './ClientFormModal'
import { ClientObligationFormModal } from './ClientObligationFormModal'
import type { Employee } from '../types'

// Regression coverage for the a11y label-association fix (htmlFor/id on
// AdhocTaskFormModal, ClientFormModal, ClientObligationFormModal). Uses the
// STANDARD screen.getByLabelText (the same resolution real assistive tech
// relies on) instead of the getControlByLabelText workaround from
// src/test/formHelpers.ts, so a regression back to unassociated labels
// would fail loudly here rather than being silently absorbed by the
// workaround. NOTE: src/test/formHelpers.ts and the existing
// *FormModal.test.tsx files still use/document the workaround and should be
// updated to use screen.getByLabelText directly and have their now-stale
// "label is not associated" comments removed — see tester report.

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
    render(<ClientFormModal client={null} employees={[employee()]} onClose={vi.fn()} onSubmit={vi.fn()} />)
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
