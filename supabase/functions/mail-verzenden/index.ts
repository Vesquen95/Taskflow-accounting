// mail-verzenden — de enige weg waarlangs Taskflow mail verstuurt (0067).
//
// Wordt aangeroepen door pg_cron via public.mail_wekker(), met een sleutel die
// de databank zelf bewaart. Drie taken:
//
//   { "taak": "meldingen" }     systeemberichten + gebundelde meldingen
//   { "taak": "weekoverzicht" } de maandagmail
//
// Verstuurt via Gmail (smtp.gmail.com, poort 465 -- Supabase laat 25 en 587
// niet toe). Nodig als geheimen van de functie, in te stellen in het
// Supabase-dashboard onder Edge Functions -> Secrets:
//
//   GMAIL_GEBRUIKER       het Gmail-adres waarvan de mails vertrekken
//   GMAIL_APP_WACHTWOORD  een app-wachtwoord van dat account (niet het gewone
//                         wachtwoord; aan te maken op
//                         https://myaccount.google.com/apppasswords)
//
// Zolang die ontbreken, antwoordt de functie 503 en blijft de wachtrij staan:
// er gaat niets verloren, het wacht.

import { createClient } from 'npm:@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer@6.9.16'
import { weekoverzichtHtml, weekoverzichtOnderwerp, weekoverzichtTekst, type Weekoverzicht } from './weekoverzicht.ts'
import { escapeMeldingHtml, meldingHtml, meldingOnderwerp, meldingTekst, type Melding } from './meldingMail.ts'

function dienstSleutel(): string {
  const oud = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (oud) return oud
  const nieuw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (nieuw) {
    const sleutels = JSON.parse(nieuw) as Record<string, string>
    return sleutels.default ?? Object.values(sleutels)[0]
  }
  throw new Error('Geen service-sleutel in de omgeving van de functie')
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, dienstSleutel(), {
  auth: { persistSession: false },
})

interface Instellingen {
  omleiden_naar: string | null
  meldingen_aan: boolean
  weekoverzicht_aan: boolean
  app_url: string | null
}

interface Bundel {
  employee_id: string
  naam: string
  email: string | null
  meldingen: Melding[] | null
  melding_ids: number[]
}

function antwoord(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** De datum in België, niet in UTC: om 00:30 op maandag is het in UTC nog zondag. */
function vandaagInBelgie(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(new Date())
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return antwoord(405, { fout: 'Alleen POST' })

  const { data: klopt, error: sleutelFout } = await db.rpc('mail_sleutel_klopt', {
    p_sleutel: req.headers.get('x-taskflow-sleutel') ?? '',
  })
  if (sleutelFout) return antwoord(500, { fout: sleutelFout.message })
  if (klopt !== true) return antwoord(401, { fout: 'Onbekende sleutel' })

  const gebruiker = Deno.env.get('GMAIL_GEBRUIKER')
  const wachtwoord = Deno.env.get('GMAIL_APP_WACHTWOORD')
  if (!gebruiker || !wachtwoord) {
    return antwoord(503, { fout: 'GMAIL_GEBRUIKER en GMAIL_APP_WACHTWOORD zijn nog niet ingesteld' })
  }

  const { taak } = (await req.json().catch(() => ({}))) as { taak?: string }
  const { data: inst, error: instFout } = await db
    .from('mail_instellingen')
    .select('omleiden_naar, meldingen_aan, weekoverzicht_aan, app_url')
    .single<Instellingen>()
  if (instFout || !inst) return antwoord(500, { fout: instFout?.message ?? 'Geen instellingen' })

  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: gebruiker, pass: wachtwoord },
  })
  const appUrl = inst.app_url ?? undefined

  // Eén plek waar mail de deur uitgaat, zodat de omleiding nooit vergeten wordt.
  async function verstuur(aan: string, onderwerp: string, tekst: string, html: string) {
    const naar = inst!.omleiden_naar ?? aan
    const kop = inst!.omleiden_naar && inst!.omleiden_naar !== aan ? `[voor ${aan}] ${onderwerp}` : onderwerp
    await transport.sendMail({ from: `"Taskflow" <${gebruiker}>`, to: naar, subject: kop, text: tekst, html })
  }

  async function log(soort: string, sleutel: string, aan: string, onderwerp: string) {
    await db.from('mail_verzonden').insert({ soort, sleutel, aan, onderwerp })
  }

  const verslag = { verzonden: 0, fouten: [] as string[] }

  if (taak === 'meldingen') {
    // 1. Systeemberichten (de fiscale controle, testmails).
    const { data: berichten, error } = await db.rpc('systeemberichten_klaar')
    if (error) verslag.fouten.push(error.message)
    for (const b of (berichten ?? []) as { id: number; onderwerp: string; tekst: string; ontvangers: string[] }[]) {
      if (b.ontvangers.length === 0) {
        await db.rpc('systeembericht_afgehandeld', { p_id: b.id, p_fout: 'Geen kantoorbeheerder met een account' })
        continue
      }
      try {
        const html =
          `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2937;max-width:720px">` +
          `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeMeldingHtml(b.tekst)}</pre></div>`
        for (const aan of b.ontvangers) {
          await verstuur(aan, b.onderwerp, b.tekst, html)
          await log('systeem', String(b.id), aan, b.onderwerp)
          verslag.verzonden++
        }
        await db.rpc('systeembericht_afgehandeld', { p_id: b.id, p_fout: null })
      } catch (e) {
        const fout = e instanceof Error ? e.message : String(e)
        verslag.fouten.push(fout)
        await db.rpc('systeembericht_afgehandeld', { p_id: b.id, p_fout: fout })
      }
    }

    // 2. Meldingen, één mail per ontvanger.
    const { data: bundels, error: bundelFout } = await db.rpc('mail_meldingen_klaar')
    if (bundelFout) verslag.fouten.push(bundelFout.message)
    for (const b of (bundels ?? []) as Bundel[]) {
      // Uitgeschakeld, geen adres, of niets meer dat de ontvanger mag zien:
      // afhandelen zonder te versturen, anders blijft het eeuwig wachten.
      if (!inst.meldingen_aan || !b.email || !b.meldingen || b.meldingen.length === 0) {
        await db.rpc('mail_meldingen_afgehandeld', { p_ids: b.melding_ids, p_fout: null })
        continue
      }
      try {
        const mail = { naam: b.naam, meldingen: b.meldingen }
        const onderwerp = meldingOnderwerp(mail)
        await verstuur(b.email, onderwerp, meldingTekst(mail, appUrl), meldingHtml(mail, appUrl))
        await db.rpc('mail_meldingen_afgehandeld', { p_ids: b.melding_ids, p_fout: null })
        await log('melding', `${Math.min(...b.melding_ids)}-${b.melding_ids.length}`, b.email, onderwerp)
        verslag.verzonden++
      } catch (e) {
        const fout = e instanceof Error ? e.message : String(e)
        verslag.fouten.push(fout)
        await db.rpc('mail_meldingen_afgehandeld', { p_ids: b.melding_ids, p_fout: fout })
      }
    }
  } else if (taak === 'weekoverzicht') {
    if (!inst.weekoverzicht_aan) return antwoord(200, { ...verslag, overgeslagen: 'weekoverzicht staat uit' })
    const vandaag = vandaagInBelgie()
    const { data: ontvangers, error } = await db.rpc('weekoverzicht_ontvangers', { p_vandaag: vandaag })
    if (error) return antwoord(500, { fout: error.message })
    for (const o of (ontvangers ?? []) as { employee_id: string; email: string | null; overzicht: Weekoverzicht }[]) {
      if (!o.email) continue
      // Al verstuurd vandaag (de functie kan twee keer draaien): niet opnieuw.
      const { count } = await db
        .from('mail_verzonden')
        .select('id', { count: 'exact', head: true })
        .eq('soort', 'weekoverzicht')
        .eq('sleutel', vandaag)
        .eq('aan', o.email)
      if ((count ?? 0) > 0) continue
      try {
        const onderwerp = weekoverzichtOnderwerp(o.overzicht)
        await verstuur(
          o.email,
          onderwerp,
          weekoverzichtTekst(o.overzicht, { appUrl }),
          weekoverzichtHtml(o.overzicht, { appUrl })
        )
        await log('weekoverzicht', vandaag, o.email, onderwerp)
        verslag.verzonden++
      } catch (e) {
        verslag.fouten.push(e instanceof Error ? e.message : String(e))
      }
    }
  } else {
    return antwoord(400, { fout: 'Onbekende taak; verwacht "meldingen" of "weekoverzicht"' })
  }

  if (verslag.fouten.length > 0) console.error('mail-verzenden', verslag)
  return antwoord(200, verslag)
})
