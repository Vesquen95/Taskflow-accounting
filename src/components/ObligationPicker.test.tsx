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
    niveau: null,
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
  { id: 'ot-venb', code: 'aangifte_venb_pb', naam: 'Aangifte VenB', categorie: 'wettelijk', deadline_mechanisme: 'jaarlijkse_kalender', standaard_periodiciteit: 'jaarlijks', werkstroom: 'vennootschapsbelasting' },
  { id: 'ot-rpb', code: 'aangifte_rpb', naam: 'Aangifte RPB', categorie: 'wettelijk', deadline_mechanisme: 'jaarlijkse_kalender', standaard_periodiciteit: 'jaarlijks', werkstroom: 'vennootschapsbelasting' },
  { id: 'ot-va', code: 'va_venb', naam: 'Voorafbetaling VenB (VA1-VA4)', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: 'kwartaal', werkstroom: 'vennootschapsbelasting' },
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
    expect(parametersVan('ot-jaar')).toEqual({ basis: 'boekjaar', sla_maanden: 3 })
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
    expect(parametersVan('ot-jaar')).toEqual({ basis: 'boekjaar', sla_maanden: 3 })
    await user.tab()

    expect(sla.value).toBe('3')
    expect(parametersVan('ot-jaar')).toEqual({ basis: 'boekjaar', sla_maanden: 3 })
  })

  it('bewaart een aangepaste SLA', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    const sla = screen.getByLabelText('Klaar binnen (maanden na boekjaareinde)') as HTMLInputElement
    await user.type(sla, '{Backspace}6')

    expect(sla.value).toBe('6')
    expect(parametersVan('ot-jaar')).toEqual({ basis: 'boekjaar', sla_maanden: 6 })
  })
})

describe('ObligationPicker — de jaarafsluiting voor de algemene vergadering', () => {
  it('wisselt naar het AV-getal en laat de doorlooptijd verdwijnen', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    await user.selectOptions(screen.getByLabelText('Deadline jaarafsluiting'), 'voor_av')

    const maanden = screen.getByLabelText('Maanden voor de algemene vergadering') as HTMLInputElement
    expect(maanden.value).toBe('1')
    // sla_maanden moet echt weg zijn. Bleef het staan, dan zou het scherm iets
    // anders tonen dan wat de motor gebruikt zodra iemand terugschakelt.
    expect(parametersVan('ot-jaar')).toEqual({ basis: 'voor_av', maanden_voor_av: 1 })
    expect(screen.queryByLabelText('Klaar binnen (maanden na boekjaareinde)')).toBeNull()
  })

  it('bewaart een ander aantal maanden voor de vergadering', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    await user.selectOptions(screen.getByLabelText('Deadline jaarafsluiting'), 'voor_av')
    await user.type(screen.getByLabelText('Maanden voor de algemene vergadering'), '{Backspace}2')

    expect(parametersVan('ot-jaar')).toEqual({ basis: 'voor_av', maanden_voor_av: 2 })
  })

  it('komt terug op de doorlooptijd bij het terugschakelen', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    const keuze = screen.getByLabelText('Deadline jaarafsluiting')
    await user.selectOptions(keuze, 'voor_av')
    await user.selectOptions(keuze, 'boekjaar')

    expect(parametersVan('ot-jaar')).toEqual({ basis: 'boekjaar', sla_maanden: 3 })
    expect(screen.queryByLabelText('Maanden voor de algemene vergadering')).toBeNull()
  })

  it('opent een bestaande AV-gebaseerde verplichting op die keuze', async () => {
    render(
      <Harness
        initieel={legeSelecties(obligationTypes).map((s) =>
          s.obligation_type_id === 'ot-jaar'
            ? { ...s, gekozen: true, parameters: { basis: 'voor_av', maanden_voor_av: 3 } }
            : s
        )}
      />
    )

    const keuze = screen.getByLabelText('Deadline jaarafsluiting') as HTMLSelectElement
    expect(keuze.value).toBe('voor_av')
    expect((screen.getByLabelText('Maanden voor de algemene vergadering') as HTMLInputElement).value).toBe('3')
    // Het openen van een dossier mag er niets bij schrijven.
    expect(parametersVan('ot-jaar')).toEqual({ basis: 'voor_av', maanden_voor_av: 3 })
  })
})

describe('ObligationPicker — wat bij deze soort dossier kan bestaan', () => {
  const types: ObligationType[] = [
    ...obligationTypes,
    { id: 'ot-pb', code: 'aangifte_pb', naam: 'Aangifte personenbelasting', categorie: 'wettelijk', deadline_mechanisme: 'jaarlijkse_kalender', standaard_periodiciteit: 'jaarlijks', werkstroom: 'vennootschapsbelasting' },
  ]

  function toon(klantsoort: 'rechtspersoon' | 'natuurlijk_persoon', initieel?: ObligationSelection[]) {
    bewaard.selections = initieel ?? legeSelecties(types)
    function Harnas() {
      const [sel, setSel] = useState<ObligationSelection[]>(bewaard.selections)
      return (
        <ObligationPicker
          obligationTypes={types}
          employees={employees}
          selections={sel}
          btwRegime="geen"
          klantsoort={klantsoort}
          onChange={(next) => {
            bewaard.selections = next
            setSel(next)
          }}
        />
      )
    }
    render(<Harnas />)
  }

  it('biedt bij een rechtspersoon geen aangifte personenbelasting aan', () => {
    toon('rechtspersoon')
    expect(screen.queryByText(/Aangifte personenbelasting/)).toBeNull()
    expect(screen.getByText(/Algemene vergadering/)).toBeInTheDocument()
  })

  it('laat bij een natuurlijke persoon de algemene vergadering weg en de PB staan', () => {
    // Een natuurlijke persoon houdt geen algemene vergadering en legt geen
    // jaarrekening neer. Ze toch aanbieden zou een verplichting suggereren
    // die niet bestaat.
    toon('natuurlijk_persoon')
    expect(screen.getByText(/Aangifte personenbelasting/)).toBeInTheDocument()
    expect(screen.queryByText(/Algemene vergadering/)).toBeNull()
  })

  it('houdt een reeds aangevinkte verplichting zichtbaar, ook bij de andere soort', () => {
    // Anders verdwijnt ze van het scherm terwijl ze opgeslagen blijft.
    toon(
      'natuurlijk_persoon',
      legeSelecties(types).map((s) =>
        s.obligation_type_id === 'ot-av' ? { ...s, gekozen: true } : s
      )
    )
    expect(screen.getByText(/Algemene vergadering/)).toBeInTheDocument()
  })

  it('laat de termijn van de PB-aangifte kiezen, met complex als standaard', async () => {
    const user = userEvent.setup()
    toon('natuurlijk_persoon')

    await user.click(screen.getByRole('checkbox', { name: /Aangifte personenbelasting/ }))
    const keuze = screen.getByLabelText('Soort PB-aangifte') as HTMLSelectElement
    expect(keuze.value).toBe('complex')

    await user.selectOptions(keuze, 'eenvoudig')
    expect(bewaard.selections.find((s) => s.obligation_type_id === 'ot-pb')?.parameters).toEqual({
      aangifte_vorm: 'eenvoudig',
    })
  })
})

describe('ObligationPicker — de jaarafsluiting zonder algemene vergadering', () => {
  // Zonder AV in het dossier verwijst "een maand voor de algemene vergadering"
  // naar een vergadering die er niet is. De motor rekent dan met het wettelijke
  // ijkpunt; het scherm hoort dat te zeggen in plaats van een afspraak te
  // beloven die nergens staat.
  it('waarschuwt wanneer de algemene vergadering niet aangevinkt staat', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    await user.selectOptions(screen.getByLabelText('Deadline jaarafsluiting'), 'voor_av')

    expect(screen.getByText(/geen algemene vergadering aangevinkt/i)).toBeInTheDocument()
  })

  it('zwijgt zodra de algemene vergadering er wel bij staat', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /Algemene vergadering/ }))
    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    await user.selectOptions(screen.getByLabelText('Deadline jaarafsluiting'), 'voor_av')

    expect(screen.queryByText(/geen algemene vergadering aangevinkt/i)).toBeNull()
    // De bestaande uitleg bij de jaarafsluiting blijft wel staan. (Bij de AV
    // zelf staat een gelijkaardige zin; vandaar de specifiekere tekst hier.)
    expect(
      screen.getByText(/Is er bij de algemene vergadering geen statutaire datum ingevuld/i)
    ).toBeInTheDocument()
  })
})

describe('ObligationPicker — verplichtingen die niet samen kunnen', () => {
  it('zet de VenB-aangifte uit zodra je de RPB aanvinkt', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /^Aangifte VenB/ }))
    await user.click(screen.getByRole('checkbox', { name: /^Aangifte RPB/ }))

    // Zichtbaar uit, niet stil blijven staan tot de databank het afwijst.
    expect(screen.getByRole('checkbox', { name: /^Aangifte VenB/ })).not.toBeChecked()
    expect(bewaard.selections.find((s) => s.obligation_type_id === 'ot-venb')?.gekozen).toBe(false)
    expect(bewaard.selections.find((s) => s.obligation_type_id === 'ot-rpb')?.gekozen).toBe(true)
  })

  it('zet ook de voorafbetalingen uit bij de RPB', async () => {
    // Het kantoor: "als je RPB aanduidt is het beter om geen VA's aan te
    // bieden". Die horen bij de vennootschapsbelasting.
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /^Voorafbetaling/ }))
    await user.click(screen.getByRole('checkbox', { name: /^Aangifte RPB/ }))

    expect(screen.getByRole('checkbox', { name: /^Voorafbetaling/ })).not.toBeChecked()
    expect(bewaard.selections.find((s) => s.obligation_type_id === 'ot-va')?.gekozen).toBe(false)
  })

  it('biedt de voorafbetalingen niet meer aan onder de RPB, en zegt waarom', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /^Aangifte RPB/ }))

    expect(screen.getByRole('checkbox', { name: /^Voorafbetaling/ })).toBeDisabled()
    expect(screen.getByText(/gaat niet samen met Aangifte RPB/)).toBeInTheDocument()
  })

  it('laat de twee aangiftes elkaar met één klik vervangen', async () => {
    // Allebei blokkeren zou betekenen dat je eerst moet afvinken voor je kunt
    // omschakelen -- drie handelingen voor één beslissing.
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /^Aangifte RPB/ }))
    expect(screen.getByRole('checkbox', { name: /^Aangifte VenB/ })).toBeEnabled()

    await user.click(screen.getByRole('checkbox', { name: /^Aangifte VenB/ }))
    expect(screen.getByRole('checkbox', { name: /^Aangifte VenB/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /^Aangifte RPB/ })).not.toBeChecked()
  })

  it('laat de VenB en de voorafbetalingen wél samengaan', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /^Aangifte VenB/ }))
    await user.click(screen.getByRole('checkbox', { name: /^Voorafbetaling/ }))

    expect(screen.getByRole('checkbox', { name: /^Aangifte VenB/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /^Voorafbetaling/ })).toBeChecked()
  })

  it('geeft de voorafbetalingen weer vrij zodra de RPB eraf gaat', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const rpb = screen.getByRole('checkbox', { name: /^Aangifte RPB/ })
    await user.click(rpb)
    expect(screen.getByRole('checkbox', { name: /^Voorafbetaling/ })).toBeDisabled()

    await user.click(rpb)
    expect(screen.getByRole('checkbox', { name: /^Voorafbetaling/ })).toBeEnabled()
  })
})

describe('ObligationPicker — het UBO-register', () => {
  const types: ObligationType[] = [
    ...obligationTypes,
    { id: 'ot-ubo', code: 'ubo_bevestiging', naam: 'UBO-bevestiging', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: 'jaarlijks', werkstroom: 'afsluiting' },
  ]

  function toon(
    klantsoort: 'rechtspersoon' | 'natuurlijk_persoon',
    rechtsvorm?: string,
    initieel?: ObligationSelection[]
  ) {
    bewaard.selections = initieel ?? legeSelecties(types)
    function Harnas() {
      const [sel, setSel] = useState<ObligationSelection[]>(bewaard.selections)
      return (
        <ObligationPicker
          obligationTypes={types}
          employees={employees}
          selections={sel}
          btwRegime="geen"
          klantsoort={klantsoort}
          rechtsvorm={rechtsvorm}
          onChange={(next) => {
            bewaard.selections = next
            setSel(next)
          }}
        />
      )
    }
    render(<Harnas />)
  }

  it('biedt de bevestiging aan bij een vennootschap', () => {
    toon('rechtspersoon', 'BV')
    expect(screen.getByText(/UBO-bevestiging/)).toBeInTheDocument()
  })

  it('biedt ze ook aan bij een vzw', () => {
    toon('rechtspersoon', 'VZW')
    expect(screen.getByText(/UBO-bevestiging/)).toBeInTheDocument()
  })

  it('laat ze weg bij een eenmanszaak', () => {
    // Er is geen entiteit om achter te kijken: de ondernemer ís de
    // natuurlijke persoon. Ze toch aanbieden zou een verplichting suggereren
    // die niet bestaat.
    toon('rechtspersoon', 'Eenmanszaak')
    expect(screen.queryByText(/UBO-bevestiging/)).toBeNull()
  })

  it('laat ze weg bij een natuurlijke persoon', () => {
    toon('natuurlijk_persoon', 'BV')
    expect(screen.queryByText(/UBO-bevestiging/)).toBeNull()
  })

  it('biedt ze aan bij een rechtsvorm die het scherm niet herkent', () => {
    // Zo goed als elke rechtspersoon is informatieplichtig; niet weten is geen
    // reden om een wettelijke verplichting stil weg te laten.
    toon('rechtspersoon', 'Buitenlandse entiteit')
    expect(screen.getByText(/UBO-bevestiging/)).toBeInTheDocument()
  })

  it('houdt ze zichtbaar wanneer ze al aanstaat, ook bij een eenmanszaak', () => {
    // Anders verdwijnt ze van het scherm terwijl ze opgeslagen blijft: wie de
    // rechtsvorm wijzigt hoort ze zelf uit te vinken.
    toon(
      'rechtspersoon',
      'Eenmanszaak',
      legeSelecties(types).map((s) =>
        s.obligation_type_id === 'ot-ubo' ? { ...s, gekozen: true } : s
      )
    )
    expect(screen.getByText(/UBO-bevestiging/)).toBeInTheDocument()
  })
})

describe('ObligationPicker — de intracommunautaire opgave', () => {
  const types: ObligationType[] = [
    ...obligationTypes,
    { id: 'ot-ic', code: 'ic_opgave', naam: 'Intracommunautaire opgave', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: 'maand_of_kwartaal', werkstroom: 'btw' },
  ]

  function toon(btwRegime: string, initieel?: ObligationSelection[]) {
    bewaard.selections = initieel ?? legeSelecties(types)
    function Harnas() {
      const [sel, setSel] = useState<ObligationSelection[]>(bewaard.selections)
      return (
        <ObligationPicker
          obligationTypes={types}
          employees={employees}
          selections={sel}
          btwRegime={btwRegime}
          onChange={(next) => {
            bewaard.selections = next
            setSel(next)
          }}
        />
      )
    }
    render(<Harnas />)
  }

  it('biedt ze aan bij een btw-plichtig dossier', () => {
    toon('periodieke_aangever')
    expect(screen.getByText(/Intracommunautaire opgave/)).toBeInTheDocument()
  })

  it('laat ze weg bij een dossier zonder btw-regime', () => {
    toon('geen')
    expect(screen.queryByText(/Intracommunautaire opgave/)).toBeNull()
  })

  it('staat standaard op "volgt de btw-aangifte" en bewaart een afwijking', async () => {
    // De echte regel is een drempel van 50.000 euro per kwartaal, en die kent
    // Taskflow niet — vandaar dat het kantoor kan afwijken.
    const user = userEvent.setup()
    toon('periodieke_aangever')

    await user.click(screen.getByRole('checkbox', { name: /Intracommunautaire opgave/ }))
    const keuze = screen.getByLabelText('Frequentie van de IC-opgave') as HTMLSelectElement
    expect(keuze.value).toBe('')

    await user.selectOptions(keuze, 'maand')
    expect(bewaard.selections.find((s) => s.obligation_type_id === 'ot-ic')?.parameters).toEqual({
      frequentie: 'maand',
    })
  })
})
