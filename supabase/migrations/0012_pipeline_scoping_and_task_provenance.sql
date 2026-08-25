-- Taskflow v1 — pijplijn-scoping, herkomst van taakinstanties en
-- correctiepad voor annulering.
--
-- Aanleiding: de tweede security-review (2026-08-25, ná 0011) verifieerde
-- 0011 door er actief omheen te werken in plaats van de tests te herhalen.
-- Zeven van de negen bevindingen bleken dicht; twee niet, plus drie nieuwe.
-- Alles hieronder is als gewone `medewerker` via PostgREST-acties
-- gereproduceerd.
--
-- Deze migratie is additief: 0003-0011 zijn al toegepast en worden NIET
-- gewijzigd. Alles is een `create or replace` van een bestaande functie, een
-- nieuw object, of een index/constraint die opnieuw wordt gedefinieerd.
--
-- Opgeloste bevindingen:
--   B-1 (High)   De AV-pijplijn was kaapbaar via voorloper_taak_id: die
--                kolom stond niet in de bevroren lijst, en
--                recalc_neerlegging_after_av() koos zijn doelrijen enkel op
--                `voorloper_taak_id = new.id`. Gevolg: een medewerker kon de
--                deadline van een collega herschrijven én dat als
--                systeemgebeurtenis (trigger_bron='av_opvolging_automatisch')
--                laten boeken. Structurele oorzaak: de pijplijnvlag was een
--                boolean die alleen zei "de pijplijn is bezig", niet "de
--                pijplijn raakt DEZE rij aan".
--   B-2 (High)   vereist_goedkeuring was bevroren bij UPDATE maar vrij bij
--                INSERT (en status/afgerond_op ook), dus de goedkeuringsstap
--                was te omzeilen door de taak te vervangen i.p.v. te
--                wijzigen. Aanmaak liet bovendien geen enkel spoor na.
--   B-3 (Medium) Annuleren was onomkeerbaar én blokkeerde hergeneratie: de
--                verplichting verdween permanent uit alle werklijsten.
--   B-5 (Medium) Kolommen die gedrag of bewijskracht bepalen (periode_start,
--                periode_eind, id, created_at, voorlopige_datum, title,
--                description, review_reden) waren stil wijzigbaar.
--   B-6 (Low)    Twee triggerfuncties uit 0011 misten de `revoke execute`.
--   B-7 (Low)    recalc_due_dates_after_holiday_change() scande álle open
--                taken per feestdagmutatie (timeout-risico bij een
--                jaarlijkse bulk), en public_holidays.jaar werd nooit tegen
--                `datum` gecontroleerd.
--
-- Bevinding B-4 (feestdagcorrectie ontbreekt in de UI) is frontend-only en
-- zit niet in deze migratie: retract_public_holiday() bestond al sinds 0011,
-- alleen riep niets in src/ hem aan.

-- ============================================================
-- 0. B-1 (structureel) — de pijplijnvlag draagt voortaan de rij-id
--
-- 0011 zette één transactie-lokale boolean (`taskflow.pipeline`) rond de
-- updates van de kalender-/AV-pijplijn. Die vlag beschermde tegen het
-- *zetten* ervan door een client, maar niet tegen het *sturen* van welke
-- rijen de pijplijn aanraakt: wie de pijplijn op een vreemde rij liet
-- landen, kreeg de privileges van de pijplijn (due_date_wettelijk
-- herschrijven, voorlopige_datum uitzetten) plus een logregel met
-- trigger_bron='av_opvolging_automatisch'.
--
-- Vanaf nu draagt de vlag de id van de rij die de pijplijn op dat moment
-- bewerkt, en eist enforce_task_instance_transition() dat die id
-- overeenkomt met de rij die effectief wordt gewijzigd. De pijplijnen die
-- meerdere rijen raken (feestdag, wettelijke kalender) zetten de vlag per
-- rij binnen hun lus.
-- ============================================================
create or replace function public.taskflow_pipeline_owns_row(p_task_id uuid)
returns boolean
language sql stable
set search_path = public
as $$
  -- coalesce is niet cosmetisch: current_setting(..., true) geeft NULL
  -- wanneer de vlag nooit gezet is, en een NULL zou hier via `not v_pipeline`
  -- stilletjes álle pijplijn-controles overslaan.
  select coalesce(
    nullif(current_setting('taskflow.pipeline_task_id', true), '') = p_task_id::text,
    false
  );
$$;

comment on function public.taskflow_pipeline_owns_row(uuid) is
  'True wanneer de kalender-/AV-pijplijn op dit moment exact deze taakrij bewerkt (migratie 0012). '
  'Vervangt de rij-loze boolean taskflow_pipeline_active() uit 0011.';

revoke execute on function public.taskflow_pipeline_owns_row(uuid) from public, anon;
grant execute on function public.taskflow_pipeline_owns_row(uuid) to authenticated;

-- ============================================================
-- 1. B-1 — AV -> neerlegging: doelrijen expliciet afbakenen
--
-- De lus liep blind over `voorloper_taak_id = new.id`. Wie die kolom op een
-- vreemde taak zette (zie 5. hieronder: die kolom is nu bevroren), stuurde
-- daarmee de pijplijn. Dubbele afscherming: de kolom is niet meer te zetten,
-- én de lus accepteert alleen nog wat een neerleggingstaak van dezelfde
-- klant is, automatisch gegenereerd, en niet afgesloten.
-- ============================================================
create or replace function public.recalc_neerlegging_after_av()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_ot_av uuid;
  v_ot_neerlegging uuid;
  v_actor uuid;
  v_raw date;
  v_due date;
  r record;
begin
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_neerlegging from public.obligation_types where code = 'neerlegging_jaarrekening';

  if new.status = 'ingediend_afgerond' and old.status <> 'ingediend_afgerond' and new.obligation_type_id = v_ot_av then
    v_actor := coalesce(public.current_employee_id(), new.toegewezen_medewerker_id);
    v_raw := coalesce(new.afgerond_op::date, current_date) + 30;
    v_due := public.next_business_day(v_raw);

    for r in
      select id, due_date_wettelijk
      from public.task_instances
      where voorloper_taak_id = new.id
        and obligation_type_id = v_ot_neerlegging
        and client_id = new.client_id
        and bron_type = 'automatisch_gegenereerd'
        and status not in ('ingediend_afgerond', 'geannuleerd')
    loop
      -- Vlag per rij: de pijplijn krijgt alleen rechten op de rij die ze nu
      -- effectief bewerkt (B-1).
      perform set_config('taskflow.pipeline_task_id', r.id::text, true);

      update public.task_instances
      set due_date_wettelijk = v_raw, due_date = v_due, voorlopige_datum = false
      where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date_wettelijk, v_raw, v_actor, 'av_opvolging_automatisch',
        'Definitieve datum berekend op basis van effectieve afronding van de AV (+30 dagen)'
      );

      perform set_config('taskflow.pipeline_task_id', '', true);
    end loop;
  end if;

  return new;
end;
$$;

revoke execute on function public.recalc_neerlegging_after_av() from public, anon, authenticated;

-- ============================================================
-- 2. B-1/B-7 — kalenderpijplijnen: vlag per rij + begrensde scan
--
-- recalc_due_dates_after_holiday_change() liep bij ELKE feestdagmutatie over
-- alle open taken van de instance. Bij het jaarlijks invoeren van ~10
-- feestdagen zijn dat 10 volledige scans in evenveel requests — bij 50-500
-- klanten een reëel timeout-risico op het beheerscherm.
--
-- Een feestdag op datum D kan alleen taken raken waarvan de ruwe wettelijke
-- datum op of vóór D valt (de verschuivingsketen start daar) én waarvan de
-- effectieve datum niet al vóór D lag (dan stopte de keten al eerder). De
-- marge van 7 dagen is bewuste speling voor rijen die eerder handmatig zijn
-- verschoven.
-- ============================================================
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

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk
    from public.task_instances ti
    where ti.status = 'open'
      and ti.due_date_wettelijk <= new.datum
      and ti.due_date >= new.datum - 7
  loop
    v_new_due := public.next_business_day(r.due_date_wettelijk);
    if v_new_due is distinct from r.due_date then
      perform set_config('taskflow.pipeline_task_id', r.id::text, true);

      update public.task_instances set due_date = v_new_due where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date, v_new_due, v_actor, 'kalender_herberekening', v_notitie
      );

      perform set_config('taskflow.pipeline_task_id', '', true);
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.recalc_due_dates_after_holiday_change() from public, anon, authenticated;

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

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk
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
    if v_new_due is distinct from r.due_date or new.deadline_datum is distinct from r.due_date_wettelijk then
      perform set_config('taskflow.pipeline_task_id', r.id::text, true);

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

      perform set_config('taskflow.pipeline_task_id', '', true);
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.recalc_due_dates_on_legal_calendar_override() from public, anon, authenticated;

-- ============================================================
-- 3. B-2 — nieuw logevent: aanmaak en inhoudelijke wijziging van een taak
--
-- `taak_aangemaakt` sluit het gat dat B-2 uitbuitte: een taak vervangen liet
-- géén spoor na, terwijl elke statuswijziging dat wel doet.
-- `taak_inhoud_gewijzigd` dekt B-5: title/description/review_reden bepalen
-- mee de bewijskracht van het dossier.
-- ============================================================
alter type public.log_event_type add value if not exists 'taak_aangemaakt';
alter type public.log_event_type add value if not exists 'taak_inhoud_gewijzigd';

-- ============================================================
-- 4. B-3 — annuleren blokkeert hergeneratie niet meer
--
-- Keuze (zie samenvatting): de unieke index telt geannuleerde rijen niet
-- meer mee, zodat generate_task_instances() een geannuleerde wettelijke
-- verplichting binnen de rollende horizon vanzelf opnieuw aanmaakt, én de
-- annulering krijgt een expliciete notitie in het audittrail. Voor periodes
-- buiten de horizon is er daarnaast een handmatig correctiepad: een
-- kantoorbeheerder mag `geannuleerd -> open` zetten (zie 5.). Het dossier
-- blijft zo compleet (de geannuleerde rij verdwijnt nooit) en het systeem
-- herstelt zichzelf.
-- ============================================================
drop index if exists public.idx_task_instances_unique_period;
create unique index if not exists idx_task_instances_unique_period
  on public.task_instances(client_id, obligation_type_id, periode_label)
  where bron_type = 'automatisch_gegenereerd' and status <> 'geannuleerd';

comment on index public.idx_task_instances_unique_period is
  'Idempotentie van de recurrence-engine. Geannuleerde rijen tellen bewust niet mee (migratie 0012, B-3): '
  'anders blokkeert één annulering de hergeneratie van die periode voor altijd.';

-- De ON CONFLICT-inferentie moet exact de nieuwe indexpredicaat-vorm
-- hebben. Meteen ook: bij conflict de id van de bestaande ACTIEVE rij
-- teruggeven, zodat de AV-lus in generate_task_instances() (0006) nooit een
-- geannuleerde voorloper oppikt.
create or replace function public.upsert_generated_task(
  p_client_id uuid,
  p_obligation_type_id uuid,
  p_client_obligation_id uuid,
  p_periode_label text,
  p_periode_start date,
  p_periode_eind date,
  p_due_raw date,
  p_toegewezen uuid,
  p_categorie public.obligation_categorie,
  p_voorlopige_datum boolean default false,
  p_voorloper_taak_id uuid default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_due date := public.next_business_day(p_due_raw);
  v_id uuid;
begin
  insert into public.task_instances (
    client_id, obligation_type_id, client_obligation_id, periode_label,
    periode_start, periode_eind, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, voorloper_taak_id, bron_type,
    voorlopige_datum, vereist_goedkeuring
  ) values (
    p_client_id, p_obligation_type_id, p_client_obligation_id, p_periode_label,
    p_periode_start, p_periode_eind, v_due, p_due_raw,
    'open', p_toegewezen, p_voorloper_taak_id, 'automatisch_gegenereerd',
    p_voorlopige_datum, (p_categorie = 'wettelijk')
  )
  on conflict (client_id, obligation_type_id, periode_label)
    where bron_type = 'automatisch_gegenereerd' and status <> 'geannuleerd'
  do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id
    from public.task_instances
    where client_id = p_client_id
      and obligation_type_id = p_obligation_type_id
      and periode_label is not distinct from p_periode_label
      and bron_type = 'automatisch_gegenereerd'
      and status <> 'geannuleerd'
    limit 1;
  end if;

  return v_id;
end;
$$;

revoke execute on function public.upsert_generated_task(
  uuid, uuid, uuid, text, date, date, date, uuid, public.obligation_categorie, boolean, uuid
) from public, anon, authenticated;

-- ============================================================
-- 5. B-1/B-2/B-3/B-5 — task_instances UPDATE: bevroren kolommen,
--    rij-gebonden pijplijn, heropenen door de kantoorbeheerder, en
--    logging van inhoudelijke wijzigingen.
--
-- Volledige herdefinitie van de 0011-versie. Verschillen t.o.v. 0011:
--   * v_pipeline is rij-gebonden (taskflow_pipeline_owns_row) i.p.v. globaal;
--   * id, created_at, periode_start, periode_eind en voorloper_taak_id zijn
--     bevroren; voorlopige_datum kan enkel nog door de pijplijn;
--   * geannuleerd -> open is toegelaten voor een kantoorbeheerder, met
--     duplicaatcontrole en logregel;
--   * annuleren en heropenen krijgen een notitie in het audittrail;
--   * title/description/review_reden-wijzigingen op gegenereerde taken
--     worden gelogd.
-- ============================================================
create or replace function public.enforce_task_instance_transition()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid;
  v_can_approve boolean;
  v_allowed boolean;
  v_pipeline boolean := public.taskflow_pipeline_owns_row(old.id);
  v_emp_firm uuid;
  v_client_firm uuid;
  v_notitie text;
  v_velden text[];
begin
  -- ---------- (b) Onveranderlijke kolommen -------------------
  -- Bevroren op aanmaakmoment (docs/PLAN.md §2.7). Ze worden stil
  -- teruggezet i.p.v. een exception te gooien: PostgREST stuurt bij een
  -- gewone update enkel de gewijzigde kolommen mee, dus een afwijking hier
  -- is per definitie een poging (of een bug), nooit normaal verkeer.
  -- Bulk-updates blijven zo wel werken.
  new.id := old.id;
  new.created_at := old.created_at;
  new.vereist_goedkeuring := old.vereist_goedkeuring;
  new.bron_type := old.bron_type;
  new.client_id := old.client_id;
  new.obligation_type_id := old.obligation_type_id;
  new.client_obligation_id := old.client_obligation_id;
  new.periode_label := old.periode_label;
  new.periode_start := old.periode_start;
  new.periode_eind := old.periode_eind;
  -- B-1: voorloper_taak_id stuurde de AV-pijplijn aan. Herkoppelen is geen
  -- dagelijkse handeling; de engine legt de koppeling bij aanmaak.
  new.voorloper_taak_id := old.voorloper_taak_id;

  -- B-5: de voorlopige/definitieve markering hoort bij de datumpijplijn,
  -- niet bij de medewerker die de taak bewerkt.
  if not v_pipeline then
    new.voorlopige_datum := old.voorlopige_datum;
  end if;

  -- ---------- (c) Stempels zijn eigendom van deze trigger ----
  new.goedgekeurd_door := old.goedgekeurd_door;
  new.goedgekeurd_op := old.goedgekeurd_op;
  new.afgerond_op := old.afgerond_op;

  if new.status is distinct from old.status then
    v_actor := public.current_employee_id();
    if v_actor is null then
      raise exception 'Statuswijziging vereist een ingelogde, gekoppelde medewerker';
    end if;

    -- B-3: annuleren is geen eindpunt meer zonder correctiepad. Een
    -- kantoorbeheerder mag een geannuleerde taak heropenen; alle andere
    -- overgangen vanuit een eindstatus blijven geblokkeerd.
    if old.status in ('ingediend_afgerond', 'geannuleerd') then
      if not (old.status = 'geannuleerd' and new.status = 'open' and public.is_kantoorbeheerder()) then
        raise exception 'Taak met status % is afgesloten en kan niet meer wijzigen', old.status
          using errcode = 'check_violation';
      end if;

      if old.bron_type = 'automatisch_gegenereerd' and exists (
        select 1 from public.task_instances t
        where t.client_id = old.client_id
          and t.obligation_type_id = old.obligation_type_id
          and t.periode_label is not distinct from old.periode_label
          and t.bron_type = 'automatisch_gegenereerd'
          and t.status <> 'geannuleerd'
          and t.id <> old.id
      ) then
        raise exception
          'Er bestaat al een actieve taak voor deze klant, verplichting en periode; heropenen zou een duplicaat opleveren.'
          using errcode = 'unique_violation';
      end if;
    end if;

    -- ---------- (a) Expliciete whitelist (docs/PLAN.md §2.7) ----
    -- open -> in_uitvoering -> wacht_op_klant -> wacht_op_goedkeuring ->
    -- ingediend_afgerond, geannuleerd vanuit elke niet-eindstatus, plus de
    -- expliciete terugkeer wacht_op_goedkeuring -> in_uitvoering
    -- (afkeuring), wacht_op_klant -> in_uitvoering (klant antwoordde) en
    -- geannuleerd -> open (heropenen, enkel kantoorbeheerder; zie boven).
    v_allowed := case old.status
      when 'open' then
        new.status in ('in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd')
      when 'in_uitvoering' then
        new.status in ('wacht_op_klant', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd')
      when 'wacht_op_klant' then
        new.status in ('in_uitvoering', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd')
      when 'wacht_op_goedkeuring' then
        new.status in ('in_uitvoering', 'ingediend_afgerond', 'geannuleerd')
      when 'geannuleerd' then
        new.status = 'open'
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
    -- afgerond worden, enkel via wacht_op_goedkeuring.
    if old.vereist_goedkeuring
       and new.status = 'ingediend_afgerond'
       and old.status <> 'wacht_op_goedkeuring' then
      raise exception
        'Deze taak vereist goedkeuring en kan enkel afgerond worden via de status "wacht_op_goedkeuring"'
        using errcode = 'check_violation';
    end if;

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

    -- B-3: annuleren en heropenen zijn beslissingen met dossiergevolgen —
    -- die horen herkenbaar in het log te staan, niet als naamloze
    -- statuswijziging.
    v_notitie := case
      when new.status = 'geannuleerd' and old.bron_type = 'automatisch_gegenereerd' then
        'Gegenereerde verplichting geannuleerd; de taakgeneratie kan deze periode opnieuw aanmaken.'
      when new.status = 'geannuleerd' then 'Taak geannuleerd.'
      when old.status = 'geannuleerd' then 'Geannuleerde taak heropend door een kantoorbeheerder.'
      else null
    end;

    if old.status = 'geannuleerd' then
      new.afgerond_op := null;
      new.goedgekeurd_door := null;
      new.goedgekeurd_op := null;
    end if;

    insert into public.task_status_log (
      task_instance_id, event_type, oud_status, nieuw_status, actor_employee_id, trigger_bron, notitie
    ) values (new.id, 'status_wijziging', old.status, new.status, v_actor, 'medewerker_actie', v_notitie);
  end if;

  -- ---------- F-4: deadlines --------------------------------
  if new.due_date_wettelijk is distinct from old.due_date_wettelijk and not v_pipeline then
    raise exception
      'due_date_wettelijk kan enkel door de kalenderpijplijn gewijzigd worden; pas de effectieve due_date aan.'
      using errcode = 'insufficient_privilege';
  end if;

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

  -- ---------- B-5: inhoudelijke wijzigingen ------------------
  -- Op een automatisch gegenereerde taak zijn title/description/review_reden
  -- geen vrije notitievelden maar dossierinhoud: ze beschrijven wat er
  -- wettelijk moest gebeuren. Wijzigen mag (een kantoor moet kunnen
  -- verduidelijken), maar nooit stil. review_reden wordt hier enkel gelogd
  -- wanneer review_vereist zelf niet wijzigt — anders staat het al in de
  -- review_gemarkeerd/-afgehandeld-regel hierboven.
  if old.bron_type = 'automatisch_gegenereerd' and not v_pipeline then
    v_velden := array[]::text[];
    if new.title is distinct from old.title then
      v_velden := array_append(v_velden, 'titel');
    end if;
    if new.description is distinct from old.description then
      v_velden := array_append(v_velden, 'omschrijving');
    end if;
    if new.review_reden is distinct from old.review_reden
       and new.review_vereist is not distinct from old.review_vereist then
      v_velden := array_append(v_velden, 'review_reden');
    end if;

    if array_length(v_velden, 1) > 0 then
      v_actor := coalesce(v_actor, public.current_employee_id());
      if v_actor is null then
        raise exception 'Wijziging van % vereist een ingelogde, gekoppelde medewerker',
          array_to_string(v_velden, ', ');
      end if;
      insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron, notitie)
      values (
        new.id, 'taak_inhoud_gewijzigd', v_actor, 'medewerker_actie',
        'Gewijzigd: ' || array_to_string(v_velden, ', ')
      );
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_task_instance_transition() from public, anon, authenticated;

drop trigger if exists trg_task_instances_enforce_transition on public.task_instances;
create trigger trg_task_instances_enforce_transition
  before update on public.task_instances
  for each row
  execute function public.enforce_task_instance_transition();

-- ============================================================
-- 6. B-2 — INSERT is even streng als UPDATE
--
-- Zonder deze trigger was de goedkeuringsstap te omzeilen door de taak niet
-- te WIJZIGEN maar te VERVANGEN: annuleer de goedkeuringsplichtige taak,
-- maak een 'automatisch_gegenereerd'-kopie met vereist_goedkeuring=false (of
-- meteen met status='ingediend_afgerond') en klaar. PLAN §2.7 zegt dat
-- vereist_goedkeuring bevroren wordt "op aanmaakmoment vanuit
-- obligation_types.categorie" — dat gebeurde alleen in upsert_generated_task
-- (0006), niet op tabelniveau.
-- ============================================================
create or replace function public.enforce_task_instance_insert_provenance()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_categorie public.obligation_categorie;
  v_voorloper_client uuid;
begin
  -- vereist_goedkeuring komt uitsluitend uit de catalogus, nooit uit de
  -- payload. Ad-hoc taken hebben geen obligation_type en dus per definitie
  -- geen goedkeuringsstap (§2.7).
  if new.obligation_type_id is null then
    new.vereist_goedkeuring := false;
  else
    select categorie into v_categorie from public.obligation_types where id = new.obligation_type_id;
    if v_categorie is null then
      raise exception 'Onbekend verplichtingtype' using errcode = 'foreign_key_violation';
    end if;
    new.vereist_goedkeuring := (v_categorie = 'wettelijk');
  end if;

  -- Een nieuwe taak start altijd open: anders kan een reeds "afgeronde"
  -- taak worden binnengesmokkeld zonder ooit door de statusflow te gaan.
  new.status := 'open';
  new.goedgekeurd_door := null;
  new.goedgekeurd_op := null;
  new.afgerond_op := null;

  -- B-1: een voorloper moet een taak van dezelfde klant zijn. Zo kan een
  -- nieuwe rij de AV-pijplijn niet naar een vreemd dossier laten wijzen.
  if new.voorloper_taak_id is not null then
    select client_id into v_voorloper_client
    from public.task_instances where id = new.voorloper_taak_id;
    if v_voorloper_client is null or v_voorloper_client <> new.client_id then
      raise exception 'De voorloper-taak hoort bij een andere klant'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_task_instance_insert_provenance() from public, anon, authenticated;

drop trigger if exists trg_task_instances_insert_provenance on public.task_instances;
create trigger trg_task_instances_insert_provenance
  before insert on public.task_instances
  for each row
  execute function public.enforce_task_instance_insert_provenance();

-- Aanmaak laat vanaf nu hetzelfde spoor na als elke andere handeling.
create or replace function public.log_task_instance_created()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := coalesce(public.current_employee_id(), new.toegewezen_medewerker_id);
begin
  insert into public.task_status_log (
    task_instance_id, event_type, nieuw_status, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
  ) values (
    new.id, 'taak_aangemaakt', new.status, new.due_date, v_actor, 'medewerker_actie',
    case
      when new.bron_type = 'handmatig_adhoc' then 'Ad-hoc taak aangemaakt'
      else 'Taakinstantie aangemaakt' || coalesce(' voor periode ' || new.periode_label, '')
    end
  );
  return new;
end;
$$;

revoke execute on function public.log_task_instance_created() from public, anon, authenticated;

drop trigger if exists trg_task_instances_log_created on public.task_instances;
create trigger trg_task_instances_log_created
  after insert on public.task_instances
  for each row
  execute function public.log_task_instance_created();

-- ============================================================
-- 7. B-6 — ontbrekende revokes uit 0011.
-- ============================================================
revoke execute on function public.enforce_task_assignment_firm_on_insert() from public, anon, authenticated;

-- De rij-loze pijplijnvlag verdwijnt: hij bestaat niet meer als hefboom.
drop function if exists public.taskflow_pipeline_active();

-- ============================================================
-- 8. B-7 — public_holidays.jaar moet bij `datum` horen
--
-- `jaar` stuurt de jaarfilter van het beheerscherm aan; een rij met
-- jaar=2026 en datum='2030-01-01' verdwijnt uit beeld terwijl
-- next_business_day() haar wél meetelt. NOT VALID + expliciete validatie:
-- op een bestaande database mag deze migratie niet stukvallen op historische
-- rommel, maar nieuwe/gewijzigde rijen worden meteen afgedwongen.
-- ============================================================
alter table public.public_holidays
  drop constraint if exists public_holidays_jaar_matcht_datum;
alter table public.public_holidays
  add constraint public_holidays_jaar_matcht_datum
  check (jaar = extract(year from datum)::int) not valid;

do $$
begin
  alter table public.public_holidays validate constraint public_holidays_jaar_matcht_datum;
exception when check_violation then
  raise warning
    'public_holidays bevat rijen waarvan jaar niet bij datum hoort; de constraint blijft NOT VALID en geldt enkel voor nieuwe rijen. Corrigeer die rijen via intrekken + opnieuw invoeren.';
end $$;
