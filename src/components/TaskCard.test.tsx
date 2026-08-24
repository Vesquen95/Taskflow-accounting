import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Column, Task } from '../types'
import { TaskCard } from './TaskCard'

// TaskCard uses @dnd-kit/sortable's useSortable, which needs a DndContext
// ancestor in a "real" tree, but works standalone in tests too since we
// only exercise the non-drag ("verplaats naar…" select) interaction path.

const columns: Column[] = [
  { id: 'col-todo', board_id: 'b1', name: 'Todo', position: 0, created_at: '' },
  { id: 'col-doing', board_id: 'b1', name: 'In Progress', position: 1, created_at: '' },
  { id: 'col-done', board_id: 'b1', name: 'Done', position: 2, created_at: '' },
]

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    board_id: 'b1',
    column_id: 'col-todo',
    title: 'Mijn taak',
    description: null,
    due_date: null,
    position: 0,
    created_at: '',
    updated_at: '',
    labels: [],
    ...overrides,
  }
}

describe('TaskCard', () => {
  it('opens the task when its title is clicked', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<TaskCard task={makeTask()} columns={columns} onOpen={onOpen} onMoveTo={vi.fn()} />)

    await user.click(screen.getByText('Mijn taak'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('moves the task via the "verplaats naar…" select fallback (no drag needed)', async () => {
    const user = userEvent.setup()
    const onMoveTo = vi.fn()
    const task = makeTask({ id: 'task-1', column_id: 'col-todo' })
    render(<TaskCard task={task} columns={columns} onOpen={vi.fn()} onMoveTo={onMoveTo} />)

    const select = screen.getByLabelText(new RegExp(`Verplaats .${task.title}. naar kolom`))
    await user.selectOptions(select, 'col-done')

    expect(onMoveTo).toHaveBeenCalledTimes(1)
    expect(onMoveTo).toHaveBeenCalledWith('col-done')
  })

  it('lists every column (including the current one) as a move option', () => {
    render(<TaskCard task={makeTask()} columns={columns} onOpen={vi.fn()} onMoveTo={vi.fn()} />)
    const select = screen.getByLabelText(/Verplaats/) as HTMLSelectElement
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toEqual(['col-todo', 'col-doing', 'col-done'])
    expect(select.value).toBe('col-todo')
  })

  it('renders each assigned label', () => {
    const task = makeTask({
      labels: [
        { id: 'l1', board_id: 'b1', name: 'Urgent', color: '#ef4444', created_at: '' },
        { id: 'l2', board_id: 'b1', name: 'Bug', color: '#3b82f6', created_at: '' },
      ],
    })
    render(<TaskCard task={task} columns={columns} onOpen={vi.fn()} onMoveTo={vi.fn()} />)
    expect(screen.getByText('Urgent')).toBeInTheDocument()
    expect(screen.getByText('Bug')).toBeInTheDocument()
  })

  it('shows no due-status badge when the task has no due date', () => {
    render(<TaskCard task={makeTask({ due_date: null })} columns={columns} onOpen={vi.fn()} onMoveTo={vi.fn()} />)
    expect(screen.queryByText(/Te laat/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Vandaag/)).not.toBeInTheDocument()
  })

  it('shows an "overdue" badge for a past due date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T12:00:00'))
    render(
      <TaskCard task={makeTask({ due_date: '2026-08-20' })} columns={columns} onOpen={vi.fn()} onMoveTo={vi.fn()} />
    )
    expect(screen.getByText(/Te laat/)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('shows a "today" badge when the due date is today', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T12:00:00'))
    render(
      <TaskCard task={makeTask({ due_date: '2026-08-24' })} columns={columns} onOpen={vi.fn()} onMoveTo={vi.fn()} />
    )
    expect(screen.getByText(/Vandaag/)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('shows the description when present but not when absent', () => {
    const { rerender } = render(
      <TaskCard task={makeTask({ description: 'Extra info' })} columns={columns} onOpen={vi.fn()} onMoveTo={vi.fn()} />
    )
    expect(screen.getByText('Extra info')).toBeInTheDocument()

    rerender(<TaskCard task={makeTask({ description: null })} columns={columns} onOpen={vi.fn()} onMoveTo={vi.fn()} />)
    expect(screen.queryByText('Extra info')).not.toBeInTheDocument()
  })
})
