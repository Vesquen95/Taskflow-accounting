// Domain types for Taskflow v1 (Belgian accounting-firm compliance tool).
// Mirrors the schema created in supabase/migrations/0003_domain_schema.sql
// onward. Field names are kept in Dutch to match the database columns 1:1
// (the whole product is NL-only in v1, see docs/PLAN.md §1).

export type EmployeeRol = 'medewerker' | 'kantoorbeheerder'

export type BtwRegime = 'geen' | 'periodieke_aangever' | 'vrijgesteld_kleine_onderneming'
export type BtwFrequentie = 'maand' | 'kwartaal'

export type ObligationCategorie = 'wettelijk' | 'service'
export type DeadlineMechanisme =
  | 'formule'
  | 'boekjaar_relatief'
  | 'jaarlijkse_kalender'
  | 'afgeleid_van_gebeurtenis'

export type TaskStatus =
  | 'open'
  | 'in_uitvoering'
  | 'wacht_op_klant'
  | 'wacht_op_goedkeuring'
  | 'ingediend_afgerond'
  | 'geannuleerd'

export type TaakBron = 'automatisch_gegenereerd' | 'handmatig_adhoc'

export type LogEventType =
  | 'status_wijziging'
  | 'due_date_herberekend'
  | 'toewijzing_gewijzigd'
  | 'review_gemarkeerd'
  | 'review_afgehandeld'
  | 'goedkeuring_gegeven'
  | 'goedkeuring_geweigerd'
  // Toegevoegd in migratie 0012: aanmaak en inhoudelijke wijziging van een
  // taakinstantie laten voortaan ook een spoor na.
  | 'taak_aangemaakt'
  | 'taak_inhoud_gewijzigd'

export type LogTriggerBron = 'medewerker_actie' | 'kalender_herberekening' | 'av_opvolging_automatisch'

export interface Employee {
  id: string
  firm_id: string
  auth_user_id: string | null
  naam: string
  email: string
  rol: EmployeeRol
  /** Leeg = nog niet ingevuld; dan blijft mag_goedkeuren staan zoals het met
   *  de hand gezet was. */
  niveau: MedewerkerNiveau | null
  mag_goedkeuren: boolean
  actief: boolean
  created_at: string
}

/** Een team van het kantoor: Aalst, Zaventem 1/2/3, Antwerpen, Gosselies.
 *
 *  De afscherming loopt PER TEAM en niet per vestiging: dat ZAV1 en ZAV2 op
 *  hetzelfde adres zitten, geeft ze geen toegang tot elkaars dossiers. De
 *  vestiging staat er alleen bij om te kunnen groeperen in overzichten. */
export interface Team {
  id: string
  firm_id: string
  code: string
  naam: string
  vestiging: string
  actief: boolean
  created_at: string
}

/** Rechtspersoon of natuurlijke persoon.
 *
 *  De breuklijn ligt niet waar je ze verwacht: een EENMANSZAAK is al een
 *  natuurlijke persoon -- met btw en een ondernemingsnummer, maar zonder
 *  algemene vergadering en zonder vennootschapsbelasting. Het onderscheid is
 *  dus natuurlijk persoon versus rechtspersoon, niet "privé versus zaak"
 *  (migratie 0041). */
export type Klantsoort = 'rechtspersoon' | 'natuurlijk_persoon'

/** De beroepsgraad. Vanaf manager mag je aangiftes goedkeuren; dat recht volgt
 *  uit de graad en wordt niet meer per persoon aangevinkt (migratie 0042). */
export type MedewerkerNiveau =
  | 'junior'
  | 'senior'
  | 'supervisor'
  | 'manager'
  | 'director'
  | 'partner'

export interface Client {
  id: string
  firm_id: string
  naam: string
  klantsoort: Klantsoort
  ondernemingsnummer: string | null
  rechtsvorm: string | null
  boekjaar_einde_maand: number
  boekjaar_einde_dag: number
  /** Datum van de ontbinding: vanaf hier staat het dossier in vereffening.
   *  De verplichtingen lopen gewoon door (migratie 0054). */
  ontbonden_op?: string | null
  /** Datum van de sluiting van de vereffening: vanaf hier houdt alles op. */
  vereffend_op?: string | null
  btw_regime: BtwRegime
  btw_aangifte_frequentie: BtwFrequentie | null
  mandataris: boolean
  vertrouwelijk: boolean
  standaard_verantwoordelijke_id: string | null
  /** Het team dat dit dossier draait. Leeg = nog niet ingedeeld; zo'n dossier
   *  blijft voor iedereen van het kantoor zichtbaar, zodat het opvalt in
   *  plaats van te verdwijnen (migratie 0038/0039). */
  team_id: string | null
  actief: boolean
  created_at: string
}

/** De stromen waarin het kantoor zijn werk afwerkt (migratie 0022, uitgebreid
 *  met 'fiches' in 0027; docs/PLAN.md §10). Ad-hoc taken hebben geen
 *  verplichtingstype en dus geen werkstroom; die vormen in de app een laatste
 *  ingang. */
export type Werkstroom =
  | 'btw'
  | 'afsluiting'
  | 'vennootschapsbelasting'
  | 'fiches'
  | 'rapportering'

export interface ObligationType {
  id: string
  code: string
  naam: string
  categorie: ObligationCategorie
  deadline_mechanisme: DeadlineMechanisme
  standaard_periodiciteit: string | null
  werkstroom: Werkstroom
}

export interface ClientObligation {
  id: string
  client_id: string
  obligation_type_id: string
  actief: boolean
  geldig_vanaf: string
  geldig_tot: string | null
  parameters: Record<string, unknown>
  standaard_toegewezen_medewerker_id: string | null
  created_at: string
}

export interface TaskInstance {
  id: string
  client_id: string
  obligation_type_id: string | null
  client_obligation_id: string | null
  periode_label: string | null
  periode_start: string | null
  periode_eind: string | null
  due_date: string
  due_date_wettelijk: string
  due_date_verschoven: boolean
  /** Gezet zodra iemand de deadline handmatig verzet; de kalenderpijplijn
   *  overschrijft zo'n afspraak niet meer stil (migratie 0013). */
  due_date_handmatig_op: string | null
  status: TaskStatus
  /** Wie de taak op zich genomen heeft. Leeg = nog niemand: ze ligt in de bak
   *  van het team dat het dossier draait (migratie 0040). */
  toegewezen_medewerker_id: string | null
  voorloper_taak_id: string | null
  bron_type: TaakBron
  voorlopige_datum: boolean
  vereist_goedkeuring: boolean
  goedgekeurd_door: string | null
  goedgekeurd_op: string | null
  review_vereist: boolean
  review_reden: string | null
  title: string | null
  description: string | null
  afgerond_op: string | null
  /** Sinds wanneer deze taak op de klant wacht; leeg als ze dat niet doet.
   *  Gezet en gewist door de statusmachine (migratie 0047). */
  wacht_op_klant_sinds: string | null
  /** Deze periode was er niets aan te geven. De taak staat op geannuleerd,
   *  maar de generatie maakt haar niet opnieuw aan (migratie 0058). */
  niet_van_toepassing?: boolean
  niet_van_toepassing_reden?: string | null
  created_at: string
  updated_at: string
}

/** task_instances joined with the display fields views commonly need. */
export interface TaskInstanceWithRelations extends TaskInstance {
  client: Pick<Client, 'id' | 'naam' | 'vertrouwelijk' | 'actief' | 'team_id'>
  obligation_type: Pick<ObligationType, 'id' | 'code' | 'naam' | 'categorie' | 'werkstroom'> | null
  toegewezen_medewerker: Pick<Employee, 'id' | 'naam'> | null
}

export interface TaskStatusLog {
  id: string
  task_instance_id: string
  event_type: LogEventType
  oud_status: TaskStatus | null
  nieuw_status: TaskStatus | null
  oude_due_date: string | null
  nieuwe_due_date: string | null
  actor_employee_id: string
  trigger_bron: LogTriggerBron
  notitie: string | null
  created_at: string
}

/** client_change_log: het wijzigingslog van een klantdossier. `veld` is
 *  vrij tekst met een vaste set waarden (zie migratie 0011/0013), inclusief
 *  'toegang_vertrouwelijk_verleend'. */
export interface ClientChangeLogEntry {
  id: string
  client_id: string
  veld: string
  oude_waarde: string | null
  nieuwe_waarde: string | null
  actor_employee_id: string
  created_at: string
  actor: Pick<Employee, 'id' | 'naam'> | null
}

export interface LegalCalendarEntry {
  id: string
  obligation_type_id: string
  jaar: number
  scope: string | null
  deadline_datum: string
  is_override: boolean
  bron: string | null
  publicatiedatum: string | null
  aangemaakt_door: string
  gewijzigd_door: string
  created_at: string
  updated_at: string
}

export interface PublicHoliday {
  id: string
  jaar: number
  datum: string
  omschrijving: string
  aangemaakt_door: string
  gewijzigd_door: string
  created_at: string
  updated_at: string
  /** Append-only correctiepatroon (migratie 0011/0012): een foutieve
   * feestdag wordt ingetrokken, nooit overschreven of verwijderd. Een
   * ingetrokken feestdag telt niet meer mee in next_business_day(). */
  ingetrokken: boolean
  ingetrokken_door: string | null
  ingetrokken_op: string | null
  ingetrokken_reden: string | null
}

/** Urgency band used for badge colouring/sorting (client-side only, see
 * src/lib/urgency.ts). Not a DB concept — the DB stores real dates and the
 * status flow; "how urgent does this look right now" is a display concern. */
export type UrgencyBand = 'te_laat' | 'vandaag' | 'deze_week' | 'binnenkort' | 'later' | null

/** Eén ronde horizon-onderhoud (migratie 0025). De maandelijkse job schuift de
 *  generatiehorizon op en vult de feestdagenkalender aan; zonder dit spoor zou
 *  dat volledig onzichtbaar gebeuren. */
export interface OnderhoudLog {
  id: string
  gestart_op: string
  geeindigd_op: string | null
  aanleiding: string
  nieuwe_taken: number | null
  nieuwe_feestdagen: number | null
  /** Gevuld wanneer de ronde afbrak. Een lege en een mislukte ronde tellen
   *  allebei nul taken; dit veld houdt ze uit elkaar. */
  fout: string | null
}
