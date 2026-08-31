import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppLayout } from './AppLayout'
import type { Employee } from '../types'
import { stelSchermIn } from '../test/kleinScherm'

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ signOut: vi.fn() }),
}))

const employee: Employee = {
  id: 'e1',
  firm_id: 'f1',
  auth_user_id: 'auth-1',
  naam: 'Jan Janssens',
  email: 'jan@rsm.be',
  rol: 'kantoorbeheerder',
  mag_goedkeuren: true,
  actief: true,
  created_at: '2026-01-01T00:00:00Z',
}

function toon(navigate = vi.fn(), activeView = 'kalender', activeParam?: string) {
  render(
    <AppLayout employee={employee} activeView={activeView} activeParam={activeParam} navigate={navigate}>
      <p>inhoud</p>
    </AppLayout>
  )
  return navigate
}

describe('AppLayout — de navigatie op een klein scherm', () => {
  it('houdt het menu dicht tot je erom vraagt', async () => {
    toon()
    // De knop bestaat alleen visueel op een klein scherm (lg:hidden), maar het
    // opengeklapt-zijn is echte staat: die moet kloppen voor een schermlezer.
    const knop = screen.getByRole('button', { name: 'Menu openen' })
    expect(knop).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(knop)

    expect(screen.getByRole('button', { name: 'Menu sluiten' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('sluit het menu zodra je een scherm kiest', async () => {
    // Een menu dat over het scherm blijft liggen dat je net opvroeg is op een
    // telefoon hinderlijk.
    const navigate = toon()
    await userEvent.click(screen.getByRole('button', { name: 'Menu openen' }))
    await userEvent.click(screen.getByRole('button', { name: 'Klanten' }))

    expect(navigate).toHaveBeenCalledWith('klanten', undefined)
    expect(screen.getByRole('button', { name: 'Menu openen' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('sluit het menu met Escape', async () => {
    toon()
    await userEvent.click(screen.getByRole('button', { name: 'Menu openen' }))
    await userEvent.keyboard('{Escape}')

    expect(screen.getByRole('button', { name: 'Menu openen' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('noemt in de bovenbalk het scherm waar je staat', () => {
    // Met de zijbalk dicht is dit het enige wat nog zegt waar je bent.
    toon(vi.fn(), 'werk', 'btw')
    expect(screen.getByRole('banner')).toHaveTextContent('Btw')
  })

  it('noemt een klantdossier bij de groep en niet bij zijn id', () => {
    toon(vi.fn(), 'klanten', '0f9d5b1e-0000-0000-0000-000000000000')
    expect(screen.getByRole('banner')).toHaveTextContent('Klanten')
  })

  it('houdt de navigatie zelf ongewijzigd: dezelfde ingangen als altijd', () => {
    toon()
    const zijbalk = screen.getByRole('complementary')
    for (const label of ['Kalender', 'Btw', 'Afsluiting', 'Fiches', 'Klanten', 'Medewerkers']) {
      expect(zijbalk).toHaveTextContent(label)
    }
  })
})

describe('AppLayout — het hoofdscherm heet op een telefoon anders', () => {
  let herstel: (() => void) | null = null
  afterEach(() => {
    herstel?.()
    herstel = null
  })

  it('noemt het "Taken" op een klein scherm en "Kalender" op een computer', () => {
    // Op een telefoon opent dat menu-item een takenlijst (te laat, vandaag,
    // deze week) en geen kalender. Het "Kalender" noemen zou beloven wat er
    // niet staat.
    herstel = stelSchermIn(true)
    toon()
    expect(screen.getByRole('complementary')).toHaveTextContent('Taken')
    expect(screen.getByRole('banner')).toHaveTextContent('Taken')

    herstel()
    herstel = stelSchermIn(false)
    cleanup()
    toon()
    expect(screen.getByRole('complementary')).toHaveTextContent('Kalender')
  })
})
