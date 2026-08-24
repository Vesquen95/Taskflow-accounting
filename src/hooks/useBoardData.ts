import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Board, Column, Label, Task } from '../types'
import { useAuth } from './useAuth'

interface TaskLabelRow {
  task_id: string
  label: Label
}

export function useBoardData() {
  const { user } = useAuth()
  const [board, setBoard] = useState<Board | null>(null)
  const [columns, setColumns] = useState<Column[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [labels, setLabels] = useState<Label[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      // 1. Find (or create as a fallback) this user's board.
      let boardRow: Board | null = null
      const { data: boards, error: boardsErr } = await supabase
        .from('boards')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(1)

      if (boardsErr) throw boardsErr

      if (boards && boards.length > 0) {
        boardRow = boards[0] as Board
      } else {
        // Fallback: the on-signup trigger should normally create this,
        // but create one client-side if it's somehow missing.
        const { data: created, error: createErr } = await supabase
          .from('boards')
          .insert({ user_id: user.id, name: 'My Board' })
          .select()
          .single()
        if (createErr) throw createErr
        boardRow = created as Board

        const defaultColumns = ['Todo', 'In Progress', 'Done'].map((name, position) => ({
          board_id: boardRow!.id,
          name,
          position,
        }))
        const { error: colErr } = await supabase.from('columns').insert(defaultColumns)
        if (colErr) throw colErr
      }

      setBoard(boardRow)

      // 2. Columns
      const { data: columnRows, error: columnsErr } = await supabase
        .from('columns')
        .select('*')
        .eq('board_id', boardRow.id)
        .order('position', { ascending: true })
      if (columnsErr) throw columnsErr
      setColumns((columnRows ?? []) as Column[])

      // 3. Labels
      const { data: labelRows, error: labelsErr } = await supabase
        .from('labels')
        .select('*')
        .eq('board_id', boardRow.id)
        .order('created_at', { ascending: true })
      if (labelsErr) throw labelsErr
      setLabels((labelRows ?? []) as Label[])

      // 4. Tasks
      const { data: taskRows, error: tasksErr } = await supabase
        .from('tasks')
        .select('*')
        .eq('board_id', boardRow.id)
        .order('position', { ascending: true })
      if (tasksErr) throw tasksErr

      // 5. Task <-> label join
      const { data: taskLabelRows, error: tlErr } = await supabase
        .from('task_labels')
        .select('task_id, label:labels(*)')
        .in('task_id', (taskRows ?? []).map((t) => t.id).length > 0 ? (taskRows ?? []).map((t) => t.id) : ['00000000-0000-0000-0000-000000000000'])
      if (tlErr) throw tlErr

      const labelsByTask = new Map<string, Label[]>()
      for (const row of (taskLabelRows ?? []) as unknown as TaskLabelRow[]) {
        const list = labelsByTask.get(row.task_id) ?? []
        list.push(row.label)
        labelsByTask.set(row.task_id, list)
      }

      const tasksWithLabels: Task[] = (taskRows ?? []).map((t) => ({
        ...(t as Omit<Task, 'labels'>),
        labels: labelsByTask.get(t.id) ?? [],
      }))
      setTasks(tasksWithLabels)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Er ging iets mis bij het laden van je bord.')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // ---------- Columns ----------

  async function addColumn(name: string) {
    if (!board) return
    const position = columns.length
    const { data, error: err } = await supabase
      .from('columns')
      .insert({ board_id: board.id, name, position })
      .select()
      .single()
    if (err) throw err
    setColumns((prev) => [...prev, data as Column])
  }

  async function renameColumn(columnId: string, name: string) {
    const { error: err } = await supabase.from('columns').update({ name }).eq('id', columnId)
    if (err) throw err
    setColumns((prev) => prev.map((c) => (c.id === columnId ? { ...c, name } : c)))
  }

  async function deleteColumn(columnId: string) {
    const { error: err } = await supabase.from('columns').delete().eq('id', columnId)
    if (err) throw err
    setColumns((prev) => prev.filter((c) => c.id !== columnId))
    setTasks((prev) => prev.filter((t) => t.column_id !== columnId))
  }

  async function reorderColumns(orderedIds: string[]) {
    const prevColumns = columns
    const updated = orderedIds
      .map((id, position) => {
        const col = columns.find((c) => c.id === id)
        return col ? { ...col, position } : null
      })
      .filter((c): c is Column => c !== null)
    setColumns(updated)
    try {
      const results = await Promise.all(
        updated.map((c) => supabase.from('columns').update({ position: c.position }).eq('id', c.id))
      )
      const failed = results.find((r) => r.error)
      if (failed?.error) throw failed.error
    } catch (err) {
      setColumns(prevColumns)
      throw err
    }
  }

  // ---------- Tasks ----------

  async function createTask(input: {
    columnId: string
    title: string
    description?: string | null
    dueDate?: string | null
    labelIds?: string[]
  }) {
    if (!board) return
    const columnTasks = tasks.filter((t) => t.column_id === input.columnId)
    const position = columnTasks.length
    const { data, error: err } = await supabase
      .from('tasks')
      .insert({
        board_id: board.id,
        column_id: input.columnId,
        title: input.title,
        description: input.description ?? null,
        due_date: input.dueDate ?? null,
        position,
      })
      .select()
      .single()
    if (err) throw err

    const newTask = data as Omit<Task, 'labels'>
    let taskLabels: Label[] = []
    if (input.labelIds && input.labelIds.length > 0) {
      const { error: tlErr } = await supabase
        .from('task_labels')
        .insert(input.labelIds.map((label_id) => ({ task_id: newTask.id, label_id })))
      if (tlErr) throw tlErr
      taskLabels = labels.filter((l) => input.labelIds!.includes(l.id))
    }

    setTasks((prev) => [...prev, { ...newTask, labels: taskLabels }])
  }

  async function updateTask(
    taskId: string,
    updates: {
      title?: string
      description?: string | null
      dueDate?: string | null
      labelIds?: string[]
    }
  ) {
    const patch: Record<string, unknown> = {}
    if (updates.title !== undefined) patch.title = updates.title
    if (updates.description !== undefined) patch.description = updates.description
    if (updates.dueDate !== undefined) patch.due_date = updates.dueDate

    if (Object.keys(patch).length > 0) {
      const { error: err } = await supabase.from('tasks').update(patch).eq('id', taskId)
      if (err) throw err
    }

    if (updates.labelIds !== undefined) {
      const { error: delErr } = await supabase.from('task_labels').delete().eq('task_id', taskId)
      if (delErr) throw delErr
      if (updates.labelIds.length > 0) {
        const { error: insErr } = await supabase
          .from('task_labels')
          .insert(updates.labelIds.map((label_id) => ({ task_id: taskId, label_id })))
        if (insErr) throw insErr
      }
    }

    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t
        return {
          ...t,
          title: updates.title !== undefined ? updates.title : t.title,
          description: updates.description !== undefined ? updates.description : t.description,
          due_date: updates.dueDate !== undefined ? updates.dueDate : t.due_date,
          labels:
            updates.labelIds !== undefined
              ? labels.filter((l) => updates.labelIds!.includes(l.id))
              : t.labels,
          updated_at: new Date().toISOString(),
        }
      })
    )
  }

  async function deleteTask(taskId: string) {
    const { error: err } = await supabase.from('tasks').delete().eq('id', taskId)
    if (err) throw err
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
  }

  /** Move a task to a (possibly different) column at a given index, and
   * persist new positions for every task in the affected column(s). */
  async function moveTask(taskId: string, toColumnId: string, toIndex: number) {
    const prevTasks = tasks
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    const fromColumnId = task.column_id

    // Build next state locally first (optimistic).
    let working = tasks.filter((t) => t.id !== taskId)
    const destTasks = working
      .filter((t) => t.column_id === toColumnId)
      .sort((a, b) => a.position - b.position)
    const clampedIndex = Math.max(0, Math.min(toIndex, destTasks.length))
    destTasks.splice(clampedIndex, 0, { ...task, column_id: toColumnId })

    working = working.filter((t) => t.column_id !== toColumnId)
    const reindexedDest = destTasks.map((t, i) => ({ ...t, position: i }))

    let reindexedSource: Task[] = []
    if (fromColumnId !== toColumnId) {
      const sourceTasks = working
        .filter((t) => t.column_id === fromColumnId)
        .sort((a, b) => a.position - b.position)
      reindexedSource = sourceTasks.map((t, i) => ({ ...t, position: i }))
      working = working.filter((t) => t.column_id !== fromColumnId)
    }

    const nextTasks = [...working, ...reindexedDest, ...reindexedSource]
    setTasks(nextTasks)

    try {
      const toUpdate = [...reindexedDest, ...reindexedSource]
      const results = await Promise.all(
        toUpdate.map((t) =>
          supabase
            .from('tasks')
            .update({ column_id: t.column_id, position: t.position })
            .eq('id', t.id)
        )
      )
      const failed = results.find((r) => r.error)
      if (failed?.error) throw failed.error
    } catch (err) {
      setTasks(prevTasks)
      throw err
    }
  }

  // ---------- Labels ----------

  async function createLabel(name: string, color: string) {
    if (!board) return
    const { data, error: err } = await supabase
      .from('labels')
      .insert({ board_id: board.id, name, color })
      .select()
      .single()
    if (err) throw err
    setLabels((prev) => [...prev, data as Label])
  }

  async function updateLabel(labelId: string, updates: { name?: string; color?: string }) {
    const { error: err } = await supabase.from('labels').update(updates).eq('id', labelId)
    if (err) throw err
    setLabels((prev) => prev.map((l) => (l.id === labelId ? { ...l, ...updates } : l)))
    setTasks((prev) =>
      prev.map((t) => ({
        ...t,
        labels: t.labels.map((l) => (l.id === labelId ? { ...l, ...updates } : l)),
      }))
    )
  }

  async function deleteLabel(labelId: string) {
    const { error: err } = await supabase.from('labels').delete().eq('id', labelId)
    if (err) throw err
    setLabels((prev) => prev.filter((l) => l.id !== labelId))
    setTasks((prev) => prev.map((t) => ({ ...t, labels: t.labels.filter((l) => l.id !== labelId) })))
  }

  return {
    board,
    columns,
    tasks,
    labels,
    loading,
    error,
    reload: loadAll,
    addColumn,
    renameColumn,
    deleteColumn,
    reorderColumns,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    createLabel,
    updateLabel,
    deleteLabel,
  }
}
