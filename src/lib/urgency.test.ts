import { describe, expect, it } from 'vitest'
import { daysUntil, formatDate, getUrgencyBand, wachtDuur, wachtTeLang } from './urgency'

const today = new Date('2026-06-15T12:00:00')

function iso(daysFromToday: number): string {
  const d = new Date(today)
  d.setDate(d.getDate() + daysFromToday)
  return d.toISOString().slice(0, 10)
}

describe('getUrgencyBand', () => {
  it('marks a past due date as te_laat regardless of category', () => {
    expect(getUrgencyBand(iso(-1), 'open', 'wettelijk', today)).toBe('te_laat')
    expect(getUrgencyBand(iso(-1), 'open', 'service', today)).toBe('te_laat')
  })

  it('marks a due date of today as vandaag', () => {
    expect(getUrgencyBand(iso(0), 'open', 'wettelijk', today)).toBe('vandaag')
  })

  it('applies stricter (earlier) bands to wettelijk than to service obligations', () => {
    // 4 days out: still "deze_week" pressure for a statutory deadline...
    expect(getUrgencyBand(iso(4), 'open', 'wettelijk', today)).toBe('binnenkort')
    // ...but merely "deze_week" (not yet binnenkort) for service work, since
    // service gets a longer runway before the same label kicks in.
    expect(getUrgencyBand(iso(4), 'open', 'service', today)).toBe('deze_week')
  })

  it('treats a task with no obligation_type (ad-hoc) as wettelijk-strict by default', () => {
    expect(getUrgencyBand(iso(2), 'open', null, today)).toBe('deze_week')
  })

  it('returns null for final statuses regardless of how overdue the date is', () => {
    expect(getUrgencyBand(iso(-30), 'ingediend_afgerond', 'wettelijk', today)).toBeNull()
    expect(getUrgencyBand(iso(-30), 'geannuleerd', 'wettelijk', today)).toBeNull()
  })

  it('returns later for dates well beyond the near-term bands', () => {
    expect(getUrgencyBand(iso(30), 'open', 'wettelijk', today)).toBe('later')
    expect(getUrgencyBand(iso(20), 'open', 'service', today)).toBe('later')
  })
})

describe('getUrgencyBand — band boundaries (docs/PLAN.md §4 point 5)', () => {
  // Wettelijk: deze_week <=3, binnenkort <=7, later beyond.
  it('wettelijk: day 3 is still deze_week, day 4 flips to binnenkort', () => {
    expect(getUrgencyBand(iso(3), 'open', 'wettelijk', today)).toBe('deze_week')
    expect(getUrgencyBand(iso(4), 'open', 'wettelijk', today)).toBe('binnenkort')
  })

  it('wettelijk: day 7 is still binnenkort, day 8 flips to later', () => {
    expect(getUrgencyBand(iso(7), 'open', 'wettelijk', today)).toBe('binnenkort')
    expect(getUrgencyBand(iso(8), 'open', 'wettelijk', today)).toBe('later')
  })

  // Service: deze_week <=5, binnenkort <=14, later beyond.
  it('service: day 5 is still deze_week, day 6 flips to binnenkort', () => {
    expect(getUrgencyBand(iso(5), 'open', 'service', today)).toBe('deze_week')
    expect(getUrgencyBand(iso(6), 'open', 'service', today)).toBe('binnenkort')
  })

  it('service: day 14 is still binnenkort, day 15 flips to later', () => {
    expect(getUrgencyBand(iso(14), 'open', 'service', today)).toBe('binnenkort')
    expect(getUrgencyBand(iso(15), 'open', 'service', today)).toBe('later')
  })

  it('treats explicit categorie "wettelijk" the same as undefined/null (strict-by-default)', () => {
    expect(getUrgencyBand(iso(4), 'open', 'wettelijk', today)).toBe(getUrgencyBand(iso(4), 'open', undefined, today))
    expect(getUrgencyBand(iso(4), 'open', 'wettelijk', today)).toBe(getUrgencyBand(iso(4), 'open', null, today))
  })

  it('returns null (no badge) for a final-status task even when the raw date is in the future', () => {
    expect(getUrgencyBand(iso(1), 'ingediend_afgerond', 'wettelijk', today)).toBeNull()
  })

  it('other non-final statuses (in_uitvoering, wacht_op_klant, wacht_op_goedkeuring) still get a band', () => {
    expect(getUrgencyBand(iso(-1), 'in_uitvoering', 'wettelijk', today)).toBe('te_laat')
    expect(getUrgencyBand(iso(-1), 'wacht_op_klant', 'wettelijk', today)).toBe('te_laat')
    expect(getUrgencyBand(iso(-1), 'wacht_op_goedkeuring', 'wettelijk', today)).toBe('te_laat')
  })
})

describe('daysUntil — date-boundary edge cases', () => {
  it('is unaffected by the time-of-day component of "today" (start-of-day normalisation)', () => {
    const lateInDay = new Date('2026-06-15T23:59:00')
    const earlyInDay = new Date('2026-06-15T00:00:01')
    expect(daysUntil('2026-06-16', lateInDay)).toBe(1)
    expect(daysUntil('2026-06-16', earlyInDay)).toBe(1)
  })

  it('counts correctly across a month-length boundary (31-day month to next month)', () => {
    // "20th of next month" style deadlines: from Jan 31 to Feb 20.
    expect(daysUntil('2026-02-20', new Date('2026-01-31T12:00:00'))).toBe(20)
  })

  it('counts correctly across the Feb 29 leap-year boundary', () => {
    const leapDayBefore = new Date('2028-02-28T12:00:00')
    expect(daysUntil('2028-02-29', leapDayBefore)).toBe(1)
    expect(daysUntil('2028-03-01', leapDayBefore)).toBe(2)
  })

  it('does not silently skip Feb 29 in a leap year when counting a full year out', () => {
    // 2028 is a leap year: Jan 1 -> Dec 31 is 365 days *including* Feb 29,
    // i.e. one more day than the same span in a non-leap year.
    const leapYearSpan = daysUntil('2028-12-31', new Date('2028-01-01T00:00:00'))
    const nonLeapYearSpan = daysUntil('2027-12-31', new Date('2027-01-01T00:00:00'))
    expect(leapYearSpan).toBe(365)
    expect(nonLeapYearSpan).toBe(364)
  })

  it('returns a negative number of consistent magnitude for a date in the past', () => {
    expect(daysUntil('2026-06-10', today)).toBe(-5)
  })
})

describe('formatDate', () => {
  it('returns an empty string for a null date instead of throwing', () => {
    expect(formatDate(null)).toBe('')
  })

  it('formats a real date without shifting to the previous day (timezone-safety regression)', () => {
    // Parsing a bare "YYYY-MM-DD" as UTC (new Date('2026-01-01')) instead of
    // local midnight is a classic off-by-one-day bug in timezones behind
    // UTC. formatDate appends T00:00:00 specifically to avoid this — this
    // test guards that regression.
    const formatted = formatDate('2026-01-01')
    expect(formatted).toContain('2026')
    expect(formatted).toMatch(/jan/i)
  })
})

describe('wachtDuur — hoelang wacht dit dossier al op de klant', () => {
  const nu = new Date('2026-09-04T10:00:00')

  it('zegt niets wanneer de taak niet op de klant wacht', () => {
    expect(wachtDuur(null, nu)).toBeNull()
    expect(wachtDuur(undefined, nu)).toBeNull()
  })

  it('telt in dagen zolang dat te overzien is', () => {
    expect(wachtDuur('2026-09-03T09:00:00', nu)).toBe('1 dag')
    expect(wachtDuur('2026-08-30T09:00:00', nu)).toBe('5 dagen')
    expect(wachtDuur('2026-08-23T09:00:00', nu)).toBe('12 dagen')
  })

  it('schakelt over op weken en daarna op maanden', () => {
    // "97 dagen" laat de lezer zelf rekenen; de eenheid hoort mee te schuiven.
    expect(wachtDuur('2026-08-21T09:00:00', nu)).toBe('2 weken')
    expect(wachtDuur('2026-07-24T09:00:00', nu)).toBe('6 weken')
    expect(wachtDuur('2026-05-30T09:00:00', nu)).toBe('3 maanden')
  })

  it('toont geen negatieve duur bij een stempel uit de toekomst', () => {
    // Onmogelijk, maar niet ondenkbaar bij een klok die verspringt.
    expect(wachtDuur('2026-09-05T09:00:00', nu)).toBe('sinds vandaag')
    expect(wachtDuur('2026-09-04T23:00:00', nu)).toBe('sinds vandaag')
  })
})

describe('wachtTeLang — vanaf wanneer verdient het aandacht', () => {
  const nu = new Date('2026-09-04T10:00:00')

  it('laat een klant die net gevraagd is met rust', () => {
    expect(wachtTeLang('2026-08-25T09:00:00', nu)).toBe(false)
  })

  it('slaat aan vanaf drie weken', () => {
    expect(wachtTeLang('2026-08-14T09:00:00', nu)).toBe(true)
    // Precies op de grens telt mee: 21 dagen is drie weken.
    expect(wachtTeLang('2026-08-14T23:00:00', nu)).toBe(true)
  })

  it('zegt nee wanneer er niet gewacht wordt', () => {
    expect(wachtTeLang(null, nu)).toBe(false)
  })
})
