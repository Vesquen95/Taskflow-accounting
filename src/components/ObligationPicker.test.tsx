import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ObligationPicker } from './ObligationPicker'
import { legeSelecties, type ObligationSelection } from '../lib/clientObligations'
import type { Employee, ObligationType } from '../types'

// Dezelfde les als bij de AV-datum, maar dan voor de andere velden van dit
// vak: de keuzelijsten toonden met `??` een waarde die alleen op het scherm
// bestond. De motor rekent bij een ontbrekende parameter met precies deze
// waarden (migratie 0006: sla_maanden 3, frequentie kwartaal, termijn_dagen
// 10), dus tonen én bewaren is hetzelfde gedrag -- alleen nu zichtbaar,
// controleerbaar en aanpasbaar in plaats van stilzwijgend.

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    firm_id: 'f1',
    auth_user_id: 'auth-1',
    naam: 'Jan Janssens',
    email: 'jan@firm.be',
    rol: 'medewerker',
    mag_goedkeuren: false,
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const employees = [employee()]

const obligationTypes: ObligationType[] = [
  { id: 'ot-av', code: 'algemene_vergadering', naam: 'Algemene vergadering', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: 'jaarlijks', werkstroom: 'afsluiting' },
  { id: 'ot-jaar', code: 'jaarafsluiting', naam: 'Jaarafsluiting', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: 'jaarlijks', werkstroom: 'afsluiting' },
  { id: 'ot-rap', code: 'rapportering', naam: 'Periodieke rapportering', categorie: 'service', deadline_mechanisme: 'formule', standaard_periodiciteit: 'kwartaal', werkstroom: 'rapportering' },
]

/** Het vak is een gestuurd component; deze schil houdt de staat vast zoals
 *  ClientFormModal dat doet, zodat een test kan nakijken wat er écht bewaard
 *  wordt naast wat er getoond wordt. */
const bewaard: { selections: ObligationSelection[] } = { selections: [] }

function Harness({ initieel }: { initieel?: ObligationSelection[] }) {
  const [selections, setSelections] = useState<ObligationSelection[]>(
    initieel ??
      legeSelecties(obligationTypes)
  )
  bewaard.selections = selections
  return (
    <ObligationPicker
      obligationTypes={obligationTypes}
      employees={employees}
      selections={selections}
      btwRegime="geen"
      onChange={setSelections}
    />
  )
}

function parametersVan(typeId: string): Record<string, unknown> {
  const sel = bewaard.selections.find((s) => s.obligation_type_id === typeId)
  if (!sel) throw new Error(`geen selectie voor ${typeId}`)
  return sel.parameters
}

beforeEach(() => {
  bewaard.selections = []
})

describe('ObligationPicker — getoonde standaardwaarden staan ook echt in parameters', () => {
  it('schrijft frequentie en termijn_dagen weg zodra rapportering aangevinkt wordt', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Periodieke rapportering/ }))

    const frequentie = screen.getByLabelText('Frequentie') as HTMLSelectElement
    const termijn = screen.getByLabelText('Termijn (dagen na periode)') as HTMLInputElement
    expect(frequentie.value).toBe('kwartaal')
    expect(termijn.value).toBe('10')
    expect(parametersVan('ot-rap')).toEqual({ frequentie: 'kwartaal', termijn_dagen: 10 })
  })

  it('schrijft sla_maanden weg zodra jaarafsluiting aangevinkt wordt', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))

    const sla = screen.getByLabelText('Klaar binnen (maanden na boekjaareinde)') as HTMLInputElement
    expect(sla.value).toBe('3')
    expect(parametersVan('ot-jaar')).toEqual({ sla_maanden: 3 })
  })

  it('vult een bestaande verplichting aan zonder een ingevulde waarde te overschrijven', async () => {
    render(
      <Harness
        initieel={legeSelecties(obligationTypes).map((s) =>
          s.obligation_type_id === 'ot-rap'
            ? { ...s, gekozen: true, parameters: { frequentie: 'maand' } }
            : s
        )}
      />
    )

    expect((await screen.findByLabelText('Frequentie')) as HTMLSelectElement).toHaveValue('maand')
    expect(parametersVan('ot-rap')).toEqual({ frequentie: 'maand', termijn_dagen: 10 })
  })

  it('geeft de statutaire AV-datum géén standaard: die komt uit de statuten', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Algemene vergadering/ }))

    expect(screen.getByRole('radio', { name: 'Niet in de statuten' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Vaste datum' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'N-de weekdag' })).not.toBeChecked()
    expect(parametersVan('ot-av')).toEqual({})
  })

  it('toont na een leeggemaakt en verlaten getalveld opnieuw wat er opgeslagen staat', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    const sla = screen.getByLabelText('Klaar binnen (maanden na boekjaareinde)') as HTMLInputElement
    await user.clear(sla)
    // Tijdens het typen mag het veld even leeg staan; er wordt dan niets
    // gewijzigd, en bij het verlaten verschijnt de bewaarde waarde weer.
    expect(parametersVan('ot-jaar')).toEqual({ sla_maanden: 3 })
    await user.tab()

    expect(sla.value).toBe('3')
    expect(parametersVan('ot-jaar')).toEqual({ sla_maanden: 3 })
  })

  it('bewaart een aangepaste SLA', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    const sla = screen.getByLabelText('Klaar binnen (maanden na boekjaareinde)') as HTMLInputElement
    await user.type(sla, '{Backspace}6')

    expect(sla.value).toBe('6')
    expect(parametersVan('ot-jaar')).toEqual({ sla_maanden: 6 })
  })
})
