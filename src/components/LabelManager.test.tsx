import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Label } from '../types'
import { LabelManager } from './LabelManager'

const labels: Label[] = [
  { id: 'l1', board_id: 'b1', name: 'Urgent', color: '#ef4444', created_at: '' },
  { id: 'l2', board_id: 'b1', name: 'Bug', color: '#3b82f6', created_at: '' },
]

describe('LabelManager', () => {
  it('creates a new label with the selected color', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue(undefined)

    render(<LabelManager labels={[]} onClose={vi.fn()} onCreate={onCreate} onUpdate={vi.fn()} onDelete={vi.fn()} />)

    await user.type(screen.getByLabelText('Naam van nieuw label'), 'Review')
    await user.click(screen.getByLabelText('Kleur #f97316'))
    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Review', '#f97316'))
  })

  it('caps the new-label and existing-label name inputs at the DB length limit (200 chars)', () => {
    render(
      <LabelManager labels={labels} onClose={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} />
    )

    expect(screen.getByLabelText('Naam van nieuw label')).toHaveAttribute('maxLength', '200')
    expect(screen.getByLabelText('Naam van label Urgent')).toHaveAttribute('maxLength', '200')
  })

  // Regression test for migration 0002's labels_color_hex check constraint:
  // even though the UI only offers preset swatch colors, a DB-level
  // rejection (e.g. a stale/invalid value) must surface through the
  // existing catch-and-display path rather than crash the component.
  it('shows a graceful error, not a crash, when the DB rejects an invalid hex color', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockRejectedValue(
      new Error('new row for relation "labels" violates check constraint "labels_color_hex"')
    )

    render(<LabelManager labels={[]} onClose={vi.fn()} onCreate={onCreate} onUpdate={vi.fn()} onDelete={vi.fn()} />)

    await user.type(screen.getByLabelText('Naam van nieuw label'), 'Review')
    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('labels_color_hex')
  })

  it('disables the add button while the name field is empty', () => {
    render(<LabelManager labels={[]} onClose={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Toevoegen' })).toBeDisabled()
  })

  it('shows an error message when creating a label fails', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockRejectedValue(new Error('Naam al in gebruik'))

    render(<LabelManager labels={[]} onClose={vi.fn()} onCreate={onCreate} onUpdate={vi.fn()} onDelete={vi.fn()} />)

    await user.type(screen.getByLabelText('Naam van nieuw label'), 'Review')
    await user.click(screen.getByRole('button', { name: 'Toevoegen' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Naam al in gebruik')
  })

  it('lists existing labels and shows an empty hint when there are none', () => {
    const { rerender } = render(
      <LabelManager labels={labels} onClose={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} />
    )
    expect(screen.getByLabelText('Naam van label Urgent')).toHaveValue('Urgent')
    expect(screen.getByLabelText('Naam van label Bug')).toHaveValue('Bug')

    rerender(<LabelManager labels={[]} onClose={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('Nog geen labels op dit bord.')).toBeInTheDocument()
  })

  it('renames a label when the name field is blurred with a new value', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn().mockResolvedValue(undefined)

    render(
      <LabelManager labels={labels} onClose={vi.fn()} onCreate={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()} />
    )

    const input = screen.getByLabelText('Naam van label Urgent')
    await user.clear(input)
    await user.type(input, 'Zeer urgent')
    await user.tab() // blur

    expect(onUpdate).toHaveBeenCalledWith('l1', { name: 'Zeer urgent' })
  })

  it('deletes a label when its delete button is clicked', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockResolvedValue(undefined)

    render(
      <LabelManager labels={labels} onClose={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={onDelete} />
    )

    await user.click(screen.getByLabelText('Verwijder label Urgent'))

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('l1'))
  })

  it('shows an error message when deleting a label fails', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockRejectedValue(new Error('Label wordt nog gebruikt'))

    render(
      <LabelManager labels={labels} onClose={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={onDelete} />
    )

    await user.click(screen.getByLabelText('Verwijder label Urgent'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Label wordt nog gebruikt')
  })
})
