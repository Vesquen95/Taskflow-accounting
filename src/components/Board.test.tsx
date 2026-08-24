import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseHandlers } from '../test/supabaseMock'

// Same hoisting pattern as useBoardData.test.tsx: a mutable handler map the
// mocked Supabase client consults per table/operation.
const handlers = vi.hoisted(() => ({} as SupabaseHandlers))

vi.mock('../lib/supabase', async () => {
  const { createSupabaseMock: create, fakeSession: session } = await import('../test/supabaseMock')
  return {
    supabase: create(handlers, {
      getSession: async () => ({ data: { session: session() } }),
    }),
  }
})

import { AuthProvider } from '../hooks/useAuth'
import { Board } from './Board'

const BOARD = { id: 'board-1', user_id: 'user-1', name: 'My Board', created_at: '' }
const COLUMNS = [{ id: 'col-todo', board_id: 'board-1', name: 'Todo', position: 0, created_at: '' }]

function renderBoard() {
  return render(
    <AuthProvider>
      <Board />
    </AuthProvider>
  )
}

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key]
})

describe('Board: loading state', () => {
  it('shows a skeleton board while data is still loading', () => {
    // Never resolve, so the component stays in the loading state for the
    // duration of this assertion.
    handlers.boards = () => new Promise(() => {})

    const { container } = renderBoard()

    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
  })
})

describe('Board: error state', () => {
  it('shows the error message and a working retry button', async () => {
    const user = userEvent.setup()
    let attempt = 0
    handlers.boards = () => {
      attempt += 1
      if (attempt === 1) return { data: null, error: new Error('Netwerkfout: kon bord niet laden') }
      return { data: [BOARD], error: null }
    }
    handlers.columns = () => ({ data: COLUMNS, error: null })
    handlers.labels = () => ({ data: [], error: null })
    handlers.tasks = () => ({ data: [], error: null })
    handlers.task_labels = () => ({ data: [], error: null })

    renderBoard()

    expect(await screen.findByRole('alert')).toHaveTextContent('Netwerkfout: kon bord niet laden')

    await user.click(screen.getByRole('button', { name: 'Opnieuw proberen' }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(await screen.findByText('+ Taak toevoegen')).toBeInTheDocument()
  })
})

describe('Board: column name inputs enforce the DB length limit', () => {
  it('caps the new-column name input at 200 characters', async () => {
    const user = userEvent.setup()
    handlers.boards = () => ({ data: [BOARD], error: null })
    handlers.columns = () => ({ data: COLUMNS, error: null })
    handlers.labels = () => ({ data: [], error: null })
    handlers.tasks = () => ({ data: [], error: null })
    handlers.task_labels = () => ({ data: [], error: null })

    renderBoard()
    await user.click(await screen.findByRole('button', { name: '+ Kolom toevoegen' }))

    expect(screen.getByLabelText('Naam van nieuwe kolom')).toHaveAttribute('maxLength', '200')
  })

  it('caps the column rename input at 200 characters', async () => {
    const user = userEvent.setup()
    handlers.boards = () => ({ data: [BOARD], error: null })
    handlers.columns = () => ({ data: COLUMNS, error: null })
    handlers.labels = () => ({ data: [], error: null })
    handlers.tasks = () => ({ data: [], error: null })
    handlers.task_labels = () => ({ data: [], error: null })

    renderBoard()
    await user.click(await screen.findByRole('button', { name: /Todo/ }))

    expect(screen.getByLabelText('Kolomnaam')).toHaveAttribute('maxLength', '200')
  })
})

describe('Board: empty states', () => {
  it('shows an empty-columns prompt when the board has no columns yet', async () => {
    handlers.boards = () => ({ data: [BOARD], error: null })
    handlers.columns = () => ({ data: [], error: null })
    handlers.labels = () => ({ data: [], error: null })
    handlers.tasks = () => ({ data: [], error: null })
    handlers.task_labels = () => ({ data: [], error: null })

    renderBoard()

    expect(await screen.findByText('Nog geen kolommen')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Kolom toevoegen' })).toBeInTheDocument()
  })

  it('shows an empty-tasks hint inside a column that has no tasks', async () => {
    handlers.boards = () => ({ data: [BOARD], error: null })
    handlers.columns = () => ({ data: COLUMNS, error: null })
    handlers.labels = () => ({ data: [], error: null })
    handlers.tasks = () => ({ data: [], error: null })
    handlers.task_labels = () => ({ data: [], error: null })

    renderBoard()

    expect(await screen.findByText('Geen taken')).toBeInTheDocument()
  })
})
