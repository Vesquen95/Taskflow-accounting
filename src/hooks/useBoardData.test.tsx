import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseHandlers } from '../test/supabaseMock'

// Shared, mutable handler map. vi.hoisted() makes this available inside the
// vi.mock() factory below even though vi.mock calls are hoisted above the
// rest of this file's top-level code.
const handlers = vi.hoisted(() => ({} as SupabaseHandlers))

vi.mock('../lib/supabase', async () => {
  const { createSupabaseMock: create, fakeSession: session } = await import('../test/supabaseMock')
  return {
    supabase: create(handlers, {
      getSession: async () => ({ data: { session: session() } }),
    }),
  }
})

// Import after the mock is registered.
import { AuthProvider } from './useAuth'
import { useBoardData } from './useBoardData'

const BOARD = { id: 'board-1', user_id: 'user-1', name: 'My Board', created_at: '2026-01-01T00:00:00Z' }
const COLUMNS = [
  { id: 'col-todo', board_id: 'board-1', name: 'Todo', position: 0, created_at: '2026-01-01T00:00:00Z' },
  { id: 'col-doing', board_id: 'board-1', name: 'In Progress', position: 1, created_at: '2026-01-01T00:00:00Z' },
]

function makeTask(overrides: Partial<{ id: string; column_id: string; position: number; title: string }> = {}) {
  return {
    id: overrides.id ?? 'task-1',
    board_id: 'board-1',
    column_id: overrides.column_id ?? 'col-todo',
    title: overrides.title ?? 'Task',
    description: null,
    due_date: null,
    position: overrides.position ?? 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function installDefaultHandlers(tasks: ReturnType<typeof makeTask>[], labels: unknown[] = []) {
  handlers.boards = () => ({ data: [BOARD], error: null })
  handlers.columns = () => ({ data: COLUMNS, error: null })
  handlers.labels = () => ({ data: labels, error: null })
  handlers.tasks = () => ({ data: tasks, error: null })
  handlers.task_labels = () => ({ data: [], error: null })
}

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key]
})

describe('useBoardData: loading', () => {
  it('loads board, columns, labels and tasks, then flips loading off', async () => {
    installDefaultHandlers([makeTask({ id: 't1' })])

    const { result } = renderHook(() => useBoardData(), { wrapper })

    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.board?.id).toBe('board-1')
    expect(result.current.columns).toHaveLength(2)
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].labels).toEqual([])
  })

  it('surfaces a Supabase error via the `error` field instead of throwing', async () => {
    handlers.boards = () => ({ data: null, error: new Error('network down') })

    const { result } = renderHook(() => useBoardData(), { wrapper })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('network down')
    expect(result.current.board).toBeNull()
  })
})

describe('useBoardData: task CRUD', () => {
  it('createTask adds the new task to state with its assigned labels', async () => {
    installDefaultHandlers([], [{ id: 'lbl-1', board_id: 'board-1', name: 'Urgent', color: '#ef4444', created_at: '' }])
    handlers.task_labels = (state) => {
      if (state.op === 'insert') return { data: null, error: null }
      return { data: [], error: null }
    }

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    handlers.tasks = () => ({
      data: makeTask({ id: 'task-new', column_id: 'col-todo', title: 'New task' }),
      error: null,
    })

    await act(async () => {
      await result.current.createTask({
        columnId: 'col-todo',
        title: 'New task',
        labelIds: ['lbl-1'],
      })
    })

    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].title).toBe('New task')
    expect(result.current.tasks[0].labels.map((l) => l.id)).toEqual(['lbl-1'])
  })

  it('updateTask patches title/description/dueDate and refreshes labels locally', async () => {
    const label = { id: 'lbl-1', board_id: 'board-1', name: 'Urgent', color: '#ef4444', created_at: '' }
    installDefaultHandlers([makeTask({ id: 't1', title: 'Old title' })], [label])

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    handlers.tasks = () => ({ data: null, error: null })
    handlers.task_labels = () => ({ data: null, error: null })

    await act(async () => {
      await result.current.updateTask('t1', { title: 'New title', labelIds: ['lbl-1'] })
    })

    const updated = result.current.tasks.find((t) => t.id === 't1')
    expect(updated?.title).toBe('New title')
    expect(updated?.labels.map((l) => l.id)).toEqual(['lbl-1'])
  })

  it('deleteTask removes the task from state on success', async () => {
    installDefaultHandlers([makeTask({ id: 't1' }), makeTask({ id: 't2' })])

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    handlers.tasks = () => ({ data: null, error: null })

    await act(async () => {
      await result.current.deleteTask('t1')
    })

    expect(result.current.tasks.map((t) => t.id)).toEqual(['t2'])
  })

  it('deleteTask throws and leaves state untouched when Supabase reports an error', async () => {
    installDefaultHandlers([makeTask({ id: 't1' })])

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    handlers.tasks = () => ({ data: null, error: new Error('delete failed') })

    await expect(
      act(async () => {
        await result.current.deleteTask('t1')
      })
    ).rejects.toThrow('delete failed')

    expect(result.current.tasks.map((t) => t.id)).toEqual(['t1'])
  })
})

describe('useBoardData: moveTask', () => {
  it('moves a task to a different column and recomputes positions in both columns (optimistic update)', async () => {
    const tasks = [
      makeTask({ id: 't1', column_id: 'col-todo', position: 0 }),
      makeTask({ id: 't2', column_id: 'col-todo', position: 1 }),
      makeTask({ id: 't3', column_id: 'col-todo', position: 2 }),
      makeTask({ id: 't4', column_id: 'col-doing', position: 0 }),
    ]
    installDefaultHandlers(tasks)

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    handlers.tasks = () => ({ data: null, error: null })

    await act(async () => {
      await result.current.moveTask('t2', 'col-doing', 0)
    })

    const byId = new Map(result.current.tasks.map((t) => [t.id, t]))
    // Destination column: t2 first, then the pre-existing t4.
    expect(byId.get('t2')).toMatchObject({ column_id: 'col-doing', position: 0 })
    expect(byId.get('t4')).toMatchObject({ column_id: 'col-doing', position: 1 })
    // Source column: t1 and t3 re-indexed with no gap left by t2.
    expect(byId.get('t1')).toMatchObject({ column_id: 'col-todo', position: 0 })
    expect(byId.get('t3')).toMatchObject({ column_id: 'col-todo', position: 1 })
  })

  it('reorders within the same column without duplicating or losing tasks', async () => {
    const tasks = [
      makeTask({ id: 't1', column_id: 'col-todo', position: 0 }),
      makeTask({ id: 't2', column_id: 'col-todo', position: 1 }),
      makeTask({ id: 't3', column_id: 'col-todo', position: 2 }),
    ]
    installDefaultHandlers(tasks)

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    handlers.tasks = () => ({ data: null, error: null })

    await act(async () => {
      await result.current.moveTask('t3', 'col-todo', 0)
    })

    const ordered = [...result.current.tasks]
      .filter((t) => t.column_id === 'col-todo')
      .sort((a, b) => a.position - b.position)
      .map((t) => t.id)
    expect(ordered).toEqual(['t3', 't1', 't2'])
    expect(result.current.tasks).toHaveLength(3)
  })

  // KNOWN BUG (see test report): moveTask's Promise.all over the position
  // updates never destructures/checks each result's `error` field the way
  // createTask/updateTask/deleteTask do — it only reacts if the request
  // itself throws. A real Supabase client never throws for a DB-level
  // error (e.g. RLS denial); it resolves with `{ data: null, error }`. So
  // today this rollback never happens and the failure is swallowed
  // silently. This test encodes the *intended* behavior (mirroring every
  // other mutator in this file) and will start passing once moveTask is
  // fixed to check `error` on each update result and throw/roll back.
  it('rolls back the optimistic update if persisting the new positions fails', async () => {
    const tasks = [
      makeTask({ id: 't1', column_id: 'col-todo', position: 0 }),
      makeTask({ id: 't2', column_id: 'col-doing', position: 0 }),
    ]
    installDefaultHandlers(tasks)

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    handlers.tasks = (state) => {
      if (state.op === 'update') return { data: null, error: new Error('move failed') }
      return { data: null, error: null }
    }

    await expect(
      act(async () => {
        await result.current.moveTask('t1', 'col-doing', 0)
      })
    ).rejects.toThrow('move failed')

    // State should be exactly what it was before the failed move.
    const byId = new Map(result.current.tasks.map((t) => [t.id, t]))
    expect(byId.get('t1')).toMatchObject({ column_id: 'col-todo', position: 0 })
    expect(byId.get('t2')).toMatchObject({ column_id: 'col-doing', position: 0 })
  })

  it('does nothing when the task id does not exist', async () => {
    const tasks = [makeTask({ id: 't1', column_id: 'col-todo', position: 0 })]
    installDefaultHandlers(tasks)

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.moveTask('does-not-exist', 'col-doing', 0)
    })

    expect(result.current.tasks).toEqual(tasks.map((t) => ({ ...t, labels: [] })))
  })
})

describe('useBoardData: labels', () => {
  it('createLabel adds the label to state', async () => {
    installDefaultHandlers([])

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    handlers.labels = () => ({
      data: { id: 'lbl-1', board_id: 'board-1', name: 'Urgent', color: '#ef4444', created_at: '' },
      error: null,
    })

    await act(async () => {
      await result.current.createLabel('Urgent', '#ef4444')
    })

    expect(result.current.labels).toHaveLength(1)
    expect(result.current.labels[0]).toMatchObject({ name: 'Urgent', color: '#ef4444' })
  })

  it('deleteLabel removes the label from state and from any tasks carrying it', async () => {
    const label = { id: 'lbl-1', board_id: 'board-1', name: 'Urgent', color: '#ef4444', created_at: '' }
    installDefaultHandlers([makeTask({ id: 't1' })], [label])
    handlers.task_labels = () => ({ data: [{ task_id: 't1', label }], error: null })

    const { result } = renderHook(() => useBoardData(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.tasks[0].labels).toHaveLength(1)

    handlers.labels = () => ({ data: null, error: null })

    await act(async () => {
      await result.current.deleteLabel('lbl-1')
    })

    expect(result.current.labels).toHaveLength(0)
    expect(result.current.tasks[0].labels).toHaveLength(0)
  })
})
