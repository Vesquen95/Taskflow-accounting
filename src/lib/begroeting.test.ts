import { afterEach, describe, expect, it } from 'vitest'
import { markeerBegroeting, moetBegroeten, wisBegroeting } from './begroeting'

afterEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe('begroeting', () => {
  it('begroet één keer per aanmelding', () => {
    expect(moetBegroeten()).toBe(false)
    markeerBegroeting()
    expect(moetBegroeten()).toBe(true)
    wisBegroeting()
    expect(moetBegroeten()).toBe(false)
  })
})
