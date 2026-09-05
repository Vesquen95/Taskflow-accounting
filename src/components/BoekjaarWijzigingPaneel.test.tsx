import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BoekjaarWijzigingPaneel } from './BoekjaarWijzigingPaneel'
import { boekjaarLabel } from '../lib/boekjaar'
import type { BoekjaarWijziging, BoekjaarWijzigingTaak } from '../hooks/useBoekjaarWijziging'

const WIJZIGING: BoekjaarWijziging = {
  id: 'w1',
  client_id: 'c1',
  oude_maand: 12,
  oude_dag: 31,
  nieuwe_maand: 6,
  nieuwe_dag: 30,
  gemeld_op: '2026-09-05T10:00:00Z',
}

function taak(over: Partial<BoekjaarWijzigingTaak> = {}): BoekjaarWijzigingTaak {
  return {
    task_id: 't1',
    verplichting: 'Jaarafsluiting',
    periode_label: '2026',
    periode_eind: '2026-12-31',
    due_date: '2027-03-31',
    status: 'open',
    herzetbaar: true,
    reden: null,
    ...over,
  }
}

function toon(taken: BoekjaarWijzigingTaak[], over: { bezig?: boolean } = {}) {
  const onDoorvoeren = vi.fn(async () => taken.filter((t) => t.herzetbaar).length)
  const onNegeren = vi.fn(async () => {})
  render(
    <BoekjaarWijzigingPaneel
      wijziging={WIJZIGING}
      taken={taken}
      bezig={over.bezig ?? false}
      onDoorvoeren={onDoorvoeren}
      onNegeren={onNegeren}
    />
  )
  return { onDoorvoeren, onNegeren }
}

describe('boekjaarLabel', () => {
  it('schrijft dag en maand met een voorloopnul', () => {
    expect(boekjaarLabel(6, 30)).toBe('30/06')
    expect(boekjaarLabel(1, 5)).toBe('05/01')
  })
})

describe('BoekjaarWijzigingPaneel', () => {
  it('noemt het oude én het nieuwe boekjaareinde', () => {
    // Zonder allebei is het paneel niet te beoordelen: "het boekjaar is
    // gewijzigd" zegt niets over of dat de bedoeling was.
    toon([taak()])
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('31/12')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('30/06')
  })

  it('herrekent niets uit zichzelf', () => {
    // De kern van de afspraak met het kantoor: automatisch herrekenen, maar
    // pas na een klik.
    const { onDoorvoeren } = toon([taak()])
    expect(onDoorvoeren).not.toHaveBeenCalled()
  })

  it('scheidt wat herrekend wordt van wat blijft staan, met de reden erbij', () => {
    toon([
      taak(),
      taak({
        task_id: 't2',
        periode_label: '2027',
        herzetbaar: false,
        reden: 'Deze taak heeft een handmatig afgesproken deadline.',
      }),
    ])
    expect(screen.getByText(/Wordt herrekend \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/Blijft staan \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/handmatig afgesproken deadline/)).toBeInTheDocument()
  })

  it('voert het voorstel uit bij een klik en meldt hoeveel er herrekend is', async () => {
    const user = userEvent.setup()
    const { onDoorvoeren } = toon([taak(), taak({ task_id: 't2', periode_label: '2027' })])
    await user.click(screen.getByRole('button', { name: /Herrekenen \(2\)/ }))
    expect(onDoorvoeren).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/2 taken zijn herrekend/)).toBeInTheDocument()
  })

  it('laat de knop niet toe als er niets te herrekenen valt', () => {
    // Alles staat vast (handmatige datum, of al gepasseerd). Een knop die dan
    // "0 taken herrekend" oplevert, is een knop die liegt over wat hij doet.
    toon([taak({ herzetbaar: false, reden: 'De deadline is al gepasseerd.' })])
    expect(screen.getByRole('button', { name: /Herrekenen/ })).toBeDisabled()
  })

  it('sluit de melding zonder te herrekenen', async () => {
    const user = userEvent.setup()
    const { onDoorvoeren, onNegeren } = toon([taak()])
    await user.click(screen.getByRole('button', { name: /Laat staan zoals het is/ }))
    expect(onNegeren).toHaveBeenCalledTimes(1)
    expect(onDoorvoeren).not.toHaveBeenCalled()
  })
})
