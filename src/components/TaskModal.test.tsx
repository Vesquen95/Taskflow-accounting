import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Column, Label, Task } from '../types'
import { TaskModal } from './TaskModal'

const columns: Column[] = [
  { id: 'col-todo', board_id: 'b1', name: 'Todo', position: 0, created_at: '' },
  { id: 'col-doing', board_id: 'b1', name: 'In Progress', position: 1, created_at: '' },
]

const labels: Label[] = [
  { id: 'lbl-1', board_id: 'b1', name: 'Urgent', color: '#ef4444', created_at: '' },
  { id: 'lbl-2', board_id: 'b1', name: 'Bug', color: '#3b82f6', created_at: '' },
]

const existingTask: Task = {
  id: 'task-1',
  board_id: 'b1',
  column_id: 'col-todo',
  title: 'Bestaande taak',
  description: 'Beschrijving',
  due_date: null,
  position: 0,
  created_at: '',
  updated_at: '',
  labels: [labels[0]],
}

describe('TaskModal: create', () => {
  it('requires a title and does not call onCreate when empty', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskModal
        mode="create"
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={onCreate}
        onUpdate={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Titel is verplicht.')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only title', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskModal
        mode="create"
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={onCreate}
        onUpdate={vi.fn()}
      />
    )

    await user.type(screen.getByLabelText(/Titel/), '   ')
    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Titel is verplicht.')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('submits a trimmed title, description, due date and selected labels', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()

    render(
      <TaskModal
        mode="create"
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={onClose}
        onCreate={onCreate}
        onUpdate={vi.fn()}
      />
    )

    await user.type(screen.getByLabelText(/Titel/), '  Nieuwe taak  ')
    await user.type(screen.getByLabelText('Beschrijving'), 'Details')
    await user.click(screen.getByRole('checkbox', { name: /Urgent/ }))
    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate).toHaveBeenCalledWith({
      columnId: 'col-todo',
      title: 'Nieuwe taak',
      description: 'Details',
      dueDate: null,
      labelIds: ['lbl-1'],
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('caps title and description at the DB length limits (200 / 5000 chars)', () => {
    render(
      <TaskModal
        mode="create"
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
      />
    )

    expect(screen.getByLabelText(/Titel/)).toHaveAttribute('maxLength', '200')
    expect(screen.getByLabelText('Beschrijving')).toHaveAttribute('maxLength', '5000')
  })

  // Regression test for migration 0002's tasks_title_length check
  // constraint: if the DB still rejects a title (e.g. a pre-existing task
  // edited elsewhere, or a race with the maxLength cap), the existing
  // catch-and-display path in handleSubmit must show the message rather
  // than crash.
  it('shows a graceful error, not a crash, when the DB rejects the title as too long', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockRejectedValue(
      new Error('new row for relation "tasks" violates check constraint "tasks_title_length"')
    )
    const onClose = vi.fn()

    render(
      <TaskModal
        mode="create"
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={onClose}
        onCreate={onCreate}
        onUpdate={vi.fn()}
      />
    )

    await user.type(screen.getByLabelText(/Titel/), 'Taak')
    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('tasks_title_length')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows an error message and keeps the modal open when onCreate rejects', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockRejectedValue(new Error('Server weigert dit'))
    const onClose = vi.fn()

    render(
      <TaskModal
        mode="create"
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={onClose}
        onCreate={onCreate}
        onUpdate={vi.fn()}
      />
    )

    await user.type(screen.getByLabelText(/Titel/), 'Taak')
    await user.click(screen.getByRole('button', { name: 'Aanmaken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Server weigert dit')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('TaskModal: edit', () => {
  it('pre-fills fields from the existing task', () => {
    render(
      <TaskModal
        mode="edit"
        task={existingTask}
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
      />
    )

    expect(screen.getByLabelText(/Titel/)).toHaveValue('Bestaande taak')
    expect(screen.getByLabelText('Beschrijving')).toHaveValue('Beschrijving')
    expect(screen.getByRole('checkbox', { name: /Urgent/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Bug/ })).not.toBeChecked()
  })

  it('calls onUpdate with edited fields', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()

    render(
      <TaskModal
        mode="edit"
        task={existingTask}
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={onClose}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
      />
    )

    const titleInput = screen.getByLabelText(/Titel/)
    await user.clear(titleInput)
    await user.type(titleInput, 'Aangepaste titel')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(onUpdate).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ title: 'Aangepaste titel' })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onMove before onUpdate when the column changes', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    const onMove = vi.fn().mockImplementation(async () => {
      calls.push('move')
    })
    const onUpdate = vi.fn().mockImplementation(async () => {
      calls.push('update')
    })

    render(
      <TaskModal
        mode="edit"
        task={existingTask}
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
        onMove={onMove}
      />
    )

    await user.selectOptions(screen.getByLabelText('Kolom'), 'col-doing')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(onMove).toHaveBeenCalledWith('task-1', 'col-doing')
    expect(calls).toEqual(['move', 'update'])
  })

  it('requires a two-step confirmation before deleting', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()

    render(
      <TaskModal
        mode="edit"
        task={existingTask}
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={onClose}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={onDelete}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Verwijderen' }))
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByText('Weet je het zeker?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Ja, verwijderen' }))

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('task-1'))
    expect(onClose).toHaveBeenCalled()
  })

  it('cancelling the delete confirmation does not delete', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskModal
        mode="edit"
        task={existingTask}
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={onDelete}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Verwijderen' }))
    // Two "Annuleren" buttons exist once the confirm row is showing (the
    // delete-confirm cancel, and the modal's own cancel) — the confirm one
    // is the first in document order.
    const cancelButtons = screen.getAllByRole('button', { name: 'Annuleren' })
    await user.click(cancelButtons[0])

    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByText('Weet je het zeker?')).not.toBeInTheDocument()
    // Back to the initial "Verwijderen" trigger button.
    expect(screen.getByRole('button', { name: 'Verwijderen' })).toBeInTheDocument()
  })

  it('shows an error and stays open when delete fails', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockRejectedValue(new Error('Verwijderen mislukt op server'))
    const onClose = vi.fn()

    render(
      <TaskModal
        mode="edit"
        task={existingTask}
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={onClose}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={onDelete}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Verwijderen' }))
    await user.click(screen.getByRole('button', { name: 'Ja, verwijderen' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Verwijderen mislukt op server')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows a hint instead of a label list when there are no labels yet', () => {
    render(
      <TaskModal
        mode="edit"
        task={{ ...existingTask, labels: [] }}
        columns={columns}
        labels={[]}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
      />
    )

    expect(screen.getByText(/Nog geen labels/)).toBeInTheDocument()
  })
})

describe('TaskModal: labels UI', () => {
  it('toggles label selection on click without submitting', async () => {
    const user = userEvent.setup()

    render(
      <TaskModal
        mode="create"
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
      />
    )

    const urgentCheckbox = screen.getByRole('checkbox', { name: /Urgent/ })
    expect(urgentCheckbox).not.toBeChecked()
    await user.click(urgentCheckbox)
    expect(urgentCheckbox).toBeChecked()
    await user.click(urgentCheckbox)
    expect(urgentCheckbox).not.toBeChecked()
  })

  it('renders every provided label as a fieldset option', () => {
    render(
      <TaskModal
        mode="create"
        columns={columns}
        labels={labels}
        defaultColumnId="col-todo"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    const fieldset = screen.getByRole('group', { name: 'Labels' })
    expect(within(fieldset).getAllByRole('checkbox')).toHaveLength(labels.length)
  })
})
