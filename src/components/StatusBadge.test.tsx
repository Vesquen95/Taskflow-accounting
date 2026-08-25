import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from './StatusBadge'
import type { TaskStatus } from '../types'

const CASES: Array<[TaskStatus, string]> = [
  ['open', 'Open'],
  ['in_uitvoering', 'In uitvoering'],
  ['wacht_op_klant', 'Wacht op klant'],
  ['wacht_op_goedkeuring', 'Wacht op goedkeuring'],
  ['ingediend_afgerond', 'Ingediend/afgerond'],
  ['geannuleerd', 'Geannuleerd'],
]

describe('StatusBadge', () => {
  it.each(CASES)('renders the Dutch label for status "%s"', (status, label) => {
    render(<StatusBadge status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('visually distinguishes a cancelled task with a strike-through class', () => {
    render(<StatusBadge status="geannuleerd" />)
    expect(screen.getByText('Geannuleerd')).toHaveClass('line-through')
  })
})
