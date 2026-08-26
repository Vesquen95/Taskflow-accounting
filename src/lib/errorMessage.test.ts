import { describe, expect, it, vi } from 'vitest'
import { errorMessage, FALLBACK_MELDING, normalizeError, reportError } from './errorMessage'

/**
 * Bootst een PostgREST-/Supabase-foutobject na. Cruciaal detail: dit is
 * bewust *geen* `Error`-instantie — dat is precies het geval waar het oude
 * `err instanceof Error ? err.message : '...'`-patroon op stukliep en de
 * RLS-weigering bij het aanmaken van een klant onzichtbaar maakte.
 */
function postgrestError(fields: { message: string; code?: string; details?: string | null; hint?: string | null }) {
  return {
    message: fields.message,
    code: fields.code ?? '',
    details: fields.details ?? null,
    hint: fields.hint ?? null,
  }
}

describe('normalizeError — Supabase/PostgREST-objecten die geen Error zijn', () => {
  it('herkent een RLS-weigering (42501) en zet er een begrijpelijke zin voor', () => {
    const err = postgrestError({
      message: 'new row violates row-level security policy for table "clients"',
      code: '42501',
    })

    const genormaliseerd = normalizeError(err)
    expect(genormaliseerd.melding).toBe('Je hebt geen rechten voor deze actie.')
    expect(genormaliseerd.code).toBe('42501')
    expect(genormaliseerd.technisch).toContain('row-level security')

    // De technische tekst én de code blijven zichtbaar naast de uitleg.
    expect(errorMessage(err, 'Opslaan is mislukt')).toBe(
      'Opslaan is mislukt: Je hebt geen rechten voor deze actie. ' +
        '(new row violates row-level security policy for table "clients" — code 42501)'
    )
  })

  it('neemt details en hint mee in de technische toelichting', () => {
    const melding = errorMessage(
      postgrestError({
        message: 'permission denied for table task_instances',
        code: '42501',
        details: 'Rij hoort bij een ander kantoor',
        hint: 'Vraag een kantoorbeheerder om toegang',
      })
    )
    expect(melding).toBe(
      'Je hebt geen rechten voor deze actie. (permission denied for table task_instances — ' +
        'Rij hoort bij een ander kantoor — Vraag een kantoorbeheerder om toegang — code 42501)'
    )
  })

  it('vertaalt een unique violation (23505) en verfijnt op ondernemingsnummer', () => {
    const generiek = normalizeError(
      postgrestError({
        message: 'duplicate key value violates unique constraint "legal_calendar_uniq"',
        code: '23505',
      })
    )
    expect(generiek.melding).toBe('Er bestaat al een record met deze waarde.')

    const klant = normalizeError(
      postgrestError({
        message: 'duplicate key value violates unique constraint "clients_firm_id_ondernemingsnummer_key"',
        code: '23505',
        details: 'Key (firm_id, ondernemingsnummer)=(f1, 0123.456.789) already exists.',
      })
    )
    expect(klant.melding).toContain('Er bestaat al een klant met dit ondernemingsnummer.')
    // Een vertrouwelijk dossier is onzichtbaar maar bestaat wel: de melding
    // wijst de gebruiker door i.p.v. hem dubbel werk te laten doen.
    expect(klant.melding).toContain('vertrouwelijk dossier')
    expect(klant.technisch).toContain('0123.456.789')
  })

  it('vertaalt een check violation (23514)', () => {
    const genormaliseerd = normalizeError(
      postgrestError({
        message: 'new row for relation "clients" violates check constraint "clients_vertrouwelijk_check"',
        code: '23514',
      })
    )
    expect(genormaliseerd.melding).toBe('Een van de ingevulde waarden is niet toegelaten.')
    expect(genormaliseerd.technisch).toContain('clients_vertrouwelijk_check')
  })

  it('vertaalt een foreign key violation (23503) naar "bestaat niet (meer)"', () => {
    expect(
      normalizeError(
        postgrestError({
          message: 'insert or update on table "task_instances" violates foreign key constraint "..._client_id_fkey"',
          code: '23503',
        })
      ).melding
    ).toBe('De gekoppelde gegevens bestaan niet (meer).')
  })

  it('vertaalt een not-null violation (23502)', () => {
    expect(
      normalizeError(postgrestError({ message: 'null value in column "naam" violates not-null constraint', code: '23502' }))
        .melding
    ).toBe('Een verplicht veld is niet ingevuld.')
  })

  it('vertaalt een ongeldige waarde (22P02)', () => {
    expect(
      normalizeError(postgrestError({ message: 'invalid input syntax for type date: "31/02/2026"', code: '22P02' })).melding
    ).toBe('Een van de ingevulde waarden heeft een ongeldige opmaak.')
  })

  it('toont een ontbrekende/onzichtbare rij (PGRST116) begrijpelijk', () => {
    expect(
      normalizeError(
        postgrestError({ message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' })
      ).melding
    ).toBe('Het gevraagde record bestaat niet of is niet zichtbaar voor jou.')
  })
})

describe('normalizeError — eigen triggers (P0001)', () => {
  it('toont de Nederlandse triggertekst ongewijzigd, zonder technische ruis', () => {
    const err = postgrestError({
      message: 'Alleen een kantoorbeheerder kan taakgeneratie starten',
      code: 'P0001',
    })
    const genormaliseerd = normalizeError(err)

    expect(genormaliseerd.melding).toBe('Alleen een kantoorbeheerder kan taakgeneratie starten')
    expect(genormaliseerd.code).toBe('P0001')
    expect(genormaliseerd.toonCode).toBe(false)
    expect(errorMessage(err)).toBe('Alleen een kantoorbeheerder kan taakgeneratie starten')
  })

  it('behoudt het contextvoorvoegsel bij een triggertekst', () => {
    expect(
      errorMessage(
        postgrestError({ message: 'Er bestaat al een medewerker met dit e-mailadres in dit kantoor', code: 'P0001' }),
        'Uitnodigen is mislukt'
      )
    ).toBe('Uitnodigen is mislukt: Er bestaat al een medewerker met dit e-mailadres in dit kantoor')
  })
})

describe('normalizeError — echte Error-instanties', () => {
  it('gebruikt de message van een gewone Error', () => {
    expect(errorMessage(new Error('Titel is verplicht.'))).toBe('Titel is verplicht.')
  })

  it('leest ook code/details van een Error-instantie met extra velden (PostgrestError)', () => {
    const err = Object.assign(new Error('new row violates row-level security policy for table "clients"'), {
      code: '42501',
      details: null,
      hint: null,
    })
    expect(normalizeError(err).melding).toBe('Je hebt geen rechten voor deze actie.')
    expect(normalizeError(err).code).toBe('42501')
  })
})

describe('normalizeError — netwerkfouten', () => {
  it('herkent "Failed to fetch" als verbindingsprobleem', () => {
    const genormaliseerd = normalizeError(new TypeError('Failed to fetch'))
    expect(genormaliseerd.isNetwerkfout).toBe(true)
    expect(genormaliseerd.melding).toContain('Geen verbinding met de server')
    expect(errorMessage(new TypeError('Failed to fetch'), 'Kon klanten niet laden')).toBe(
      'Kon klanten niet laden: Geen verbinding met de server. Controleer je internetverbinding en probeer opnieuw. (Failed to fetch)'
    )
  })

  it('herkent de retry-fout van Supabase Auth op naam', () => {
    const err = { name: 'AuthRetryableFetchError', message: 'Request Failed', status: 0 }
    expect(normalizeError(err).isNetwerkfout).toBe(true)
  })

  it('herkent socketfouten op code', () => {
    expect(normalizeError({ message: 'connect ECONNREFUSED 127.0.0.1:54321', code: 'ECONNREFUSED' }).isNetwerkfout).toBe(
      true
    )
  })

  it('behandelt een gewone TypeError niet als netwerkfout', () => {
    const genormaliseerd = normalizeError(new TypeError('x.map is not a function'))
    expect(genormaliseerd.isNetwerkfout).toBe(false)
    expect(genormaliseerd.melding).toBe('x.map is not a function')
  })
})

describe('normalizeError — onbekende waarden', () => {
  it('valt terug op een nette melding bij null/undefined', () => {
    expect(errorMessage(null)).toBe(FALLBACK_MELDING)
    expect(errorMessage(undefined, 'Opslaan is mislukt')).toBe(`Opslaan is mislukt: ${FALLBACK_MELDING}`)
  })

  it('gebruikt een gegooide string als melding', () => {
    expect(errorMessage('Kon niets doen')).toBe('Kon niets doen')
  })

  it('toont een object zonder message compact als technische bijlage', () => {
    expect(errorMessage({ status: 500 })).toBe(`${FALLBACK_MELDING} ({"status":500})`)
  })

  it('toont een onbekende code ook zonder vertaling', () => {
    expect(errorMessage(postgrestError({ message: 'relation "clients" does not exist', code: '42P01' }))).toBe(
      'relation "clients" does not exist (code 42P01)'
    )
  })
})

describe('formattering', () => {
  it('ontdubbelt leestekens tussen context en melding', () => {
    expect(errorMessage(new Error('Boem'), 'Opslaan is mislukt.')).toBe('Opslaan is mislukt: Boem')
    expect(errorMessage(new Error('Boem'), 'Opslaan is mislukt:')).toBe('Opslaan is mislukt: Boem')
    expect(errorMessage(new Error('Boem'), '   ')).toBe('Boem')
  })
})

describe('reportError', () => {
  it('logt de volledige fout naar de console en geeft de melding terug', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = postgrestError({ message: 'new row violates row-level security policy', code: '42501' })

    const melding = reportError(err, 'Opslaan is mislukt')

    expect(melding).toBe(
      'Opslaan is mislukt: Je hebt geen rechten voor deze actie. (new row violates row-level security policy — code 42501)'
    )
    expect(spy).toHaveBeenCalledTimes(1)
    // Het rauwe object moet meegelogd worden, niet enkel de tekst — anders
    // is er via F12 nog steeds geen volledige diagnose mogelijk.
    expect(spy.mock.calls[0]).toContain(err)
    expect(spy.mock.calls[0][0]).toContain('Opslaan is mislukt')
    spy.mockRestore()
  })
})
