/**
 * De meldingsmail: wat er sinds de vorige mail voor jou veranderd is.
 *
 * De databank beslist wie wat hoort (`mail_melding_bij_taakwijziging`,
 * migratie 0067) en bundelt het per ontvanger (`mail_meldingen_klaar`). Dit
 * bestand beslist alleen hoe het eruitziet -- dezelfde scheiding als bij het
 * weekoverzicht.
 *
 * Dit bestand draait op twee plaatsen: in de tests hier, en als kopie in de
 * Edge Function (`supabase/functions/mail-verzenden/meldingMail.ts`). Een
 * test bewaakt dat de twee gelijk blijven. Daarom importeert het niets.
 */

export type MeldingSoort = 'toegewezen' | 'ter_goedkeuring' | 'teruggestuurd'

export interface Melding {
  soort: MeldingSoort
  klant: string
  verplichting: string
  periode: string | null
  deadline: string
  door: string | null
}

export interface MeldingenMail {
  naam: string
  meldingen: Melding[]
}

/** De volgorde is die van het belang: wat op jou wacht om verder te kunnen, eerst. */
const VOLGORDE: readonly MeldingSoort[] = ['teruggestuurd', 'ter_goedkeuring', 'toegewezen']

const TITEL: Record<MeldingSoort, string> = {
  teruggestuurd: 'Teruggestuurd',
  ter_goedkeuring: 'Wacht op je goedkeuring',
  toegewezen: 'Op jouw naam gezet',
}

const UITLEG: Record<MeldingSoort, string> = {
  teruggestuurd: 'Niet goedgekeurd: bekijk de opmerking en dien opnieuw in.',
  ter_goedkeuring: 'Een collega diende dit in en wacht op jou om te kunnen indienen.',
  toegewezen: 'Een collega zette dit op jouw naam.',
}

const KLEUR: Record<MeldingSoort, string> = {
  teruggestuurd: '#b91c1c',
  ter_goedkeuring: '#b45309',
  toegewezen: '#1d4ed8',
}

const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

/** "15 okt 2026": in een melding altijd met jaartal, want er is geen "vandaag" om naast te leggen. */
export function meldingDatum(datum: string): string {
  const [jaar, maand, dag] = datum.split('-').map(Number)
  return `${dag} ${MAANDEN[maand - 1]} ${jaar}`
}

function regel(m: Melding): string {
  const delen = [m.klant, m.verplichting]
  if (m.periode) delen.push(m.periode)
  return delen.join(' — ')
}

function groepen(mail: MeldingenMail): { soort: MeldingSoort; items: Melding[] }[] {
  return VOLGORDE.flatMap((soort) => {
    const items = mail.meldingen.filter((m) => m.soort === soort)
    return items.length > 0 ? [{ soort, items }] : []
  })
}

/**
 * Het onderwerp noemt wat er gebeurde, niet "melding": wie in een volle inbox
 * "2 wachten op je goedkeuring" ziet staan, weet zonder openen of het nu moet.
 */
export function meldingOnderwerp(mail: MeldingenMail): string {
  const stukken = groepen(mail).map(({ soort, items }) => {
    const n = items.length
    switch (soort) {
      case 'teruggestuurd':
        return `${n} teruggestuurd`
      case 'ter_goedkeuring':
        return n === 1 ? '1 wacht op je goedkeuring' : `${n} wachten op je goedkeuring`
      case 'toegewezen':
        return `${n} op jouw naam`
    }
  })
  if (stukken.length === 1 && mail.meldingen.length === 1) {
    const m = mail.meldingen[0]
    return `Taskflow — ${TITEL[m.soort].toLowerCase()}: ${m.klant}`
  }
  return `Taskflow — ${stukken.join(', ')}`
}

function voornaam(naam: string): string {
  return naam.split(' ')[0]
}

export function meldingTekst(mail: MeldingenMail, appUrl?: string): string {
  const regels: string[] = [`Dag ${voornaam(mail.naam)},`, '']
  for (const { soort, items } of groepen(mail)) {
    regels.push(`${TITEL[soort].toUpperCase()} (${items.length})`, UITLEG[soort], '')
    for (const m of items) {
      const door = m.door ? `  (door ${m.door})` : ''
      regels.push(`  ${meldingDatum(m.deadline).padEnd(12)} ${regel(m)}${door}`)
    }
    regels.push('')
  }
  if (appUrl) regels.push(`Open Taskflow: ${appUrl}`)
  return regels.join('\n').trimEnd() + '\n'
}

/** Klantnamen typen mensen zelf in: alles uit de databank wordt ontsnapt. */
export function escapeMeldingHtml(tekst: string): string {
  return tekst
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function meldingHtml(mail: MeldingenMail, appUrl?: string): string {
  const e = escapeMeldingHtml
  const delen: string[] = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2937;max-width:640px">`,
    `<p style="margin:0 0 16px">Dag ${e(voornaam(mail.naam))},</p>`,
  ]
  for (const { soort, items } of groepen(mail)) {
    delen.push(
      `<h2 style="margin:24px 0 2px;font-size:15px;color:${KLEUR[soort]}">${e(TITEL[soort])} (${items.length})</h2>`,
      `<p style="margin:0 0 8px;font-size:12px;color:#6b7280">${e(UITLEG[soort])}</p>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">`
    )
    for (const m of items) {
      delen.push(
        `<tr>` +
          `<td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:${KLEUR[soort]};font-weight:600">${e(meldingDatum(m.deadline))}</td>` +
          `<td style="padding:4px 0;vertical-align:top;border-bottom:1px solid #f3f4f6">${e(regel(m))}` +
          (m.door ? `<span style="color:#6b7280"> — door ${e(m.door)}</span>` : '') +
          `</td>` +
          `</tr>`
      )
    }
    delen.push(`</table>`)
  }
  if (appUrl) {
    delen.push(
      `<p style="margin:28px 0 0"><a href="${e(appUrl)}" style="background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">Open Taskflow</a></p>`
    )
  }
  delen.push(
    `<p style="margin:28px 0 0;font-size:11px;color:#9ca3af">Je krijgt deze mail wanneer een collega iets voor jou verandert. Wat je zelf doet, en wat Taskflow zelf aanmaakt, mailen we niet.</p>`,
    `</div>`
  )
  return delen.join('\n')
}
