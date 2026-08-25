-- Taskflow v1 — kolom-niveau integriteit & audit hardening.
--
-- Aanleiding: de security-review van 2026-08-25 voerde echte schrijfacties
-- uit als rol `authenticated` (niet enkel policies lezen) en toonde aan dat
-- de RLS wel rij-gebaseerd maar niet kolom-gebaseerd is: wie een rij mag
-- zien, mag er zowat elk veld van wijzigen, en de triggers dekten net de
-- compliance-kritische kolommen niet.
--
-- Deze migratie is additief: 0003-0010 zijn al toegepast en worden NIET
-- gewijzigd. Alles hieronder is een `create or replace` van een bestaande
-- functie, een nieuw object, of een policy/trigger die opnieuw wordt
-- gedefinieerd.
--
-- Opgeloste bevindingen:
--   F-3 (High)   goedkeuringsstap volledig te omzeilen + goedgekeurd_door
--                vervalsbaar  -> expliciete overgangs-whitelist, bevroren
--                kolommen, trigger-eigen goedkeurings-/afrondingsstempels.
--   F-4 (High)   due_date stil wijzigbaar zonder logregel -> altijd
--                gelogd; due_date_wettelijk enkel via de kalenderpijplijn.
--   F-5 (High)   public_holidays UPDATE herberekende niets -> tabel wordt
--                append-only (UPDATE-policy weg), correctie verloopt via
--                intrekken (`ingetrokken`) + nieuwe rij, mét herberekening
--                en logregel.
--   F-7 (Medium) deadline-bepalende klantvelden ongeaudit wijzigbaar ->
--                generiek client_change_log + audittrigger op
--                client_obligations.
--   F-8 (Medium) laatste kantoorbeheerder kon zichzelf deactiveren.
--   F-9 (Medium) taak toewijsbaar aan iemand van een ander kantoor.
--   F-1 (Medium) laatste zelf-refererende policy (task_instances).
--   F-12 (Low)   can_view_client()/can_access_client() EXECUTE-baar door
--                PUBLIC.
--   F-13 (Low)   client_obligations.parameters ongelimiteerde jsonb.
--
-- NIET in scope (docs/PLAN.md §8): firm-scoping van legal_calendar /
-- public_holidays. De instance is single-tenant; het gedeelde karakter van
-- die referentietabellen blijft zoals het is.

-- ============================================================
-- 0. Pijplijn-markering
--
-- Verschillende bevindingen hieronder hebben dezelfde vraag nodig: "komt
-- deze schrijfactie van de kalender-/AV-pijplijn, of van een medewerker die
-- rechtstreeks een kolom aanpast?". De pijplijnfuncties draaien als
-- SECURITY DEFINER maar wel namens een gewone ingelogde medewerker, dus
-- current_user/current_employee_id() kunnen dat onderscheid niet maken.
--
-- Daarom zetten de pijplijnfuncties expliciet een transactie-lokale vlag
-- rond hun eigen updates. Een PostgREST-client kan die vlag niet zetten:
-- er is geen RPC die dat doet, elke request draait in een eigen transactie,
-- en de pijplijnfuncties zetten hem aan het einde weer af.
-- ============================================================
create or replace function public.taskflow_pipeline_active()
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce(current_setting('taskflow.pipeline', true), 'off') = 'on';
$$;

revoke execute on function public.taskflow_pipeline_active() from public, anon;
grant execute on function public.taskflow_pipeline_active() to authenticated;

-- ============================================================
-- 1. F-5 — public_holidays wordt append-only, net als legal_calendar
--
-- Ontwerpkeuze (zie samenvatting): legal_calendar is append-only en
-- corrigeert via nieuwe is_override-rijen. Feestdagen kunnen dat patroon
-- niet 1-op-1 volgen — een feestdag is een unieke datum, een "nieuwe rij
-- voor dezelfde datum" zegt niets over of die datum nu wel of niet een
-- feestdag is. Daarom hetzelfde principe in de feestdag-vorm:
--
--   * de feitelijke inhoud van een rij (datum, omschrijving, jaar) is
--     onveranderlijk — de UPDATE-policy verdwijnt, de app kan geen enkele
--     kolom meer overschrijven;
--   * een foute feestdag wordt INGETROKKEN (nooit verwijderd of
--     overschreven): retract_public_holiday() zet `ingetrokken`, met
--     wie/wanneer/waarom, zodat de historie zichtbaar blijft;
--   * de juiste datum wordt daarna als NIEUWE rij toegevoegd — precies de
--     legal_calendar-flow;
--   * zowel toevoegen als intrekken herberekent de due_date van alle
--     open taakinstanties en logt elke verschuiving.
-- ============================================================
alter table public.public_holidays
  add column if not exists ingetrokken boolean not null default false,
  add column if not exists ingetrokken_door uuid references public.employees(id),
  add column if not exists ingetrokken_op timestamptz,
  add column if not exists ingetrokken_reden text
    check (ingetrokken_reden is null or char_length(ingetrokken_reden) <= 500);

comment on column public.public_holidays.ingetrokken is
  'Append-only correctiepatroon (migratie 0011): een foutieve feestdag wordt ingetrokken via '
  'retract_public_holiday(), nooit overschreven of verwijderd. De juiste datum komt als nieuwe rij binnen.';

-- De unieke datum-constraint moet partieel worden: een ingetrokken
-- feestdag mag niet in de weg staan wanneer dezelfde datum later toch
-- (opnieuw) als feestdag wordt ingevoerd.
do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.public_holidays'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) ilike '%(datum)%';
  if v_conname is not null then
    execute format('alter table public.public_holidays drop constraint %I', v_conname);
  end if;
end $$;

create unique index if not exists idx_public_holidays_datum_actief
  on public.public_holidays(datum)
  where not ingetrokken;

-- next_business_day() mag ingetrokken feestdagen niet meer meetellen.
create or replace function public.next_business_day(p_date date)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
  d date := p_date;
  v_guard int := 0;
begin
  loop
    v_guard := v_guard + 1;
    if v_guard > 60 then
      raise exception 'next_business_day: kon geen werkdag vinden binnen 60 dagen na %', p_date;
    end if;
    if extract(isodow from d) < 6 and not exists (
      select 1 from public.public_holidays h where h.datum = d and not h.ingetrokken
    ) then
      return d;
    end if;
    d := d + 1;
  end loop;
end;
$$;

revoke execute on function public.next_business_day(date) from public, anon;
grant execute on function public.next_business_day(date) to authenticated;

-- Herberekening bij zowel toevoegen als intrekken van een feestdag.
-- Vervangt recalc_due_dates_on_new_holiday() (0004), die enkel op INSERT
-- stond en dus geen enkel spoor naliet wanneer een feestdag nadien werd
-- gecorrigeerd.
create or replace function public.recalc_due_dates_after_holiday_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_new_due date;
  v_actor uuid;
  v_notitie text;
begin
  if tg_op = 'UPDATE' then
    if new.ingetrokken is not distinct from old.ingetrokken then
      return new;
    end if;
    v_actor := coalesce(new.ingetrokken_door, new.gewijzigd_door, new.aangemaakt_door);
    v_notitie := 'Herberekend n.a.v. ingetrokken feestdag ' || to_char(new.datum, 'DD/MM/YYYY');
  else
    v_actor := new.aangemaakt_door;
    v_notitie := 'Herberekend n.a.v. nieuwe feestdag ' || to_char(new.datum, 'DD/MM/YYYY');
  end if;

  -- Markeer deze updates als pijplijn-schrijfacties: enkel hier mag
  -- due_date/due_date_wettelijk verschuiven zonder "handmatig"-logregel
  -- (de logregel hieronder is preciezer).
  perform set_config('taskflow.pipeline', 'on', true);

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk
    from public.task_instances ti
    where ti.status = 'open'
  loop
    v_new_due := public.next_business_day(r.due_date_wettelijk);
    if v_new_due is distinct from r.due_date then
      update public.task_instances set due_date = v_new_due where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date, v_new_due, v_actor, 'kalender_herberekening', v_notitie
      );
    end if;
  end loop;

  perform set_config('taskflow.pipeline', 'off', true);
  return new;
end;
$$;

drop trigger if exists trg_public_holidays_recalc on public.public_holidays;
drop trigger if exists trg_public_holidays_recalc_change on public.public_holidays;
create trigger trg_public_holidays_recalc_change
  after insert or update of ingetrokken on public.public_holidays
  for each row
  execute function public.recalc_due_dates_after_holiday_change();

-- De UPDATE-policy verdwijnt: de app kan geen enkele kolom van een
-- feestdag meer overschrijven (F-5). Intrekken loopt via de RPC hieronder,
-- die SECURITY DEFINER is en dus zelf de rolcheck doet.
drop policy if exists "public_holidays_update" on public.public_holidays;

create or replace function public.retract_public_holiday(p_holiday_id uuid, p_reden text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
begin
  if v_actor is null or not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder kan een feestdag intrekken'
      using errcode = 'insufficient_privilege';
  end if;
  if p_reden is null or char_length(trim(p_reden)) = 0 then
    raise exception 'Geef een reden op bij het intrekken van een feestdag'
      using errcode = 'check_violation';
  end if;

  update public.public_holidays
  set ingetrokken = true,
      ingetrokken_door = v_actor,
      ingetrokken_op = now(),
      ingetrokken_reden = left(trim(p_reden), 500),
      gewijzigd_door = v_actor
  where id = p_holiday_id and not ingetrokken;

  if not found then
    raise exception 'Feestdag niet gevonden of al ingetrokken' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke execute on function public.retract_public_holiday(uuid, text) from public, anon;
grant execute on function public.retract_public_holiday(uuid, text) to authenticated;

-- ============================================================
-- 2. Pijplijnfuncties markeren hun eigen due_date-updates (F-4)
--    Zelfde logica als 0004, enkel de set_config-vlag is toegevoegd, zodat
--    de statustrigger weet dat dit géén handmatige wijziging is en
--    due_date_wettelijk hier wél mag verschuiven.
-- ============================================================
create or replace function public.recalc_due_dates_on_legal_calendar_override()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_new_due date;
begin
  if not new.is_override then
    return new;
  end if;

  perform set_config('taskflow.pipeline', 'on', true);

  for r in
    select ti.id, ti.due_date_wettelijk
    from public.task_instances ti
    where ti.obligation_type_id = new.obligation_type_id
      and ti.status = 'open'
      and (
        extract(year from ti.periode_eind) = new.jaar
        or extract(year from ti.due_date_wettelijk) = new.jaar
      )
      and (new.scope is null or ti.periode_label ilike '%' || new.scope || '%')
  loop
    v_new_due := public.next_business_day(new.deadline_datum);
    if v_new_due is distinct from (select due_date from public.task_instances where id = r.id) then
      update public.task_instances
      set due_date_wettelijk = new.deadline_datum, due_date = v_new_due
      where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date_wettelijk, new.deadline_datum,
        new.gewijzigd_door, 'kalender_herberekening',
        'Herberekend n.a.v. correctie in de wettelijke kalender'
      );
    end if;
  end loop;

  perform set_config('taskflow.pipeline', 'off', true);
  return new;
end;
$$;

create or replace function public.recalc_neerlegging_after_av()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_ot_av uuid;
  v_actor uuid;
  v_raw date;
  v_due date;
  r record;
begin
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';

  if new.status = 'ingediend_afgerond' and old.status <> 'ingediend_afgerond' and new.obligation_type_id = v_ot_av then
    v_actor := coalesce(public.current_employee_id(), new.toegewezen_medewerker_id);
    v_raw := coalesce(new.afgerond_op::date, current_date) + 30;
    v_due := public.next_business_day(v_raw);

    perform set_config('taskflow.pipeline', 'on', true);

    for r in
      select id, due_date_wettelijk from public.task_instances where voorloper_taak_id = new.id
    loop
      update public.task_instances
      set due_date_wettelijk = v_raw, due_date = v_due, voorlopige_datum = false
      where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date_wettelijk, v_raw, v_actor, 'av_opvolging_automatisch',
        'Definitieve datum berekend op basis van effectieve afronding van de AV (+30 dagen)'
      );
    end loop;

    perform set_config('taskflow.pipeline', 'off', true);
  end if;

  return new;
end;
$$;

-- ============================================================
-- 3. F-3 + F-4 + F-9 — task_instances: overgangs-whitelist, bevroren
--    kolommen, trigger-eigen goedkeurings-/afrondingsstempels,
--    due_date-logging en kantoorgrens bij toewijzing.
-- ============================================================
create or replace function public.enforce_task_instance_transition()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid;
  v_can_approve boolean;
  v_allowed boolean;
  v_pipeline boolean := public.taskflow_pipeline_active();
  v_emp_firm uuid;
  v_client_firm uuid;
begin
  -- ---------- (b) Onveranderlijke kolommen -------------------
  -- Deze velden zijn bevroren op aanmaakmoment (docs/PLAN.md §2.7). Ze
  -- worden stil teruggezet i.p.v. een exception te gooien: PostgREST
  -- stuurt bij een gewone update enkel de gewijzigde kolommen mee, dus een
  -- afwijking hier is per definitie een poging (of een bug), nooit normaal
  -- verkeer. Bulk-updates blijven zo wel werken.
  new.vereist_goedkeuring := old.vereist_goedkeuring;
  new.bron_type := old.bron_type;
  new.client_id := old.client_id;
  new.obligation_type_id := old.obligation_type_id;
  new.client_obligation_id := old.client_obligation_id;
  new.periode_label := old.periode_label;

  -- ---------- (c) Stempels zijn eigendom van deze trigger ----
  -- Nooit accepteren wat de client stuurt; hieronder zet de trigger ze
  -- zelf wanneer de goedkeurings-/afrondingsstap echt plaatsvindt.
  new.goedgekeurd_door := old.goedgekeurd_door;
  new.goedgekeurd_op := old.goedgekeurd_op;
  new.afgerond_op := old.afgerond_op;

  if new.status is distinct from old.status then
    v_actor := public.current_employee_id();
    if v_actor is null then
      raise exception 'Statuswijziging vereist een ingelogde, gekoppelde medewerker';
    end if;

    if old.status in ('ingediend_afgerond', 'geannuleerd') then
      raise exception 'Taak met status % is afgesloten en kan niet meer wijzigen', old.status
        using errcode = 'check_violation';
    end if;

    -- ---------- (a) Expliciete whitelist (docs/PLAN.md §2.7) ----
    -- open -> in_uitvoering -> wacht_op_klant -> wacht_op_goedkeuring ->
    -- ingediend_afgerond, geannuleerd vanuit elke niet-eindstatus, plus de
    -- expliciete terugkeer wacht_op_goedkeuring -> in_uitvoering
    -- (afkeuring) en wacht_op_klant -> in_uitvoering (klant antwoordde).
    -- Vooruit overslaan mag, terug naar 'open' niet.
    v_allowed := case old.status
      when 'open' then
        new.status in ('in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd')
      when 'in_uitvoering' then
        new.status in ('wacht_op_klant', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd')
      when 'wacht_op_klant' then
        new.status in ('in_uitvoering', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd')
      when 'wacht_op_goedkeuring' then
        new.status in ('in_uitvoering', 'ingediend_afgerond', 'geannuleerd')
      else false
    end;

    if not v_allowed then
      raise exception 'Ongeldige statusovergang: % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;

    if new.status = 'wacht_op_goedkeuring' and not old.vereist_goedkeuring then
      raise exception 'Deze taak vereist geen goedkeuring (categorie is geen "wettelijk")'
        using errcode = 'check_violation';
    end if;

    -- Kern van F-3: een taak die goedkeuring vereist kan NOOIT rechtstreeks
    -- afgerond worden, enkel via wacht_op_goedkeuring — en die stap wordt
    -- hieronder door mag_goedkeuren bewaakt.
    if old.vereist_goedkeuring
       and new.status = 'ingediend_afgerond'
       and old.status <> 'wacht_op_goedkeuring' then
      raise exception
        'Deze taak vereist goedkeuring en kan enkel afgerond worden via de status "wacht_op_goedkeuring"'
        using errcode = 'check_violation';
    end if;

    -- Alleen een medewerker met mag_goedkeuren mag een taak UIT
    -- wacht_op_goedkeuring halen, goedkeurend of afkeurend (§5). Four-eyes
    -- blijft technisch toegelaten (§7 punt 3), met een waarschuwing in de UI.
    if old.status = 'wacht_op_goedkeuring' and new.status in ('ingediend_afgerond', 'in_uitvoering') then
      select mag_goedkeuren and actief into v_can_approve from public.employees where id = v_actor;
      if not coalesce(v_can_approve, false) then
        raise exception 'Alleen medewerkers met goedkeuringsrecht kunnen deze taak goedkeuren of terugsturen'
          using errcode = 'insufficient_privilege';
      end if;

      if new.status = 'ingediend_afgerond' then
        new.goedgekeurd_door := v_actor;
        new.goedgekeurd_op := now();
        insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron)
          values (new.id, 'goedkeuring_gegeven', v_actor, 'medewerker_actie');
      else
        new.goedgekeurd_door := null;
        new.goedgekeurd_op := null;
        insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron)
          values (new.id, 'goedkeuring_geweigerd', v_actor, 'medewerker_actie');
      end if;
    end if;

    if new.status = 'ingediend_afgerond' then
      new.afgerond_op := now();
    end if;

    insert into public.task_status_log (task_instance_id, event_type, oud_status, nieuw_status, actor_employee_id, trigger_bron)
      values (new.id, 'status_wijziging', old.status, new.status, v_actor, 'medewerker_actie');
  end if;

  -- ---------- F-4: deadlines --------------------------------
  -- due_date_wettelijk is de ruwe wettelijke datum en hoort uitsluitend uit
  -- de kalenderpijplijn te komen (legal_calendar-correctie, feestdag,
  -- AV-opvolging). Een medewerker die een deadline verschuift, verschuift
  -- de effectieve due_date — het wettelijke ijkpunt blijft bewaard.
  if new.due_date_wettelijk is distinct from old.due_date_wettelijk and not v_pipeline then
    raise exception
      'due_date_wettelijk kan enkel door de kalenderpijplijn gewijzigd worden; pas de effectieve due_date aan.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Handmatige deadline-wijziging is toegestaan (ook op automatisch
  -- gegenereerde taken — een kantoor moet een uitstel of een afwijkende
  -- afspraak kunnen vastleggen), maar ALTIJD met logregel: zonder spoor is
  -- een compliance-deadline waardeloos.
  if new.due_date is distinct from old.due_date and not v_pipeline then
    v_actor := coalesce(v_actor, public.current_employee_id());
    if v_actor is null then
      raise exception 'Wijziging van de deadline vereist een ingelogde, gekoppelde medewerker';
    end if;
    insert into public.task_status_log (
      task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
    ) values (
      new.id, 'due_date_herberekend', old.due_date, new.due_date, v_actor, 'medewerker_actie',
      'Handmatig aangepast'
    );
  end if;

  -- ---------- Toewijzing (+ F-9 kantoorgrens) ---------------
  if new.toegewezen_medewerker_id is distinct from old.toegewezen_medewerker_id then
    v_actor := coalesce(v_actor, public.current_employee_id());
    if v_actor is null then
      raise exception 'Herverdeling vereist een ingelogde, gekoppelde medewerker';
    end if;

    -- new.client_id is hierboven al vastgepind op old.client_id, dus dit
    -- kan niet omzeild worden door client_id in dezelfde update mee te sturen.
    select firm_id into v_emp_firm from public.employees where id = new.toegewezen_medewerker_id;
    select firm_id into v_client_firm from public.clients where id = new.client_id;
    if v_emp_firm is null or v_client_firm is null or v_emp_firm <> v_client_firm then
      raise exception 'De toegewezen medewerker hoort niet bij het kantoor van deze klant'
        using errcode = 'check_violation';
    end if;

    insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron, notitie)
      values (
        new.id, 'toewijzing_gewijzigd', v_actor, 'medewerker_actie',
        format('Herverdeeld van medewerker %s naar %s', old.toegewezen_medewerker_id, new.toegewezen_medewerker_id)
      );
  end if;

  if new.review_vereist is distinct from old.review_vereist then
    v_actor := coalesce(v_actor, public.current_employee_id());
    if v_actor is not null then
      insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron, notitie)
        values (
          new.id,
          (case when new.review_vereist then 'review_gemarkeerd' else 'review_afgehandeld' end)::public.log_event_type,
          v_actor, 'medewerker_actie', new.review_reden
        );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_task_instances_enforce_transition on public.task_instances;
create trigger trg_task_instances_enforce_transition
  before update on public.task_instances
  for each row
  execute function public.enforce_task_instance_transition();

-- F-9 op INSERT: de update-kant zit in de trigger hierboven (na het
-- vastpinnen van client_id), de insert-kant heeft een eigen trigger.
create or replace function public.enforce_task_assignment_firm_on_insert()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_emp_firm uuid;
  v_client_firm uuid;
begin
  select firm_id into v_emp_firm from public.employees where id = new.toegewezen_medewerker_id;
  select firm_id into v_client_firm from public.clients where id = new.client_id;
  if v_emp_firm is null or v_client_firm is null or v_emp_firm <> v_client_firm then
    raise exception 'De toegewezen medewerker hoort niet bij het kantoor van deze klant'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_task_instances_assignment_firm on public.task_instances;
create trigger trg_task_instances_assignment_firm
  before insert on public.task_instances
  for each row
  execute function public.enforce_task_assignment_firm_on_insert();

-- ============================================================
-- 4. F-7 — client_change_log wordt een generiek veld/oude_waarde/
--    nieuwe_waarde-log, en dekt ook de deadline-bepalende klantvelden en
--    de client_obligations.
--
-- Rolkeuze (bewust): deze velden blijven bewerkbaar door élke medewerker
-- die de klant mag zien — btw-regime, boekjaareinde of frequentie wijzigen
-- is gewoon dossierwerk, geen beheerdershandeling, en een
-- kantoorbeheerder-only gate zou dat werk blokkeren of naar een
-- schaduwproces duwen. Wat ontbrak was traceerbaarheid, niet autorisatie:
-- vanaf nu is elke wijziging herleidbaar tot een medewerker en een moment.
-- `vertrouwelijk` en `standaard_verantwoordelijke_id` blijven wél
-- kantoorbeheerder-only (0008/0009) — dat zijn toegangsbeslissingen.
-- ============================================================
alter table public.client_change_log
  add column if not exists client_obligation_id uuid references public.client_obligations(id) on delete cascade;

do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.client_change_log'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%vertrouwelijk%';
  if v_conname is not null then
    execute format('alter table public.client_change_log drop constraint %I', v_conname);
  end if;
end $$;

alter table public.client_change_log
  drop constraint if exists client_change_log_veld_generiek;
alter table public.client_change_log
  add constraint client_change_log_veld_generiek
  check (char_length(veld) between 1 and 100);

create index if not exists idx_client_change_log_obligation
  on public.client_change_log(client_obligation_id, created_at);

-- Zelfde functie als 0008/0009 (één plek die deze regel bezit), uitgebreid
-- met (a) de deadline-bepalende velden, (b) de kantoorgrens-check op
-- standaard_verantwoordelijke_id (F-9).
create or replace function public.block_unaudited_confidentiality_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid;
  v_old jsonb;
  v_new jsonb;
  v_veld text;
  v_emp_firm uuid;
  -- Velden die de volledige deadline-generatie aansturen (F-7).
  v_audited constant text[] := array[
    'boekjaar_einde_maand', 'boekjaar_einde_dag', 'btw_regime',
    'btw_aangifte_frequentie', 'actief'
  ];
begin
  -- F-9: de standaard verantwoordelijke moet bij hetzelfde kantoor horen.
  if new.standaard_verantwoordelijke_id is not null then
    select firm_id into v_emp_firm from public.employees where id = new.standaard_verantwoordelijke_id;
    if v_emp_firm is null or v_emp_firm <> new.firm_id then
      raise exception 'De standaard verantwoordelijke hoort niet bij het kantoor van deze klant'
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.vertrouwelijk or new.standaard_verantwoordelijke_id is not null then
      if not public.is_kantoorbeheerder() then
        raise exception
          'Enkel een kantoorbeheerder kan een klant meteen als vertrouwelijk aanmaken of bij aanmaak een standaard verantwoordelijke instellen. Maak de klant eerst aan zonder deze velden; een kantoorbeheerder kan ze nadien zetten.'
          using errcode = 'insufficient_privilege';
      end if;

      v_actor := public.current_employee_id();
      if v_actor is null then
        raise exception 'Aanmaken vereist een ingelogde, gekoppelde medewerker';
      end if;

      if new.vertrouwelijk then
        insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
        values (new.id, 'vertrouwelijk', null, new.vertrouwelijk::text, v_actor);
      end if;

      if new.standaard_verantwoordelijke_id is not null then
        insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
        values (new.id, 'standaard_verantwoordelijke_id', null, new.standaard_verantwoordelijke_id::text, v_actor);
      end if;
    end if;

    return new;
  end if;

  -- tg_op = 'UPDATE'
  if new.vertrouwelijk is distinct from old.vertrouwelijk
     or new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id then

    if not public.is_kantoorbeheerder() then
      raise exception
        'Enkel een kantoorbeheerder kan de vertrouwelijkheid of de standaard verantwoordelijke van een klant wijzigen.'
        using errcode = 'insufficient_privilege';
    end if;

    v_actor := public.current_employee_id();
    if v_actor is null then
      raise exception 'Wijziging vereist een ingelogde, gekoppelde medewerker';
    end if;

    if new.vertrouwelijk is distinct from old.vertrouwelijk then
      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
      values (new.id, 'vertrouwelijk', old.vertrouwelijk::text, new.vertrouwelijk::text, v_actor);
    end if;

    if new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id then
      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
      values (new.id, 'standaard_verantwoordelijke_id', old.standaard_verantwoordelijke_id::text, new.standaard_verantwoordelijke_id::text, v_actor);
    end if;
  end if;

  -- F-7: deadline-bepalende velden — geen extra rolcheck, wel altijd een
  -- audittrail.
  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  foreach v_veld in array v_audited loop
    if v_new -> v_veld is distinct from v_old -> v_veld then
      v_actor := coalesce(v_actor, public.current_employee_id());
      if v_actor is null then
        raise exception 'Wijziging van % vereist een ingelogde, gekoppelde medewerker', v_veld;
      end if;
      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
      values (new.id, v_veld, v_old ->> v_veld, v_new ->> v_veld, v_actor);
    end if;
  end loop;

  return new;
end;
$$;

-- De 0008-trigger stond op `before update of vertrouwelijk,
-- standaard_verantwoordelijke_id` en vuurde dus per definitie niet voor de
-- velden uit F-7. Vervangen door één trigger op alle kolommen; de functie
-- bepaalt zelf wat er veranderd is.
drop trigger if exists trg_clients_block_unaudited_confidentiality_change on public.clients;
create trigger trg_clients_block_unaudited_confidentiality_change
  before update on public.clients
  for each row
  execute function public.block_unaudited_confidentiality_change();

revoke execute on function public.block_unaudited_confidentiality_change() from public, anon, authenticated;

-- F-7 (tweede helft) + F-9 + F-13: audittrigger op client_obligations.
create or replace function public.audit_client_obligation_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_old jsonb;
  v_new jsonb;
  v_veld text;
  v_emp_firm uuid;
  v_client_firm uuid;
  v_audited constant text[] := array[
    'actief', 'parameters', 'geldig_vanaf', 'geldig_tot', 'standaard_toegewezen_medewerker_id'
  ];
begin
  -- F-9: kantoorgrens op de standaard toegewezen medewerker.
  if new.standaard_toegewezen_medewerker_id is not null then
    select firm_id into v_emp_firm from public.employees where id = new.standaard_toegewezen_medewerker_id;
    select c.firm_id into v_client_firm from public.clients c where c.id = new.client_id;
    if v_emp_firm is null or v_client_firm is null or v_emp_firm <> v_client_firm then
      raise exception 'De standaard toegewezen medewerker hoort niet bij het kantoor van deze klant'
        using errcode = 'check_violation';
    end if;
  end if;

  if v_actor is null then
    raise exception 'Wijzigen van een verplichting vereist een ingelogde, gekoppelde medewerker';
  end if;

  if tg_op = 'INSERT' then
    insert into public.client_change_log (
      client_id, client_obligation_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id
    ) values (
      new.client_id, new.id, 'verplichting_aangemaakt', null, new.actief::text, v_actor
    );
    return new;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  foreach v_veld in array v_audited loop
    if v_new -> v_veld is distinct from v_old -> v_veld then
      insert into public.client_change_log (
        client_id, client_obligation_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id
      ) values (
        new.client_id, new.id, 'verplichting_' || v_veld, v_old ->> v_veld, v_new ->> v_veld, v_actor
      );
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_client_obligations_audit on public.client_obligations;
create trigger trg_client_obligations_audit
  after insert or update on public.client_obligations
  for each row
  execute function public.audit_client_obligation_change();

revoke execute on function public.audit_client_obligation_change() from public, anon, authenticated;

-- F-13: parameters is vrije jsonb, maar geen opslagplaats. 16 KB is ruim
-- voor de parameters uit §2.6 en sluit de 1 MB-blob uit die de review
-- geaccepteerd kreeg.
alter table public.client_obligations
  drop constraint if exists client_obligations_parameters_grootte;
alter table public.client_obligations
  add constraint client_obligations_parameters_grootte
  check (octet_length(parameters::text) <= 16384);

-- ============================================================
-- 5. F-8 — de laatste actieve kantoorbeheerder mag zichzelf (of elkaar)
--    niet deactiveren: dan kan niemand nog medewerkers beheren, de
--    wettelijke kalender onderhouden of taken genereren.
-- ============================================================
create or replace function public.block_offboarding_with_open_tasks()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_open_count int;
  v_other_admins int;
begin
  if old.actief = true and new.actief = false then
    select count(*) into v_open_count
    from public.task_instances ti
    where ti.toegewezen_medewerker_id = old.id
      and ti.status not in ('ingediend_afgerond', 'geannuleerd');

    if v_open_count > 0 then
      raise exception
        'Kan medewerker % niet deactiveren: nog % open taak/taken toegewezen. Herverdeel deze taken eerst.',
        old.naam, v_open_count
        using errcode = 'check_violation';
    end if;

    if old.rol = 'kantoorbeheerder' then
      select count(*) into v_other_admins
      from public.employees e
      where e.firm_id = old.firm_id
        and e.rol = 'kantoorbeheerder'
        and e.actief
        and e.id <> old.id;

      if v_other_admins = 0 then
        raise exception
          'Kan medewerker % niet deactiveren: dit is de laatste actieve kantoorbeheerder van het kantoor. Stel eerst een andere kantoorbeheerder aan.',
          old.naam
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ============================================================
-- 6. F-1 — laatste zelf-refererende policy (task_instances)
--
-- task_instances_select/_update liepen via can_access_client() ->
-- can_view_client() -> `select ... from task_instances`: om te beslissen of
-- een taakrij zichtbaar is, werd task_instances opnieuw bevraagd. Vandaag
-- breekt dat niets (de toegang-verlenende taak bestaat altijd al vóór het
-- commando), maar het is exact de constructie die 0010 moest repareren.
--
-- Nieuwe USING-kant: de beslissende termen komen uit de rij zelf
-- (toegewezen_medewerker_id/status). De dossier-brede term ("ik heb een
-- ándere taak bij deze klant") blijft bestaan — dat ís de toegangsregel van
-- §2.11 — maar is niet langer nodig om de rij zelf te kunnen zien.
--
-- Bewust NIET aangepast: de with check-kant van task_instances_insert. Een
-- rij-gebaseerde toegewezen_medewerker_id-term daar zou een medewerker
-- toelaten zichzelf een taak op een vertrouwelijke klant toe te wijzen en
-- zo het dossier open te breken. Die escalatie is nu geblokkeerd (with
-- check vereist reeds bestaande toegang) en blijft geblokkeerd; de test
-- dekt dit expliciet af.
-- ============================================================
create or replace function public.can_access_task_row(
  p_client_id uuid,
  p_toegewezen_medewerker_id uuid,
  p_status public.task_status
)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.clients c
    where c.id = p_client_id
      and c.firm_id = public.current_employee_firm_id()
      and (
        not c.vertrouwelijk
        or public.is_kantoorbeheerder()
        -- Rij-gebaseerd: deze taak is aan mij toegewezen.
        or (
          p_toegewezen_medewerker_id = public.current_employee_id()
          and p_status <> 'geannuleerd'
        )
        -- Dossier-breed (§2.11): ik heb een andere lopende taak bij deze klant.
        or exists (
          select 1 from public.task_instances ti
          where ti.client_id = c.id
            and ti.toegewezen_medewerker_id = public.current_employee_id()
            and ti.status <> 'geannuleerd'
        )
      )
  );
$$;

revoke execute on function public.can_access_task_row(uuid, uuid, public.task_status) from public, anon;
grant execute on function public.can_access_task_row(uuid, uuid, public.task_status) to authenticated;

drop policy if exists "task_instances_select" on public.task_instances;
create policy "task_instances_select" on public.task_instances
  for select using (
    public.can_access_task_row(client_id, toegewezen_medewerker_id, status)
  );

drop policy if exists "task_instances_update" on public.task_instances;
create policy "task_instances_update" on public.task_instances
  for update using (
    public.can_access_task_row(client_id, toegewezen_medewerker_id, status)
  ) with check (
    -- Ongewijzigd t.o.v. 0005: geen rij-gebaseerde toewijzingsterm, anders
    -- kan een medewerker zich toegang tot een vertrouwelijk dossier
    -- toekennen door zichzelf een taak toe te wijzen.
    public.can_access_client(client_id)
  );

-- task_instances_insert blijft exact zoals in 0005 (hier enkel herhaald ter
-- documentatie dat dit een bewuste keuze is, niet een vergetelheid):
--   for insert with check (public.can_access_client(client_id))

-- ============================================================
-- 7. F-12 — helperfuncties niet langer EXECUTE-baar door PUBLIC/anon.
-- ============================================================
revoke execute on function public.can_view_client(uuid, uuid) from public, anon;
revoke execute on function public.can_access_client(uuid) from public, anon;
revoke execute on function public.current_employee_id() from public, anon;
revoke execute on function public.current_employee_firm_id() from public, anon;
revoke execute on function public.is_kantoorbeheerder() from public, anon;
revoke execute on function public.mag_goedkeuren() from public, anon;

grant execute on function public.can_view_client(uuid, uuid) to authenticated;
grant execute on function public.can_access_client(uuid) to authenticated;
grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.current_employee_firm_id() to authenticated;
grant execute on function public.is_kantoorbeheerder() to authenticated;
grant execute on function public.mag_goedkeuren() to authenticated;
