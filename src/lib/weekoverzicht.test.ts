import { describe, expect, it } from 'vitest'
import {
  achterstandLabel,
  gevuldeBlokken,
  korteDatum,
  weekoverzichtHtml,
  weekoverzichtOnderwerp,
  weekoverzichtTekst,
  type Weekoverzicht,
  type WeekoverzichtTaak,
} from './weekoverzicht'

function taak(overrides: Partial<WeekoverzichtTaak> = {}): WeekoverzichtTaak {
  return {
    klant: 'Bakkerij Dhondt bv',
    verplichting: 'Btw-aangifte',
    periode: '2026Q2',
    deadline: '2026-09-01',
    status: 'open',
    ...overrides,
  }
}

function overzicht(blokken: Weekoverzicht['blokken']): Weekoverzicht {
  return {
    medewerker: { id: 'e1', naam: 'Wibren Patteaux', email: 'w@rsm.be' },
    vandaag: '2026-09-07',
    blokken,
    iets_te_melden: Object.keys(blokken).length > 0,
  }
}

describe('weekoverzicht — datums', () => {
  it('laat het jaartal weg in het lopende jaar en zet het erbij zodra het afwijkt', () => {
    // "8 sep" in een mail van 2026 leest als volgende week, ook wanneer het
    // een deadline van 2025 is. Daar hoort een jaartal bij.
    expect(korteDatum('2026-09-08', '2026-09-07')).toBe('8 sep')
    expect(korteDatum('2025-09-08', '2026-09-07')).toBe('8 sep 2025')
  })

  it('zegt hoe laat iets is in dagen, en in maanden zodra dat leesbaarder is', () => {
    expect(achterstandLabel('2026-09-06', '2026-09-07')).toBe('1 dag te laat')
    expect(achterstandLabel('2026-08-25', '2026-09-07')).toBe('13 dagen te laat')
    expect(achterstandLabel('2026-08-05', '2026-09-07')).toBe('ruim een maand te laat')
    expect(achterstandLabel('2026-05-07', '2026-09-07')).toBe('ruim 4 maanden te laat')
  })

  it('zwijgt over achterstand voor wat nog niet vervallen is', () => {
    expect(achterstandLabel('2026-09-09', '2026-09-07')).toBe('')
    expect(achterstandLabel('2026-09-07', '2026-09-07')).toBe('')
  })

  it('telt over een zomertijdgrens heen nog altijd hele dagen', () => {
    // Zonder UTC levert de klokverzetting van 25 oktober 2026 een halve dag
    // op, en dus "6 dagen te laat" voor wat een week is.
    expect(achterstandLabel('2026-10-22', '2026-10-29')).toBe('7 dagen te laat')
  })
})

describe('weekoverzicht — de onderwerpregel', () => {
  it('noemt de aantallen, want die maken het verschil in een volle inbox', () => {
    const o = overzicht({
      te_laat: { totaal: 3, taken: [taak()] },
      deze_week: { totaal: 7, taken: [taak()] },
    })
    expect(weekoverzichtOnderwerp(o)).toBe('Taskflow — 3 te laat, 7 deze week')
  })

  it('houdt de vaste volgorde aan, ook als de databank ze anders teruggeeft', () => {
    const o = overzicht({
      wacht_op_jou: { totaal: 1, taken: [taak()] },
      te_laat: { totaal: 2, taken: [taak()] },
    })
    expect(weekoverzichtOnderwerp(o)).toBe('Taskflow — 2 te laat, 1 op je goedkeuring')
  })
})

describe('weekoverzicht — welke blokken tellen', () => {
  it('laat een leeg blok weg in plaats van "0" te tonen', () => {
    const o = overzicht({ te_laat: { totaal: 0, taken: [] }, deze_week: { totaal: 1, taken: [taak()] } })
    expect(gevuldeBlokken(o).map((b) => b.naam)).toEqual(['deze_week'])
  })
})

describe('weekoverzicht — de tekstversie', () => {
  const o = overzicht({
    te_laat: { totaal: 21, taken: [taak({ deadline: '2026-08-20', klant: 'Garage Peeters bv' })] },
    teambak: { totaal: 1, taken: [taak({ deadline: '2026-09-11', periode: null, verplichting: 'Jaarafsluiting' })] },
  })
  const tekst = weekoverzichtTekst(o, { appUrl: 'https://taskflow.example/' })

  it('zet de achterstand vooraan', () => {
    const kop = tekst.indexOf('TE LAAT')
    const bak = tekst.indexOf('NOG NIEMAND OPGENOMEN')
    expect(kop).toBeGreaterThan(-1)
    expect(kop).toBeLessThan(bak)
  })

  it('zegt hoeveel er weggelaten zijn — een mail die daarover zwijgt is erger dan geen mail', () => {
    expect(tekst).toContain('en nog 20 andere taken')
  })

  it('noemt de klant, de verplichting en de periode op één regel', () => {
    expect(tekst).toContain('Garage Peeters bv — Btw-aangifte — 2026Q2')
  })

  it('laat de periode weg wanneer er geen is, zonder een leeg streepje', () => {
    expect(tekst).toContain('Jaarafsluiting')
    expect(tekst).not.toContain('Jaarafsluiting — \n')
  })

  it('zet de achterstand alleen bij het blok waar ze iets betekent', () => {
    expect(tekst).toContain('(18 dagen te laat)')
    // Een taak van volgende week is niet te laat en krijgt geen etiket.
    expect(tekst.split('NOG NIEMAND OPGENOMEN')[1]).not.toContain('te laat')
  })

  it('zegt het gewoon wanneer er niets openstaat', () => {
    expect(weekoverzichtTekst(overzicht({}))).toContain('Er staat niets open')
  })
})

describe('weekoverzicht — de HTML-versie', () => {
  it('ontsnapt wat mensen zelf intypen', () => {
    // Een klantnaam is vrije tekst. Ze mag de mail niet stukmaken, en al
    // helemaal geen opmaak of script binnensmokkelen bij honderd collega\'s.
    const html = weekoverzichtHtml(
      overzicht({
        te_laat: {
          totaal: 1,
          taken: [taak({ klant: '<script>alert(1)</script> & Zn' })],
        },
      })
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Zn')
  })

  it('houdt alle opmaak op het element zelf, want mail kent geen stijlbladen', () => {
    const html = weekoverzichtHtml(overzicht({ deze_week: { totaal: 1, taken: [taak()] } }))
    expect(html).not.toContain('<style')
    expect(html).toContain('style="')
  })

  it('toont dezelfde regels als de tekstversie', () => {
    const o = overzicht({ te_laat: { totaal: 2, taken: [taak({ klant: 'Immo Van Damme nv' })] } })
    expect(weekoverzichtHtml(o)).toContain('Immo Van Damme nv — Btw-aangifte — 2026Q2')
    expect(weekoverzichtTekst(o)).toContain('Immo Van Damme nv — Btw-aangifte — 2026Q2')
  })

  it('toont de knop alleen wanneer er een adres meegegeven is', () => {
    const o = overzicht({ deze_week: { totaal: 1, taken: [taak()] } })
    expect(weekoverzichtHtml(o)).not.toContain('<a href')
    expect(weekoverzichtHtml(o, { appUrl: 'https://taskflow.example/' })).toContain(
      'href="https://taskflow.example/"'
    )
  })
})
