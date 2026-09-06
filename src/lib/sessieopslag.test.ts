import { beforeEach, describe, expect, it } from 'vitest'
import {
  bewaarVerloopreden,
  leesActiviteit,
  leesLangeSessie,
  leesStart,
  leesVerloopreden,
  schrijfActiviteit,
  schrijfLangeSessie,
  schrijfStart,
  wisSessiestempels,
  wisVerloopreden,
} from './sessieopslag'

beforeEach(() => {
  window.localStorage.clear()
})

describe('de stempels van de sessie', () => {
  it('geeft het aanmeldmoment terug aan wie het geschreven heeft', () => {
    schrijfStart('u-1', 1_700_000_000_000)
    expect(leesStart('u-1')).toBe(1_700_000_000_000)
  })

  it('geeft niets terug aan een andere gebruiker', () => {
    // Een gedeelde pc: wie na jou aanmeldt mag jouw klok niet erven.
    schrijfStart('u-1', 1_700_000_000_000)
    expect(leesStart('u-2')).toBeNull()
  })

  it('slikt rommel in de opslag zonder te struikelen', () => {
    window.localStorage.setItem('taskflow.sessie.start', 'zonder-scheiding')
    expect(leesStart('u-1')).toBeNull()
    window.localStorage.setItem('taskflow.sessie.start', 'u-1|geen-getal')
    expect(leesStart('u-1')).toBeNull()
    window.localStorage.setItem('taskflow.sessie.activiteit', 'ooit')
    expect(leesActiviteit()).toBeNull()
  })

  it('houdt de keuze om open te blijven bij de gebruiker die ze maakte', () => {
    schrijfLangeSessie('u-1', true)
    expect(leesLangeSessie('u-1')).toBe(true)
    expect(leesLangeSessie('u-2')).toBe(false)

    schrijfLangeSessie('u-1', false)
    expect(leesLangeSessie('u-1')).toBe(false)
  })

  it('wist bij een wissel van sessie ook de keuze om open te blijven', () => {
    // Anders erft de volgende aanmelding stilzwijgend een scherm dat
    // zichzelf niet meer afsluit.
    schrijfStart('u-1', 1_700_000_000_000)
    schrijfActiviteit(1_700_000_000_000)
    schrijfLangeSessie('u-1', true)

    wisSessiestempels()

    expect(leesStart('u-1')).toBeNull()
    expect(leesActiviteit()).toBeNull()
    expect(leesLangeSessie('u-1')).toBe(false)
  })
})

describe('de reden waarom je afgemeld werd', () => {
  it('blijft liggen tot ze gewist wordt', () => {
    bewaarVerloopreden('sessieduur')
    // Twee keer lezen mag: het aanmeldscherm doet dat in ontwikkelmodus ook.
    expect(leesVerloopreden()).toBe('sessieduur')
    expect(leesVerloopreden()).toBe('sessieduur')

    wisVerloopreden()
    expect(leesVerloopreden()).toBeNull()
  })

  it('overleeft het wissen van de stempels', () => {
    // Het afmelden wist de stempels en zet dan de reden; die volgorde mag
    // niet uitmaken voor wat het aanmeldscherm te zien krijgt.
    bewaarVerloopreden('inactiviteit')
    wisSessiestempels()
    expect(leesVerloopreden()).toBe('inactiviteit')
  })

  it('gelooft geen onzin uit de opslag', () => {
    window.localStorage.setItem('taskflow.sessie.reden', 'iets-anders')
    expect(leesVerloopreden()).toBeNull()
  })
})
