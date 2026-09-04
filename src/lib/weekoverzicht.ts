/**
 * Het weekoverzicht in tekst en in HTML.
 *
 * De databank beslist WAT er in de mail hoort (`weekoverzicht_voor`,
 * migratie 0043); dit bestand beslist alleen hoe het eruitziet. Die scheiding
 * is met opzet: de oordelen -- wat is te laat, wie mag welk dossier zien --
 * horen achter de muur van 0039 te zitten, niet in een sjabloon.
 *
 * Drie dingen die een mailsjabloon anders maken dan een scherm:
 *
 *  1. Er is geen tweede kans. Een scherm dat een naam verkeerd toont, herstel
 *     je met een herlaadbeurt; een mail staat voorgoed in de inbox van
 *     iemand. Daarom ontsnapt alles wat uit de databank komt (klantnamen zijn
 *     ingetypt door mensen, en een dossier met `<` in de naam mag de mail
 *     niet stukmaken).
 *  2. Mailprogramma's kennen geen stijlbladen. Alles staat als `style=""` op
 *     het element zelf -- lelijk in een codebestand, maar het alternatief is
 *     een mail die in Outlook uit elkaar valt.
 *  3. Wie de HTML niet krijgt, krijgt de tekstversie. Die is hier geen
 *     bijzaak: ze bevat exact dezelfde regels, zodat een mail nooit minder
 *     zegt omdat een programma geen opmaak toont.
 */

/** Eén regel in de mail. Spiegel van wat `weekoverzicht_voor` teruggeeft. */
export interface WeekoverzichtTaak {
  klant: string
  verplichting: string
  periode: string | null
  deadline: string
  status: string
}

export interface WeekoverzichtBlokInhoud {
  /** Hoeveel er in totaal zijn -- óók wat afgekapt werd. */
  totaal: number
  taken: WeekoverzichtTaak[]
}

export type BlokNaam = 'te_laat' | 'deze_week' | 'teambak' | 'wacht_op_jou'

export interface Weekoverzicht {
  medewerker: { id: string; naam: string; email: string | null }
  vandaag: string
  blokken: Partial<Record<BlokNaam, WeekoverzichtBlokInhoud>>
  iets_te_melden: boolean
}

/**
 * De volgorde is de boodschap. Achterstand staat vooraan omdat ze vooraan
 * hoort: wie eerst "deze week" leest, ziet de gemiste deadline pas na het
 * scrollen -- en scrollen doet niemand in een wekelijkse mail.
 */
export const BLOK_VOLGORDE: readonly BlokNaam[] = ['te_laat', 'deze_week', 'teambak', 'wacht_op_jou']

export const BLOK_TITEL: Record<BlokNaam, string> = {
  te_laat: 'Te laat',
  deze_week: 'Deze week',
  teambak: 'Nog niemand opgenomen',
  wacht_op_jou: 'Wacht op jouw goedkeuring',
}

/** Wat eronder staat, zodat een blok zichzelf uitlegt aan wie nieuw is. */
export const BLOK_UITLEG: Record<BlokNaam, string> = {
  te_laat: 'Deze deadlines zijn voorbij en staan op jouw naam.',
  deze_week: 'Vervalt binnen zeven dagen.',
  teambak: 'Werk van je team dat nog op niemands naam staat.',
  wacht_op_jou: 'Collega\'s wachten op je goedkeuring om te kunnen indienen.',
}

const MAANDEN = [
  'jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
]

/**
 * "8 sep", en met jaartal zodra het een ander jaar is dan vandaag. Een
 * deadline van 2025 die als "8 sep" in een mail van 2026 staat, leest als
 * volgende week.
 */
export function korteDatum(datum: string, vandaag: string): string {
  const [jaar, maand, dag] = datum.split('-').map(Number)
  const zelfdeJaar = datum.slice(0, 4) === vandaag.slice(0, 4)
  const kop = `${dag} ${MAANDEN[maand - 1]}`
  return zelfdeJaar ? kop : `${kop} ${jaar}`
}

/** Hele dagen tussen twee ISO-datums. Via UTC, zodat zomertijd niet meetelt. */
export function dagenVerschil(van: string, tot: string): number {
  const naarUtc = (d: string) => {
    const [jaar, maand, dag] = d.split('-').map(Number)
    return Date.UTC(jaar, maand - 1, dag)
  }
  return Math.round((naarUtc(tot) - naarUtc(van)) / 86_400_000)
}

/**
 * Hoe laat een taak is, in woorden. Een datum alleen zegt te weinig: "3 sep"
 * en "12 mei" ogen even erg, terwijl het ene één dag en het andere vier
 * maanden is.
 */
export function achterstandLabel(deadline: string, vandaag: string): string {
  const dagen = dagenVerschil(deadline, vandaag)
  if (dagen <= 0) return ''
  if (dagen === 1) return '1 dag te laat'
  if (dagen < 31) return `${dagen} dagen te laat`
  const maanden = Math.round(dagen / 30.4)
  return maanden === 1 ? 'ruim een maand te laat' : `ruim ${maanden} maanden te laat`
}

/** Wat er van een taak op één regel staat: klant, verplichting, periode. */
export function taakRegel(taak: WeekoverzichtTaak): string {
  const delen = [taak.klant, taak.verplichting]
  if (taak.periode) delen.push(taak.periode)
  return delen.join(' — ')
}

/** De blokken die daadwerkelijk iets bevatten, in de vaste volgorde. */
export function gevuldeBlokken(o: Weekoverzicht): { naam: BlokNaam; inhoud: WeekoverzichtBlokInhoud }[] {
  return BLOK_VOLGORDE.flatMap((naam) => {
    const inhoud = o.blokken[naam]
    return inhoud && inhoud.totaal > 0 ? [{ naam, inhoud }] : []
  })
}

/**
 * De onderwerpregel. Ze noemt de aantallen, niet "je weekoverzicht": wie in
 * een volle inbox ziet staan dat er drie dingen te laat zijn, opent de mail;
 * wie "Taskflow weekoverzicht" ziet staan, leert hem weg te klikken.
 */
export function weekoverzichtOnderwerp(o: Weekoverzicht): string {
  const stukken = gevuldeBlokken(o).map(({ naam, inhoud }) => {
    switch (naam) {
      case 'te_laat':
        return `${inhoud.totaal} te laat`
      case 'deze_week':
        return `${inhoud.totaal} deze week`
      case 'teambak':
        return `${inhoud.totaal} zonder naam`
      case 'wacht_op_jou':
        return `${inhoud.totaal} op je goedkeuring`
    }
  })
  return stukken.length > 0 ? `Taskflow — ${stukken.join(', ')}` : 'Taskflow — niets openstaand'
}

function afkapRegel(inhoud: WeekoverzichtBlokInhoud): string | null {
  const rest = inhoud.totaal - inhoud.taken.length
  if (rest <= 0) return null
  return `… en nog ${rest} ${rest === 1 ? 'andere' : 'andere taken'} (open Taskflow voor de volledige lijst)`
}

export interface RenderOpties {
  /** De plek waar de app staat, bv. "https://…/Taskflow-accounting/". Weggelaten = geen knop. */
  appUrl?: string
}

/** De tekstversie. Geen tweederangs versie: exact dezelfde regels. */
export function weekoverzichtTekst(o: Weekoverzicht, opties: RenderOpties = {}): string {
  const regels: string[] = [`Dag ${o.medewerker.naam.split(' ')[0]},`, '']
  const blokken = gevuldeBlokken(o)
  if (blokken.length === 0) {
    regels.push('Er staat niets open. Fijne week.')
  }
  for (const { naam, inhoud } of blokken) {
    regels.push(`${BLOK_TITEL[naam].toUpperCase()} (${inhoud.totaal})`, BLOK_UITLEG[naam], '')
    for (const taak of inhoud.taken) {
      const achter = naam === 'te_laat' ? achterstandLabel(taak.deadline, o.vandaag) : ''
      const datum = korteDatum(taak.deadline, o.vandaag)
      regels.push(`  ${datum.padEnd(11)} ${taakRegel(taak)}${achter ? `  (${achter})` : ''}`)
    }
    const rest = afkapRegel(inhoud)
    if (rest) regels.push(`  ${rest}`)
    regels.push('')
  }
  if (opties.appUrl) regels.push(`Open Taskflow: ${opties.appUrl}`)
  return regels.join('\n').trimEnd() + '\n'
}

/** Ontsnapt alles wat uit de databank komt. Klantnamen typen mensen zelf in. */
export function escapeHtml(tekst: string): string {
  return tekst
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Kleuren uit de app, letterlijk overgenomen zodat de mail en het scherm
// dezelfde taal spreken: rood is te laat, amber komt eraan.
const KLEUR: Record<BlokNaam, string> = {
  te_laat: '#b91c1c',
  deze_week: '#b45309',
  teambak: '#0f766e',
  wacht_op_jou: '#4338ca',
}

export function weekoverzichtHtml(o: Weekoverzicht, opties: RenderOpties = {}): string {
  const blokken = gevuldeBlokken(o)
  const delen: string[] = []
  delen.push(
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2937;max-width:640px">`,
    `<p style="margin:0 0 16px">Dag ${escapeHtml(o.medewerker.naam.split(' ')[0])},</p>`
  )
  if (blokken.length === 0) {
    delen.push(`<p style="margin:0 0 16px">Er staat niets open. Fijne week.</p>`)
  }
  for (const { naam, inhoud } of blokken) {
    delen.push(
      `<h2 style="margin:24px 0 2px;font-size:15px;color:${KLEUR[naam]}">${escapeHtml(BLOK_TITEL[naam])} (${inhoud.totaal})</h2>`,
      `<p style="margin:0 0 8px;font-size:12px;color:#6b7280">${escapeHtml(BLOK_UITLEG[naam])}</p>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">`
    )
    for (const taak of inhoud.taken) {
      const achter = naam === 'te_laat' ? achterstandLabel(taak.deadline, o.vandaag) : ''
      delen.push(
        `<tr>` +
          `<td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:${KLEUR[naam]};font-weight:600">` +
          `${escapeHtml(korteDatum(taak.deadline, o.vandaag))}</td>` +
          `<td style="padding:4px 0;vertical-align:top;border-bottom:1px solid #f3f4f6">` +
          `${escapeHtml(taakRegel(taak))}` +
          (achter ? `<span style="color:#6b7280"> — ${escapeHtml(achter)}</span>` : '') +
          `</td>` +
          `</tr>`
      )
    }
    delen.push(`</table>`)
    const rest = afkapRegel(inhoud)
    if (rest) delen.push(`<p style="margin:8px 0 0;font-size:12px;color:#6b7280">${escapeHtml(rest)}</p>`)
  }
  if (opties.appUrl) {
    delen.push(
      `<p style="margin:28px 0 0">` +
        `<a href="${escapeHtml(opties.appUrl)}" style="background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">Open Taskflow</a>` +
        `</p>`
    )
  }
  delen.push(
    `<p style="margin:28px 0 0;font-size:11px;color:#9ca3af">Je krijgt deze mail elke maandag zolang er iets openstaat. Staat er niets open, dan sturen we niets.</p>`,
    `</div>`
  )
  return delen.join('\n')
}
