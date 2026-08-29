import { supabase } from './supabase'
import type { ObligationType } from '../types'

/** Wat het kantoor per verplichting kiest bij het opslaan van een klant.
 *  Alles wordt in één keer ingevuld — zie docs/PLAN.md §10. */
export interface ObligationSelection {
  obligation_type_id: string
  gekozen: boolean
  standaard_toegewezen_medewerker_id: string
  parameters: Record<string, unknown>
}

/** Een leeg vinkje per verplichtingstype, om een nieuw formulier mee te vullen. */
export function legeSelecties(types: ObligationType[]): ObligationSelection[] {
  return types.map((t) => ({
    obligation_type_id: t.id,
    gekozen: false,
    standaard_toegewezen_medewerker_id: '',
    parameters: {},
  }))
}

/** btw_aangifte en btw_klantenlisting worden door de database beheerd op basis
 *  van het btw-regime van de klant (trigger sync_btw_obligations, migratie
 *  0004). Ze hier ook aanraken zou elkaar tegenwerken. */
const AFGELEID_UIT_BTW_REGIME = ['btw_aangifte', 'btw_klantenlisting']

interface BestaandeVerplichting {
  id: string
  obligation_type_id: string
  actief: boolean
  geldig_tot: string | null
  parameters: Record<string, unknown> | null
  standaard_toegewezen_medewerker_id: string | null
}

function gelijk(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

/**
 * Brengt de verplichtingen van een klant in lijn met wat er in het formulier
 * staat, en laat de database daarna de taken bijwerken.
 *
 * Het kantoor wil dit bij het OPSLAAN, niet via een aparte knop (docs/PLAN.md
 * §10): een verplichting erbij levert meteen haar toekomstige taken op, een
 * verplichting eraf annuleert de open toekomstige taken ervan. Wat in
 * uitvoering of ingediend is blijft staan — dat is werk dat gebeurd is.
 *
 * Verwijderen bestaat niet: een afgezette verplichting wordt afgesloten met
 * geldig_tot, zodat de geschiedenis van het dossier blijft kloppen.
 */
export async function saveClientObligations(
  clientId: string,
  selections: ObligationSelection[],
  codePerTypeId: Record<string, string>
): Promise<number> {
  const { data, error } = await supabase
    .from('client_obligations')
    .select('id, obligation_type_id, actief, geldig_tot, parameters, standaard_toegewezen_medewerker_id')
    .eq('client_id', clientId)
  if (error) throw error

  const bestaand = (data ?? []) as BestaandeVerplichting[]
  const vandaag = new Date().toISOString().slice(0, 10)

  const loopt = (r: BestaandeVerplichting) =>
    r.actief && (r.geldig_tot === null || r.geldig_tot >= vandaag)

  for (const sel of selections) {
    if (AFGELEID_UIT_BTW_REGIME.includes(codePerTypeId[sel.obligation_type_id] ?? '')) continue

    const huidig = bestaand.find((r) => r.obligation_type_id === sel.obligation_type_id && loopt(r))
    const toegewezen = sel.standaard_toegewezen_medewerker_id || null
    const parameters = Object.keys(sel.parameters).length > 0 ? sel.parameters : {}

    if (sel.gekozen && !huidig) {
      const { error: err } = await supabase.from('client_obligations').insert({
        client_id: clientId,
        obligation_type_id: sel.obligation_type_id,
        actief: true,
        geldig_vanaf: vandaag,
        parameters,
        standaard_toegewezen_medewerker_id: toegewezen,
      })
      if (err) throw err
    } else if (sel.gekozen && huidig) {
      const parametersGewijzigd = !gelijk(huidig.parameters, parameters)
      const toegewezenGewijzigd = (huidig.standaard_toegewezen_medewerker_id ?? null) !== toegewezen
      if (parametersGewijzigd || toegewezenGewijzigd) {
        const { error: err } = await supabase
          .from('client_obligations')
          .update({ parameters, standaard_toegewezen_medewerker_id: toegewezen })
          .eq('id', huidig.id)
        if (err) throw err
      }
    } else if (!sel.gekozen && huidig) {
      // Afsluiten, niet verwijderen: geldig_tot vandaag zodat de historiek
      // blijft staan. De database annuleert daarna de open toekomstige taken.
      const { error: err } = await supabase
        .from('client_obligations')
        .update({ actief: false, geldig_tot: vandaag })
        .eq('id', huidig.id)
      if (err) throw err
    }
  }

  return syncClientTasks(clientId)
}

/**
 * Zet de taken van één klant gelijk met zijn lopende verplichtingen
 * (migratie 0021). De trigger sync_btw_obligations maakt bij het aanmaken wel
 * de btw-verplichtingen aan, maar géén taakinstanties — die komen hiervandaan.
 * Staat apart zodat het klantformulier én de Excel-import dezelfde stap doen.
 *
 * @returns het aantal nieuw aangemaakte taken.
 */
export async function syncClientTasks(clientId: string): Promise<number> {
  const { data: aantal, error: syncErr } = await supabase.rpc('sync_client_tasks', {
    p_client_id: clientId,
  })
  if (syncErr) throw syncErr
  return (aantal as number) ?? 0
}

/** De selecties zoals ze nu in de database staan, om het formulier mee te
 *  vullen wanneer een bestaande klant bewerkt wordt. */
export async function loadClientObligations(clientId: string): Promise<ObligationSelection[]> {
  const { data, error } = await supabase
    .from('client_obligations')
    .select('obligation_type_id, actief, geldig_tot, parameters, standaard_toegewezen_medewerker_id')
    .eq('client_id', clientId)
  if (error) throw error

  const vandaag = new Date().toISOString().slice(0, 10)
  return ((data ?? []) as BestaandeVerplichting[])
    .filter((r) => r.actief && (r.geldig_tot === null || r.geldig_tot >= vandaag))
    .map((r) => ({
      obligation_type_id: r.obligation_type_id,
      gekozen: true,
      standaard_toegewezen_medewerker_id: r.standaard_toegewezen_medewerker_id ?? '',
      parameters: r.parameters ?? {},
    }))
}
