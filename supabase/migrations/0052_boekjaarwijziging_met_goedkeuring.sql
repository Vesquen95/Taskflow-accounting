-- ============================================================
-- 0052 — Een gewijzigd boekjaareinde: signaleren, tonen, en pas
--        herberekenen als een mens ja zegt
--
-- Aanleiding: nagespeeld op een lokale kopie. Zet je een dossier van 31/12
-- naar 30/06, dan gebeurt er dit:
--
--   jaarafsluiting 2026   periode 01/01-31/12/2026   deadline 31/03/2027
--   jaarafsluiting 2027   periode 01/01-31/12/2027   deadline 31/03/2028
--   jaarafsluiting 2028   periode 01/07-30/06/2028   deadline 02/10/2028  <- nieuw
--
-- De eerste twee blijven op de OUDE datum staan. Niet omdat iemand dat zo
-- wou, maar omdat het periodelabel het jaartal is: de motor rekent de juiste
-- taak voor 2026 wél uit, botst op het bestaande label, en `on conflict do
-- nothing` gooit ze weg. Stil. Er komt geen melding, geen vlag, niets.
--
-- Voor een compliancesysteem is dat de ergste soort fout: het scherm toont
-- een deadline, die deadline is verkeerd, en niets wijst erop.
--
-- ------------------------------------------------------------
-- Waarom niet gewoon automatisch herberekenen
--
-- Het kantoor: "niet manueel maar automatisch, maar toch met een menselijke
-- goedkeuring." Terecht. Een boekjaar verzetten is zeldzaam en zelden
-- onschuldig -- er hangt meestal een overgangsboekjaar aan vast, of een
-- typfout in het formulier. In beide gevallen is stil herrekenen fout: bij
-- een typfout verplaatst het systeem deadlines die niemand wou verplaatsen,
-- en bij een echt overgangsboekjaar klopt de formule sowieso niet (zie
-- onderaan).
--
-- Dus: de wijziging wordt vastgelegd, de geraakte taken worden getoond, en
-- het herrekenen gebeurt pas als iemand erop klikt.
--
-- ------------------------------------------------------------
-- Hoe het herrekenen zelf werkt
--
-- Met wat er al staat, en zonder één regel in de motor te veranderen. De
-- unieke index `idx_task_instances_unique_period` sluit geannuleerde taken
-- uit, en `upsert_generated_task` doet dat sinds 0048 ook in zijn
-- `on conflict`-clausule. Een geannuleerde taak bezet het label dus niet
-- meer, en de generatie maakt de juiste taak alsnog aan. Nagespeeld:
--
--   2026  01/07/2025-30/06/2026  30/09/2026  open
--   2026  01/01/2026-31/12/2026  31/03/2027  geannuleerd
--   2027  01/07/2026-30/06/2027  30/09/2027  open
--   2027  01/01/2027-31/12/2027  31/03/2028  geannuleerd
--   2028  01/07/2027-30/06/2028  02/10/2028  open
--
-- Annuleren en niet verwijderen: de oude taak blijft in de geschiedenis van
-- het dossier staan, met de logregel erbij. Dat is dezelfde keuze als in
-- 0021 en om dezelfde reden.
--
-- ------------------------------------------------------------
-- Wat er NIET herrekend wordt
--
-- Alleen taken die open staan, automatisch gegenereerd zijn, in de toekomst
-- vallen en géén handmatig afgesproken deadline hebben. Al de rest wordt
-- getoond met de reden erbij, en blijft staan:
--
--   - een taak waaraan al gewerkt wordt (in uitvoering, wacht op klant, wacht
--     op goedkeuring): daar hangt werk aan vast
--   - een taak met een handmatig afgesproken datum: die afspraak is met de
--     klant gemaakt, niet door de motor
--   - een taak die al voorbij is: een gepasseerde deadline achteraf verzetten
--     maakt de historiek onwaar (0017, 0033, 0048, 0049)
--
-- ------------------------------------------------------------
-- Het echte overgangsboekjaar zit hier NIET in
--
-- Een boekjaar dat eenmalig 18 of 6 maanden duurt kan Taskflow niet
-- uitdrukken: `clients` bewaart alleen een maand en een dag, en de motor
-- neemt op vijf plaatsen aan dat een boekjaar precies één jaar duurt
-- (`v_bstart := v_be - 1 jaar + 1 dag`). Wie een overgangsjaar heeft, ziet
-- na deze migratie zijn taken tenminste op het NIEUWE ritme staan, en krijgt
-- de melding te zien -- maar het overgangsjaar zelf blijft handwerk, via een
-- handmatig afgesproken deadline per taak. Dat echt modelleren vraagt een
-- tabel met een begin- en einddatum per boekjaar per klant, en dat is een
-- eigen beslissing van het kantoor.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Welke verplichtingen hangen aan het boekjaar?
--
-- Als gegeven, niet als lijst in code: de motor, dit scherm en de fiscalist
-- lezen zo dezelfde waarheid, en een nieuwe verplichting moet een antwoord
-- geven in plaats van er stilzwijgend buiten te vallen.
--
-- Het criterium is scherp: gebruikt de tak van de motor het boekjaareinde
-- (`v_be`) om de datum uit te rekenen? Dat geldt voor de vier
-- boekjaar_relatief-types, voor de aangifte VenB en RPB (die rekenen met
-- `aangifte_deadline(v_be)`, de zevende-maandregel), en voor de neerlegging
-- van de jaarrekening (die volgt de AV). NIET voor de aangifte
-- personenbelasting: dat is een vaste kalenderdatum voor een natuurlijke
-- persoon, ongeacht welk boekjaar zijn zaak voert.
-- ------------------------------------------------------------
alter table public.obligation_types
  add column if not exists volgt_boekjaar boolean not null default false;

comment on column public.obligation_types.volgt_boekjaar is
  'True wanneer de deadline van deze verplichting uit het boekjaareinde van de klant volgt. '
  'Bepaalt welke taken herrekend moeten worden als dat boekjaareinde verandert (migratie 0052).';

update public.obligation_types
set volgt_boekjaar = true
where code in (
  'algemene_vergadering',
  'jaarafsluiting',
  'ubo_bevestiging',
  'va_venb',
  'aangifte_venb_pb',
  'aangifte_rpb',
  'neerlegging_jaarrekening'
);

-- ------------------------------------------------------------
-- 2. De melding zelf
-- ------------------------------------------------------------
create table if not exists public.boekjaar_wijzigingen (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  oude_maand smallint not null,
  oude_dag smallint not null,
  nieuwe_maand smallint not null,
  nieuwe_dag smallint not null,
  gemeld_op timestamptz not null default now(),
  gemeld_door uuid references public.employees(id),
  status text not null default 'open'
    check (status in ('open', 'doorgevoerd', 'genegeerd')),
  afgehandeld_op timestamptz,
  afgehandeld_door uuid references public.employees(id),
  aantal_herzet int,
  constraint boekjaar_wijzigingen_echt_anders
    check (oude_maand <> nieuwe_maand or oude_dag <> nieuwe_dag)
);

comment on table public.boekjaar_wijzigingen is
  'Een gewijzigd boekjaareinde wacht hier op een menselijke beslissing: de al gegenereerde '
  'jaartaken staan dan nog op het oude ritme (migratie 0052).';

-- Hoogstens één openstaande melding per dossier: een tweede wijziging voor
-- de beslissing genomen is, is dezelfde vraag met een ander eindpunt.
create unique index if not exists idx_boekjaar_wijzigingen_open_per_klant
  on public.boekjaar_wijzigingen (client_id) where status = 'open';

create index if not exists idx_boekjaar_wijzigingen_open
  on public.boekjaar_wijzigingen (status) where status = 'open';

alter table public.boekjaar_wijzigingen enable row level security;

drop policy if exists "boekjaar_wijzigingen_select" on public.boekjaar_wijzigingen;
create policy "boekjaar_wijzigingen_select" on public.boekjaar_wijzigingen
  for select using (public.can_access_client(client_id));

-- Geen insert-, update- of deletebeleid: schrijven gebeurt uitsluitend via de
-- trigger en de twee functies hieronder, allemaal security definer. Wie er
-- rechtstreeks in wil schrijven, kan dat niet.

grant select on public.boekjaar_wijzigingen to authenticated;

-- ------------------------------------------------------------
-- 3. De trigger: een wijziging melden, niet uitvoeren
-- ------------------------------------------------------------
create or replace function public.meld_boekjaarwijziging()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_open record;
begin
  if new.boekjaar_einde_maand = old.boekjaar_einde_maand
     and new.boekjaar_einde_dag = old.boekjaar_einde_dag then
    return new;
  end if;

  select * into v_open
  from public.boekjaar_wijzigingen
  where client_id = new.id and status = 'open'
  limit 1;

  if found then
    -- Er stond al een melding open. Is het dossier intussen terug op zijn
    -- oorspronkelijke boekjaar gezet, dan is er niets meer te beslissen en
    -- verdwijnt de melding. Anders schuift het eindpunt gewoon mee: het
    -- vertrekpunt blijft het boekjaar waarop de bestaande taken staan.
    if v_open.oude_maand = new.boekjaar_einde_maand
       and v_open.oude_dag = new.boekjaar_einde_dag then
      delete from public.boekjaar_wijzigingen where id = v_open.id;
    else
      update public.boekjaar_wijzigingen
      set nieuwe_maand = new.boekjaar_einde_maand,
          nieuwe_dag = new.boekjaar_einde_dag,
          gemeld_op = now(),
          gemeld_door = coalesce(public.current_employee_id(), v_open.gemeld_door)
      where id = v_open.id;
    end if;
    return new;
  end if;

  insert into public.boekjaar_wijzigingen (
    client_id, oude_maand, oude_dag, nieuwe_maand, nieuwe_dag, gemeld_door
  ) values (
    new.id, old.boekjaar_einde_maand, old.boekjaar_einde_dag,
    new.boekjaar_einde_maand, new.boekjaar_einde_dag, public.current_employee_id()
  );

  return new;
end;
$$;

comment on function public.meld_boekjaarwijziging() is
  'Legt een gewijzigd boekjaareinde vast als openstaande beslissing. Herrekent zelf niets: '
  'dat gebeurt pas na goedkeuring, via boekjaar_wijziging_toepassen() (migratie 0052).';

-- Een triggerfunctie hoort niet via de API aanroepbaar te zijn (sectie 38 van
-- de testreeks bewaakt dat).
revoke execute on function public.meld_boekjaarwijziging() from public, anon, authenticated;

drop trigger if exists trg_clients_boekjaarwijziging on public.clients;
create trigger trg_clients_boekjaarwijziging
  after update of boekjaar_einde_maand, boekjaar_einde_dag on public.clients
  for each row execute function public.meld_boekjaarwijziging();

-- ------------------------------------------------------------
-- 4. Wat er zou gebeuren: de lijst die het kantoor te zien krijgt
-- ------------------------------------------------------------
create or replace function public.boekjaar_wijziging_taken(p_wijziging_id uuid)
returns table (
  task_id uuid,
  verplichting text,
  periode_label text,
  periode_eind date,
  due_date date,
  status public.task_status,
  herzetbaar boolean,
  reden text
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_w record;
begin
  select * into v_w from public.boekjaar_wijzigingen where id = p_wijziging_id;
  if not found then
    raise exception 'Melding niet gevonden';
  end if;
  if not public.can_access_client(v_w.client_id) then
    raise exception 'Geen toegang tot dit dossier'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    ti.id,
    ot.naam,
    ti.periode_label,
    ti.periode_eind,
    ti.due_date,
    ti.status,
    (ti.status = 'open'
       and ti.due_date >= current_date
       and ti.due_date_handmatig_op is null) as herzetbaar,
    case
      when ti.due_date < current_date then
        'De deadline is al gepasseerd. Een datum achteraf verzetten maakt de historiek onwaar; deze taak blijft staan zoals ze is.'
      when ti.due_date_handmatig_op is not null then
        'Deze taak heeft een handmatig afgesproken deadline. Die afspraak is met de klant gemaakt, niet door de motor -- ze wordt niet overschreven.'
      when ti.status <> 'open' then
        'Er wordt al aan deze taak gewerkt (status: ' || ti.status::text || '). Ze blijft staan; pas de datum zelf aan als dat nodig is.'
      else null
    end
  from public.task_instances ti
  join public.obligation_types ot on ot.id = ti.obligation_type_id
  where ti.client_id = v_w.client_id
    and ti.bron_type = 'automatisch_gegenereerd'
    and ot.volgt_boekjaar
    and ti.status not in ('ingediend_afgerond', 'geannuleerd')
    -- Alleen wat nog op het OUDE ritme staat. Een taak die toevallig al op
    -- het nieuwe boekjaareinde eindigt, hoeft niet aangeraakt te worden.
    and ti.periode_eind is distinct from
        public.fiscal_year_end(v_w.nieuwe_maand, v_w.nieuwe_dag,
                               extract(year from ti.periode_eind)::int)
  order by ti.due_date, ot.naam;
end;
$$;

comment on function public.boekjaar_wijziging_taken(uuid) is
  'De taken die nog op het oude boekjaarritme staan, met per taak of ze herrekend kan worden '
  'en zo niet waarom niet. Wijzigt niets (migratie 0052).';

revoke execute on function public.boekjaar_wijziging_taken(uuid) from public, anon;
grant execute on function public.boekjaar_wijziging_taken(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. Doorvoeren, na goedkeuring
-- ------------------------------------------------------------
create or replace function public.boekjaar_wijziging_toepassen(p_wijziging_id uuid)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_w record;
  v_actor uuid := public.current_employee_id();
  v_firm uuid;
  r record;
  v_aantal int := 0;
begin
  if v_actor is null then
    raise exception 'Deze bewerking vereist een ingelogde, gekoppelde medewerker'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_w from public.boekjaar_wijzigingen where id = p_wijziging_id for update;
  if not found then
    raise exception 'Melding niet gevonden';
  end if;
  if not public.can_access_client(v_w.client_id) then
    raise exception 'Geen toegang tot dit dossier'
      using errcode = 'insufficient_privilege';
  end if;
  if v_w.status <> 'open' then
    raise exception 'Deze melding is al afgehandeld (%)', v_w.status
      using errcode = 'check_violation';
  end if;

  select firm_id into v_firm from public.clients where id = v_w.client_id;

  -- Annuleren maakt het periodelabel weer vrij: de unieke index en de
  -- `on conflict`-clausule van upsert_generated_task laten geannuleerde
  -- taken allebei buiten beschouwing. De generatie hieronder zet daardoor de
  -- juiste taak op dezelfde plaats terug.
  for r in
    select t.task_id, t.periode_label, t.due_date
    from public.boekjaar_wijziging_taken(p_wijziging_id) t
    where t.herzetbaar
  loop
    update public.task_instances set status = 'geannuleerd' where id = r.task_id;

    insert into public.task_status_log (
      task_instance_id, event_type, oude_due_date,
      actor_employee_id, trigger_bron, notitie
    ) values (
      r.task_id, 'due_date_herberekend', r.due_date,
      v_actor, 'kalender_herberekening',
      'Het boekjaareinde van dit dossier is gewijzigd van ' ||
      to_char(make_date(2000, v_w.oude_maand, v_w.oude_dag), 'DD/MM') || ' naar ' ||
      to_char(make_date(2000, v_w.nieuwe_maand, v_w.nieuwe_dag), 'DD/MM') ||
      '. Deze taak stond nog op het oude boekjaar en is vervangen door een taak op het nieuwe.'
    );
    v_aantal := v_aantal + 1;
  end loop;

  perform public.generate_task_instances_intern(v_firm, 36, 0, v_w.client_id);

  update public.boekjaar_wijzigingen
  set status = 'doorgevoerd',
      afgehandeld_op = now(),
      afgehandeld_door = v_actor,
      aantal_herzet = v_aantal
  where id = p_wijziging_id;

  return v_aantal;
end;
$$;

comment on function public.boekjaar_wijziging_toepassen(uuid) is
  'Herrekent de taken die nog op het oude boekjaarritme staan: annuleren en opnieuw laten '
  'genereren. Alleen na uitdrukkelijke goedkeuring aanroepen (migratie 0052).';

revoke execute on function public.boekjaar_wijziging_toepassen(uuid) from public, anon;
grant execute on function public.boekjaar_wijziging_toepassen(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6. Of net niet doorvoeren
-- ------------------------------------------------------------
create or replace function public.boekjaar_wijziging_negeren(p_wijziging_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_w record;
  v_actor uuid := public.current_employee_id();
begin
  if v_actor is null then
    raise exception 'Deze bewerking vereist een ingelogde, gekoppelde medewerker'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_w from public.boekjaar_wijzigingen where id = p_wijziging_id for update;
  if not found then
    raise exception 'Melding niet gevonden';
  end if;
  if not public.can_access_client(v_w.client_id) then
    raise exception 'Geen toegang tot dit dossier'
      using errcode = 'insufficient_privilege';
  end if;
  if v_w.status <> 'open' then
    raise exception 'Deze melding is al afgehandeld (%)', v_w.status
      using errcode = 'check_violation';
  end if;

  update public.boekjaar_wijzigingen
  set status = 'genegeerd', afgehandeld_op = now(), afgehandeld_door = v_actor
  where id = p_wijziging_id;
end;
$$;

comment on function public.boekjaar_wijziging_negeren(uuid) is
  'Sluit de melding zonder iets te herrekenen: de bestaande taken blijven staan zoals ze zijn '
  '(migratie 0052).';

revoke execute on function public.boekjaar_wijziging_negeren(uuid) from public, anon;
grant execute on function public.boekjaar_wijziging_negeren(uuid) to authenticated;
