import { describe, expect, it } from 'vitest'
import { isAfgesloten, telTeAnnulerenTaken } from './klantArchief'
import type { TaskStatus } from '../types'

const alleStatussen: TaskStatus[] = [
  'open',
  'in_uitvoering',
  'wacht_op_klant',
  'wacht_op_goedkeuring',
  'ingediend_afgerond',
  'geannuleerd',
]

describe('klantArchief — welke taken een archivering raakt', () => {
  // Deze regel staat op twee plaatsen: in de trigger van migratie 0026 en
  // hier, omdat het scherm het aantal moet kunnen noemen vóór het archiveren.
  // Loopt dit uiteen, dan belooft de bevestiging iets anders dan de databank
  // doet — vandaar deze test op de volledige statuslijst.
  it('beschouwt enkel ingediend_afgerond en geannuleerd als afgesloten', () => {
    expect(alleStatussen.filter(isAfgesloten)).toEqual(['ingediend_afgerond', 'geannuleerd'])
  })

  it('telt elke niet-afgesloten taak mee, ongeacht de bron', () => {
    const taken = alleStatussen.map((status) => ({ status }))
    expect(telTeAnnulerenTaken(taken)).toBe(4)
  })

  it('telt nul wanneer er niets meer openstaat', () => {
    expect(telTeAnnulerenTaken([])).toBe(0)
    expect(telTeAnnulerenTaken([{ status: 'ingediend_afgerond' }, { status: 'geannuleerd' }])).toBe(0)
  })
})
