import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDueDate, getDueStatus } from './dueDate'

// Fix "now" so due-status math is deterministic regardless of when the
// suite runs. 2026-08-24 is a Monday.
const FIXED_NOW = new Date('2026-08-24T12:00:00')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getDueStatus', () => {
  it('returns null when there is no due date', () => {
    expect(getDueStatus(null)).toBeNull()
  })

  it('returns "overdue" for a date in the past', () => {
    expect(getDueStatus('2026-08-23')).toBe('overdue')
  })

  it('treats a date several days in the past as still "overdue" (not some other bucket)', () => {
    expect(getDueStatus('2026-08-01')).toBe('overdue')
  })

  it('returns "today" for the current date', () => {
    expect(getDueStatus('2026-08-24')).toBe('today')
  })

  it('returns "tomorrow" for the next calendar day', () => {
    expect(getDueStatus('2026-08-25')).toBe('tomorrow')
  })

  it('returns "upcoming" for two days out', () => {
    expect(getDueStatus('2026-08-26')).toBe('upcoming')
  })

  it('returns "upcoming" for a date far in the future', () => {
    expect(getDueStatus('2027-01-01')).toBe('upcoming')
  })

  it('is only sensitive to the calendar date, not the time of day "now" is', () => {
    // "now" is 2026-08-24T12:00:00; a due date of today at midnight
    // should still read as "today", not "overdue".
    expect(getDueStatus('2026-08-24')).toBe('today')
  })

  it('handles the overdue/today boundary correctly one second before midnight', () => {
    vi.setSystemTime(new Date('2026-08-24T23:59:59'))
    expect(getDueStatus('2026-08-24')).toBe('today')
    expect(getDueStatus('2026-08-23')).toBe('overdue')
    expect(getDueStatus('2026-08-25')).toBe('tomorrow')
  })

  it('handles the today/tomorrow boundary right after midnight', () => {
    vi.setSystemTime(new Date('2026-08-25T00:00:01'))
    expect(getDueStatus('2026-08-24')).toBe('overdue')
    expect(getDueStatus('2026-08-25')).toBe('today')
    expect(getDueStatus('2026-08-26')).toBe('tomorrow')
  })

  it('handles a due date across a month boundary', () => {
    vi.setSystemTime(new Date('2026-08-31T09:00:00'))
    expect(getDueStatus('2026-09-01')).toBe('tomorrow')
  })

  it('handles a due date across a year boundary', () => {
    vi.setSystemTime(new Date('2026-12-31T09:00:00'))
    expect(getDueStatus('2027-01-01')).toBe('tomorrow')
    expect(getDueStatus('2026-12-31')).toBe('today')
  })
})

describe('formatDueDate', () => {
  it('returns an empty string when there is no due date', () => {
    expect(formatDueDate(null)).toBe('')
  })

  it('formats a due date using the Dutch locale', () => {
    // toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
    const formatted = formatDueDate('2026-08-24')
    expect(formatted).toContain('2026')
    expect(formatted).toContain('24')
  })
})
