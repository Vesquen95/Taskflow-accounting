/**
 * Eén gedeelde vertaling van een onbekende `unknown` uit een catch-blok naar
 * een melding die bruikbaar is voor de gebruiker (een accountant, geen
 * developer) zónder de technische details weg te gooien.
 *
 * Waarom dit bestaat: het oude patroon
 * `err instanceof Error ? err.message : 'Opslaan is mislukt.'` gooide
 * precies de nuttigste fouten weg. Een PostgREST-/Supabase-foutobject is
 * afhankelijk van clientversie en realm niet altijd een echte
 * `Error`-instantie, maar draagt wél `message`, `code`, `details` en `hint`.
 * Een RLS-weigering ("new row violates row-level security policy",
 * SQLSTATE 42501) kwam daardoor bij de gebruiker aan als het nietszeggende
 * "Opslaan is mislukt.".
 *
 * Regel: begrijpelijke Nederlandse zin eerst, technische tekst + SQLSTATE
 * erachter tussen haakjes. De code maakt in één oogopslag het verschil
 * tussen "rechten", "constraint" en "netwerk" duidelijk.
 */

export interface NormalizedError {
  /** Begrijpelijke Nederlandse zin, als eerste getoond aan de gebruiker. */
  melding: string
  /** Technische toelichting (PostgREST message/details/hint), of null. */
  technisch: string | null
  /** SQLSTATE (bv. '42501') of PostgREST-code, of null. */
  code: string | null
  /**
   * Of de code in de UI getoond mag worden. Staat enkel op `false` voor
   * P0001: die tekst komt uit onze eigen triggers, is al Nederlands en
   * expliciet voor de gebruiker geschreven — er hoeft geen code bij.
   */
  toonCode: boolean
  /** Verbindingsprobleem (fetch/DNS/offline) i.p.v. een serverantwoord. */
  isNetwerkfout: boolean
}

/** Standaardtekst wanneer we werkelijk niets bruikbaars uit de fout halen. */
export const FALLBACK_MELDING = 'Er is een onverwachte fout opgetreden.'

/**
 * SQLSTATE → begrijpelijke zin. Enkel codes die in deze app realistisch
 * voorkomen en waarvan de betekenis vaststaat (PostgreSQL Appendix A).
 * Bewust géén verzonnen codes.
 */
const CODE_MELDINGEN: Record<string, string> = {
  // Klasse 42 — insufficient privilege (o.a. RLS-weigering).
  '42501': 'Je hebt geen rechten voor deze actie.',
  // Klasse 23 — integrity constraint violation.
  '23502': 'Een verplicht veld is niet ingevuld.',
  '23503': 'De gekoppelde gegevens bestaan niet (meer).',
  '23505': 'Er bestaat al een record met deze waarde.',
  '23514': 'Een van de ingevulde waarden is niet toegelaten.',
  // Klasse 22 — data exception.
  '22P02': 'Een van de ingevulde waarden heeft een ongeldige opmaak.',
  // PostgREST: .single()/.maybeSingle() kreeg geen (of meerdere) rijen —
  // in de praktijk bijna altijd "rij bestaat niet of is niet zichtbaar".
  PGRST116: 'Het gevraagde record bestaat niet of is niet zichtbaar voor jou.',
}

/**
 * Verfijningen voor 23505: de generieke zin is correct maar vaag, terwijl
 * de constraint-naam/detail wél verraadt wat er dubbel is. Sleutel =
 * substring die in message/details/hint voorkomt.
 */
const UNIQUE_VERFIJNINGEN: Array<{ patroon: string; melding: string }> = [
  // Bewuste afweging: de unieke index verraadt dat er een dossier met dit
  // nummer bestaat, ook wanneer dat vertrouwelijk is en dus onzichtbaar. Dat
  // bestaansfeit is niet te verbergen zonder de index op te geven, dus leggen
  // we het liever uit dan de gebruiker in het ongewisse te laten dubbel werk
  // doen. De klantgegevens zelf blijven afgeschermd.
  {
    patroon: 'ondernemingsnummer',
    melding:
      'Er bestaat al een klant met dit ondernemingsnummer. Zie je die niet in de klantenlijst, dan gaat het om een vertrouwelijk dossier — vraag je kantoorbeheerder.',
  },
  { patroon: 'idx_task_instances_unique_period', melding: 'Deze taak bestaat al voor deze klant en periode.' },
  { patroon: 'email', melding: 'Er bestaat al een medewerker met dit e-mailadres.' },
]

/** Codes die door de trigger `raise exception` (zonder errcode) ontstaan. */
const RAISE_EXCEPTION_CODE = 'P0001'

const NETWERK_PATRONEN = [
  /failed to fetch/i,
  /fetch failed/i,
  /networkerror/i,
  /network request failed/i,
  /load failed/i,
  /err_internet_disconnected/i,
]

/** Foutnamen die Supabase gebruikt voor een mislukte HTTP-call zelf. */
const NETWERK_NAMEN = ['AuthRetryableFetchError', 'FunctionsFetchError']

/** Node/browser-niveau socketfouten. */
const NETWERK_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ENETUNREACH']

interface RuweVelden {
  message: string | null
  code: string | null
  details: string | null
  hint: string | null
  name: string | null
}

const LEGE_VELDEN: RuweVelden = { message: null, code: null, details: null, hint: null, name: null }

function leesTekst(bron: Record<string, unknown>, sleutel: string): string | null {
  const waarde = bron[sleutel]
  if (typeof waarde === 'string') {
    const trimmed = waarde.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof waarde === 'number' && Number.isFinite(waarde)) return String(waarde)
  return null
}

/**
 * Haalt de bekende velden uit eender wat er gegooid werd. Werkt bewust op
 * duck-typing i.p.v. `instanceof`: een PostgREST-fout is niet altijd een
 * `Error`-instantie, en dát is precies de bug die dit bestand oplost.
 */
function leesVelden(err: unknown): RuweVelden {
  if (typeof err === 'string') {
    const trimmed = err.trim()
    return { ...LEGE_VELDEN, message: trimmed.length > 0 ? trimmed : null }
  }
  if (err !== null && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    return {
      message: leesTekst(obj, 'message') ?? leesTekst(obj, 'error_description') ?? leesTekst(obj, 'error'),
      code: leesTekst(obj, 'code'),
      details: leesTekst(obj, 'details'),
      hint: leesTekst(obj, 'hint'),
      name: leesTekst(obj, 'name'),
    }
  }
  return LEGE_VELDEN
}

/** Laatste redmiddel: maak iets leesbaars van een waarde zonder velden. */
function beschrijfOnbekend(err: unknown): string | null {
  if (err === null || err === undefined) return null
  if (typeof err === 'object') {
    try {
      const json = JSON.stringify(err)
      if (!json || json === '{}') return null
      return json.length > 200 ? `${json.slice(0, 200)}…` : json
    } catch {
      return null
    }
  }
  const tekst = String(err).trim()
  return tekst.length > 0 ? tekst : null
}

function isNetwerkfout(velden: RuweVelden): boolean {
  if (velden.name !== null && NETWERK_NAMEN.includes(velden.name)) return true
  if (velden.code !== null && NETWERK_CODES.includes(velden.code)) return true
  const bericht = velden.message ?? ''
  return NETWERK_PATRONEN.some((patroon) => patroon.test(bericht))
}

function voegSamen(delen: Array<string | null>): string | null {
  const gevuld = delen.filter((deel): deel is string => deel !== null && deel.length > 0)
  return gevuld.length > 0 ? gevuld.join(' — ') : null
}

function verfijnUniqueMelding(velden: RuweVelden, standaard: string): string {
  const zoektekst = [velden.message, velden.details, velden.hint].filter(Boolean).join(' ').toLowerCase()
  const treffer = UNIQUE_VERFIJNINGEN.find((v) => zoektekst.includes(v.patroon))
  return treffer ? treffer.melding : standaard
}

/**
 * Zet een willekeurige `unknown` om in gestructureerde velden. Pure functie
 * (geen logging) zodat ze eenvoudig te testen is; gebruik `reportError` op
 * call-sites zodat de volledige fout óók in de console belandt.
 */
export function normalizeError(err: unknown): NormalizedError {
  const velden = leesVelden(err)
  const volledigTechnisch = voegSamen([velden.message, velden.details, velden.hint])

  if (isNetwerkfout(velden)) {
    return {
      melding: 'Geen verbinding met de server. Controleer je internetverbinding en probeer opnieuw.',
      technisch: volledigTechnisch,
      code: velden.code,
      toonCode: velden.code !== null,
      isNetwerkfout: true,
    }
  }

  // Onze eigen triggers/RPC's gooien Nederlandse, voor de gebruiker
  // geschreven teksten (bv. "Alleen een kantoorbeheerder kan ..."). Die
  // tonen we ongewijzigd, zonder technische ruis erachter.
  if (velden.code === RAISE_EXCEPTION_CODE && velden.message !== null) {
    return {
      melding: velden.message,
      technisch: voegSamen([velden.details, velden.hint]),
      code: velden.code,
      toonCode: false,
      isNetwerkfout: false,
    }
  }

  const gemapt = velden.code !== null ? CODE_MELDINGEN[velden.code] : undefined
  if (gemapt !== undefined) {
    const melding = velden.code === '23505' ? verfijnUniqueMelding(velden, gemapt) : gemapt
    return {
      melding,
      technisch: volledigTechnisch,
      code: velden.code,
      toonCode: true,
      isNetwerkfout: false,
    }
  }

  // Onbekende code (of geen code) maar wél een bericht: toon het bericht
  // zelf — verzin er geen mooiere zin bij die de oorzaak zou verhullen.
  if (velden.message !== null) {
    return {
      melding: velden.message,
      technisch: voegSamen([velden.details, velden.hint]),
      code: velden.code,
      toonCode: velden.code !== null,
      isNetwerkfout: false,
    }
  }

  return {
    melding: FALLBACK_MELDING,
    technisch: beschrijfOnbekend(err),
    code: velden.code,
    toonCode: velden.code !== null,
    isNetwerkfout: false,
  }
}

/** Bouwt de te tonen tekst: begrijpelijke zin eerst, techniek tussen haakjes. */
function formatNormalizedError(genormaliseerd: NormalizedError, context?: string): string {
  const details: string[] = []
  if (genormaliseerd.technisch !== null) details.push(genormaliseerd.technisch)
  if (genormaliseerd.code !== null && genormaliseerd.toonCode) details.push(`code ${genormaliseerd.code}`)

  const kern = details.length > 0 ? `${genormaliseerd.melding} (${details.join(' — ')})` : genormaliseerd.melding
  if (context === undefined || context.trim().length === 0) return kern
  return `${context.trim().replace(/[.:]\s*$/, '')}: ${kern}`
}

/**
 * Pure variant: geeft de te tonen melding terug zonder te loggen.
 * `context` is een optioneel voorvoegsel ("Kon klanten niet laden").
 */
export function errorMessage(err: unknown, context?: string): string {
  return formatNormalizedError(normalizeError(err), context)
}

/**
 * Gebruik dit op call-sites: logt de vólledige fout naar de console (zodat
 * er via F12 altijd het complete object staat, inclusief details/hint/stack)
 * en geeft de gebruikersmelding terug.
 */
export function reportError(err: unknown, context?: string): string {
  const genormaliseerd = normalizeError(err)
  console.error(`[Taskflow] ${context ?? 'Onverwachte fout'}`, err, genormaliseerd)
  return formatNormalizedError(genormaliseerd, context)
}
