/**
 * Hoe lang een sessie mag duren, en wanneer ze afloopt.
 *
 * Aanleiding: het kantoor merkte dat je aangemeld blijft. Dat klopte -- de
 * sessie werd bewaard en het token vernieuwde zichzelf eindeloos. Voor een
 * kantoor met vertrouwelijke dossiers is een scherm dat 's avonds nog open
 * staat op een onbeheerde pc een reëel probleem.
 *
 * Twee grenzen, want ze vangen verschillende dingen op:
 *
 *   inactiviteit   je loopt weg van je bureau. Dit is de belangrijkste: het
 *                  scherm sluit zichzelf af terwijl jij er niet bent.
 *   sinds aanmelden  een absolute bovengrens. Ook wie de hele dag doorwerkt,
 *                  meldt zich één keer per werkdag opnieuw aan.
 *
 * Wat dit NIET doet, en dat hoort erbij: afmelden in de browser maakt het
 * token niet ongeldig aan de kant van de server. Wie het token uit de opslag
 * van de browser haalt, kan er nog mee werken tot het verloopt. De echte
 * bovengrens daarvoor staat in de sessie-instellingen van Supabase Auth
 * (time-box en inactivity timeout); die twee horen samen gezet te worden.
 */

/** Na zoveel stilte wordt er afgemeld. */
export const INACTIVITEIT_MINUTEN = 30

/** Zoveel minuten vóór het afmelden verschijnt de waarschuwing. */
export const WAARSCHUWING_MINUTEN = 2

/** Absolute bovengrens vanaf het aanmelden: één werkdag. */
export const SESSIE_UREN = 12

export type Sessiestand = 'actief' | 'waarschuwing' | 'verlopen'

/** Waarom de sessie afliep. Bepaalt wat het aanmeldscherm erover zegt. */
export type Verloopreden = 'inactiviteit' | 'sessieduur'

export interface Sessieoordeel {
  stand: Sessiestand
  /** Alleen gevuld bij 'waarschuwing' en 'verlopen'. */
  reden?: Verloopreden
  /** Seconden tot het afmelden. Nul of minder bij 'verlopen'. */
  secondenResterend: number
}

const MIN = 60 * 1000
const UUR = 60 * MIN

/**
 * Beoordeelt de sessie op één moment.
 *
 * Bewust een zuivere functie met de tijd als argument: zo is elke grens te
 * testen zonder te wachten, en kan het scherm niet iets anders beweren dan
 * wat hier uitgerekend wordt.
 */
export function beoordeelSessie(
  aangemeldOp: number,
  laatsteActiviteit: number,
  nu: number
): Sessieoordeel {
  const totInactief = laatsteActiviteit + INACTIVITEIT_MINUTEN * MIN - nu
  const totMax = aangemeldOp + SESSIE_UREN * UUR - nu

  // De strengste van de twee wint: wie de hele dag doorwerkt loopt tegen de
  // absolute grens, wie wegloopt tegen de inactiviteit.
  const reden: Verloopreden = totMax < totInactief ? 'sessieduur' : 'inactiviteit'
  const resterend = Math.min(totInactief, totMax)

  if (resterend <= 0) {
    return { stand: 'verlopen', reden, secondenResterend: 0 }
  }
  if (resterend <= WAARSCHUWING_MINUTEN * MIN) {
    return { stand: 'waarschuwing', reden, secondenResterend: Math.ceil(resterend / 1000) }
  }
  return { stand: 'actief', secondenResterend: Math.ceil(resterend / 1000) }
}

/** "1:30" — voor de aftelling in de waarschuwing. */
export function telAf(seconden: number): string {
  const veilig = Math.max(0, seconden)
  const m = Math.floor(veilig / 60)
  const s = veilig % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export const VERLOOP_UITLEG: Record<Verloopreden, string> = {
  inactiviteit: `Je bent afgemeld omdat er ${INACTIVITEIT_MINUTEN} minuten niets gebeurde. Dat is met opzet: op een onbeheerd scherm staan de dossiers van het kantoor open.`,
  sessieduur: `Je bent afgemeld omdat een aanmelding ${SESSIE_UREN} uur meegaat. Meld je opnieuw aan om verder te werken.`,
}
