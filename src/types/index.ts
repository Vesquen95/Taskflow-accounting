export interface Board {
  id: string
  user_id: string
  name: string
  created_at: string
}

export interface Column {
  id: string
  board_id: string
  name: string
  position: number
  created_at: string
}

export interface Label {
  id: string
  board_id: string
  name: string
  color: string
  created_at: string
}

export interface Task {
  id: string
  board_id: string
  column_id: string
  title: string
  description: string | null
  due_date: string | null
  position: number
  created_at: string
  updated_at: string
  labels: Label[]
}

export type DueStatus = 'overdue' | 'today' | 'tomorrow' | 'upcoming' | null
