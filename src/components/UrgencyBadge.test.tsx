import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UrgencyBadge } from './UrgencyBadge'

function iso(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  return d.toISOString().slice(0, 10)
}

describe('UrgencyBadge', () => {
  it('renders nothing for a final-status task', () => {
    const { container } = render(<UrgencyBadge dueDate={iso(-10)} status="ingediend_afgerond" categorie="wettelijk" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows "Te laat" for an overdue open wettelijk task', () => {
    render(<UrgencyBadge dueDate={iso(-1)} status="open" categorie="wettelijk" />)
    expect(screen.getByText('Te laat')).toBeInTheDocument()
  })

  it('shows a stricter band for wettelijk than for service work at the same 4-day distance', () => {
    const { rerender } = render(<UrgencyBadge dueDate={iso(4)} status="open" categorie="wettelijk" />)
    expect(screen.getByText('Binnenkort')).toBeInTheDocument()

    rerender(<UrgencyBadge dueDate={iso(4)} status="open" categorie="service" />)
    expect(screen.getByText('Deze week')).toBeInTheDocument()
  })

  it('treats a missing categorie (ad-hoc task) as wettelijk-strict', () => {
    render(<UrgencyBadge dueDate={iso(2)} status="open" categorie={null} />)
    expect(screen.getByText('Deze week')).toBeInTheDocument()
  })
})
