import { afterEach, describe, expect, it } from 'vitest'
import { bewaarGeluid, leesGeluid, markeerBegroeting, moetBegroeten, wisBegroeting } from './begroeting'

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

  it('onthoudt het geluid, standaard uit, onder de oude sleutel', () => {
    expect(leesGeluid()).toBe(false)
    bewaarGeluid(true)
    expect(leesGeluid()).toBe(true)
    expect(window.localStorage.getItem('taskflow.weergave.stem')).toBe('aan')
    bewaarGeluid(false)
    expect(leesGeluid()).toBe(false)
  })
})
