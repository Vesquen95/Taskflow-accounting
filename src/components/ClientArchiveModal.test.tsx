import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientArchiveModal } from './ClientArchiveModal'

const onClose = vi.fn()
const onConfirm = vi.fn()

beforeEach(() => {
  onClose.mockReset()
  onConfirm.mockReset()
  onConfirm.mockResolvedValue(undefined)
})

describe('ClientArchiveModal — wie archiveert weet vooraf wat er gebeurt', () => {
  it('noemt het aantal openstaande taken dat geannuleerd wordt', () => {
    render(
      <ClientArchiveModal clientNaam="Acme BV" vertrouwelijk={false} openstaandeTaken={12} onClose={onClose} onConfirm={onConfirm} />
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('12 openstaande taken')
    expect(screen.getByRole('button', { name: 'Archiveren en 12 taken annuleren' })).toBeInTheDocument()
  })

  it('schrijft één taak in het enkelvoud', () => {
    render(
      <ClientArchiveModal clientNaam="Acme BV" vertrouwelijk={false} openstaandeTaken={1} onClose={onClose} onConfirm={onConfirm} />
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('1 openstaande taak')
    expect(screen.getByRole('button', { name: 'Archiveren en 1 taak annuleren' })).toBeInTheDocument()
  })

  it('zegt het ook wanneer er niets te annuleren valt', () => {
    render(
      <ClientArchiveModal clientNaam="Acme BV" vertrouwelijk={false} openstaandeTaken={0} onClose={onClose} onConfirm={onConfirm} />
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('Er staan geen taken open')
    expect(screen.getByRole('button', { name: 'Archiveren' })).toBeInTheDocument()
  })

  it('waarschuwt dat annuleren niet terug te draaien is', () => {
    render(
      <ClientArchiveModal clientNaam="Acme BV" vertrouwelijk={false} openstaandeTaken={3} onClose={onClose} onConfirm={onConfirm} />
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('niet terug te draaien')
  })

  // can_view_client() laat een gewone medewerker een vertrouwelijk dossier
  // alleen zien zolang die er een niet-geannuleerde taak heeft. Na het
  // archiveren is dat er geen meer.
  it('waarschuwt bij een vertrouwelijk dossier dat enkel een kantoorbeheerder het nadien nog ziet', () => {
    render(
      <ClientArchiveModal clientNaam="Acme BV" vertrouwelijk openstaandeTaken={3} onClose={onClose} onConfirm={onConfirm} />
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('kantoorbeheerder')
  })

  it('waarschuwt niet over vertrouwelijkheid bij een gewoon dossier', () => {
    render(
      <ClientArchiveModal clientNaam="Acme BV" vertrouwelijk={false} openstaandeTaken={3} onClose={onClose} onConfirm={onConfirm} />
    )
    expect(screen.getByRole('dialog')).not.toHaveTextContent('kantoorbeheerder')
  })
})

describe('ClientArchiveModal — bevestigen en afbreken', () => {
  it('archiveert pas na een uitdrukkelijke bevestiging', async () => {
    const user = userEvent.setup()
    render(
      <ClientArchiveModal clientNaam="Acme BV" vertrouwelijk={false} openstaandeTaken={2} onClose={onClose} onConfirm={onConfirm} />
    )

    await user.click(screen.getByRole('button', { name: 'Annuleren' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Archiveren en 2 taken annuleren' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('toont de reden en blijft open wanneer het archiveren mislukt', async () => {
    const user = userEvent.setup()
    onConfirm.mockRejectedValue({ message: 'new row violates row-level security policy', code: '42501' })
    render(
      <ClientArchiveModal clientNaam="Acme BV" vertrouwelijk={false} openstaandeTaken={2} onClose={onClose} onConfirm={onConfirm} />
    )

    await user.click(screen.getByRole('button', { name: 'Archiveren en 2 taken annuleren' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('row-level security')
    expect(onClose).not.toHaveBeenCalled()
  })
})
