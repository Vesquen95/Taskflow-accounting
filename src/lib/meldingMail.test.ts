import { describe, expect, it } from 'vitest'
import { meldingHtml, meldingOnderwerp, meldingTekst, type Melding, type MeldingenMail } from './meldingMail'
import meldingBron from './meldingMail.ts?raw'
import weekBron from './weekoverzicht.ts?raw'
import meldingKopie from '../../supabase/functions/mail-verzenden/meldingMail.ts?raw'
import weekKopie from '../../supabase/functions/mail-verzenden/weekoverzicht.ts?raw'

function melding(over: Partial<Melding> = {}): Melding {
  return {
    soort: 'ter_goedkeuring',
    klant: 'PATO',
    verplichting: 'Aangifte VenB',
    periode: '2025',
    deadline: '2026-10-15',
    door: 'Jan Janssens',
    ...over,
  }
}

const mail = (meldingen: Melding[]): MeldingenMail => ({ naam: 'Wibren Patteaux', meldingen })

describe('meldingOnderwerp', () => {
  it('noemt de klant als er maar één ding is', () => {
    expect(meldingOnderwerp(mail([melding()]))).toBe('Taskflow — wacht op je goedkeuring: PATO')
  })

  it('telt per soort, het dringendste eerst', () => {
    const m = mail([
      melding({ soort: 'toegewezen' }),
      melding({ soort: 'ter_goedkeuring' }),
      melding({ soort: 'ter_goedkeuring', klant: 'TL Worx' }),
      melding({ soort: 'teruggestuurd' }),
    ])
    expect(meldingOnderwerp(m)).toBe('Taskflow — 1 teruggestuurd, 2 wachten op je goedkeuring, 1 op jouw naam')
  })
})

describe('meldingTekst en meldingHtml', () => {
  it('zegt hetzelfde in tekst en in HTML', () => {
    const m = mail([melding(), melding({ soort: 'teruggestuurd', klant: 'Ilias Thomas', door: 'Partner P' })])
    const tekst = meldingTekst(m, 'https://voorbeeld.test/')
    const html = meldingHtml(m, 'https://voorbeeld.test/')
    for (const stuk of ['Dag Wibren', 'PATO — Aangifte VenB — 2025', 'Ilias Thomas', '15 okt 2026', 'door Partner P']) {
      expect(tekst).toContain(stuk)
      expect(html).toContain(stuk)
    }
    // Teruggestuurd staat boven ter goedkeuring: wie iets moet herdoen, leest het eerst.
    expect(tekst.indexOf('TERUGGESTUURD')).toBeLessThan(tekst.indexOf('WACHT OP JE GOEDKEURING'))
  })

  it('ontsnapt wat mensen zelf intypen', () => {
    const html = meldingHtml(mail([melding({ klant: '<script>x</script> & Co' })]))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt; &amp; Co')
  })
})

describe('de kopieën in de Edge Function', () => {
  // De functie draait in Deno en kan niet uit src/ importeren. Ze krijgt een
  // kopie; deze test zorgt dat die niet stilletjes achterloopt.
  it('meldingMail.ts is gelijk aan src/lib', () => {
    expect(meldingKopie).toBe(meldingBron)
  })

  it('weekoverzicht.ts is gelijk aan src/lib', () => {
    expect(weekKopie).toBe(weekBron)
  })
})
