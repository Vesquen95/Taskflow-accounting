import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdhocTaskFormModal } from './AdhocTaskFormModal'
import { getControlByLabelText } from '../test/formHelpers'
import type { Employee } from '../types'

// NOTE: this component's <label> elements are not programmatically
// associated with their <input>/<select> (no htmlFor/id, no wrapping) —
// see src/test/formHelpers.ts and the tester's report ("accessibility:
// unassociated form labels") for the bug writeup. Tests below use the
// getControlByLabelText workaround rather than the standard (and here
// broken) screen.getByLabelText.

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

const employees = [employee({ id: 'e1', naam: 'Jan Janssens' }), employee({ id: 'e2', naam: 'Els Peeters' })]

const onClose = vi.fn()
const onSubmit = vi.fn()

beforeEach(() => {
  onClose.mockReset()
  onSubmit.mockReset()
  onSubmit.mockResolvedValue(undefined)
})

describe('AdhocTaskFormModal — validation (§2.7: ad-hoc requires a free title)', () => {
  it('the title input has the native required attribute (blocks empty submission before JS runs)', () => {
    const { container } = render(
      <AdhocTaskFormModal employees={employees} defaultAssigneeId="e1" onClose={onClose} onSubmit={onSubmit} />
    )
    expect(getControlByLabelText(container, 'Titel *')).toBeRequired()
  })

  it('rejects a whitespace-only title (passes native "required" but fails the trim() check) with an error', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <AdhocTaskFormModal employees={employees} defaultAssigneeId="e1" onClose={onClose} onSubmit={onSubmit} />
    )

    await user.type(getControlByLabelText(container, 'Titel *'), '   ')
    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Titel is verplicht.')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('requires an assignee to be chosen when the employee list is empty and no default is given', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <AdhocTaskFormModal employees={[]} defaultAssigneeId={null} onClose={onClose} onSubmit={onSubmit} />
    )

    await user.type(getControlByLabelText(container, 'Titel *'), 'Bel de klant')
    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Kies een verantwoordelijke.')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('AdhocTaskFormModal — defaults', () => {
  it('defaults the deadline input to today', () => {
    const { container } = render(
      <AdhocTaskFormModal employees={employees} defaultAssigneeId="e1" onClose={onClose} onSubmit={onSubmit} />
    )
    const dateInput = getControlByLabelText(container, 'Deadline') as HTMLInputElement
    expect(dateInput.value).toBe(new Date().toISOString().slice(0, 10))
  })

  it('defaults the assignee select to the given defaultAssigneeId', () => {
    const { container } = render(
      <AdhocTaskFormModal employees={employees} defaultAssigneeId="e2" onClose={onClose} onSubmit={onSubmit} />
    )
    const select = getControlByLabelText(container, 'Verantwoordelijke') as HTMLSelectElement
    expect(select.value).toBe('e2')
  })
})

describe('AdhocTaskFormModal — submit flow', () => {
  it('submits trimmed values, treats blank description as null, and closes on success', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <AdhocTaskFormModal employees={employees} defaultAssigneeId="e1" onClose={onClose} onSubmit={onSubmit} />
    )

    await user.type(getControlByLabelText(container, 'Titel *'), '  Bel de klant  ')
    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bel de klant', description: null, toegewezen_medewerker_id: 'e1' })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the returned error and keeps the modal open when onSubmit rejects', async () => {
    const user = userEvent.setup()
    onSubmit.mockRejectedValue(new Error('Aanmaken is mislukt.'))
    const { container } = render(
      <AdhocTaskFormModal employees={employees} defaultAssigneeId="e1" onClose={onClose} onSubmit={onSubmit} />
    )

    await user.type(getControlByLabelText(container, 'Titel *'), 'Bel de klant')
    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Aanmaken is mislukt.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('mentions that ad-hoc tasks never require goedkeuring/recurrence (informational copy stays accurate)', () => {
    render(<AdhocTaskFormModal employees={employees} defaultAssigneeId="e1" onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.getByText(/vereisen nooit goedkeuring/i)).toBeInTheDocument()
  })
})
