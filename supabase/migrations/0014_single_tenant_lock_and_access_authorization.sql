-- Taskflow v1 — single-tenant-slot, autorisatie van toegangverlening, en het
-- dichttimmeren van de resterende kolommen zonder bevriezing of audittrail.
--
-- Aanleiding: de vijfde security-verificatie (na 0013). H-1/H-2/M-1/M-3/M-4
-- hielden stand, de klantisolatie en het audittrail bleven onmanipuleerbaar,
-- maar er kwamen drie blokkerende bevindingen bij plus een aantal kleinere.
-- Alles hieronder is als gewone `medewerker` of als wildvreemde
-- `authenticated` gereproduceerd.
--
-- Additief: 0003-0013 zijn al toegepast en worden NIET gewijzigd.
--
-- Opgeloste bevindingen:
--   A (High)     Zelfregistratie gaf een wildvreemde een eigen "kantoor" met
--                rol kantoorbeheerder, en daarmee schrijfrecht op de GEDEELDE
--                legal_calendar en public_holidays. Eén request herschreef de
--                wettelijke deadline van élk dossier van het echte kantoor,
--                geboekt als vertrouwd systeemevent 'kalender_herberekening'.
--                Klantdata lekte niet, maar de kalenderintegriteit wel.
--   B (Medium)   due_date_handmatig_op stond niet in het bevroren kolomblok.
--                Wissen liet de kalenderpijplijn een handmatige afspraak
--                alsnog stil overschrijven; zetten (zonder due_date aan te
--                raken) maakte een taak immuun voor de pijplijn en kon een
--                deadline op een feestdag vastzetten. Beide zonder audittrail.
--   C (Medium)   Een gewone medewerker kon via een toewijzing een collega
--                toegang geven tot een vertrouwelijk dossier. 0013 (M-3)
--                maakte dat zichtbaar, maar autoriseerde het niet.
--   D (Medium)   employees was kolom-vrij voor een kantoorbeheerder en
--                volledig ongeaudit: één PATCH sloot een collega buiten
--                (auth_user_id op null), kaapte de identiteit via een gewijzigd
--                e-mailadres + claim_invite(), of gaf stilzwijgend
--                goedkeuringsrecht — zonder enig spoor.
--   F (Low)      review_reden kreeg de letterlijke tekst 'false' als voorvoegsel
--                en gooide de bestaande reden weg.
--   H (Low)      De dode kanban-tabellen uit 0001/0002 bleven schrijfbaar via
--                PostgREST voor elke geregistreerde gebruiker.
--   J (Low)      De voorloper-herkoppeling uit 0013 liet geen spoor na, terwijl
--                voorloper_taak_id de neerleggingsdeadline bepaalt.
--   Advisor      set_updated_at / fiscal_year_end / normalize_employee_email
--                hadden geen vaste search_path; de eerste twee waren bovendien
--                door anon uitvoerbaar.
--
-- Bewust NIET hier opgelost:
--   I (Low)      generate_task_instances() telt instance-breed i.p.v. per
--                kantoor. Het single-tenant-slot hieronder maakt dat getal per
--                definitie correct (er is precies één firms-rij), en de functie
--                daarvoor over 250 regels heen herschrijven weegt niet op tegen
--                de winst. Blijft staan als losse opruimtaak wanneer er ooit
--                een tweede firms-rij zou komen.
--   L-2 (Low)    De AV-fallback in 0006 is dode code sinds 0012 en is dat nog
--                steeds; hij krijgt hieronder alleen een comment mee zodat de
--                volgende lezer er niet op vertrouwt.

-- ============================================================
-- 1. A — single-tenant-slot
--
-- Beslissing van het kantoor (docs/PLAN.md §8): deze installatie draait voor
-- één kantoor. Dat is tot nu toe alleen als afspraak vastgelegd en werd
-- afgedwongen door een dashboardschakelaar ("Allow new users to sign up"),
-- buiten de database, met een venster tussen deploy en het omzetten daarvan.
-- Hier wordt het een eigenschap van het schema: zodra er één kantoor bestaat,
-- kan niemand er nog een tweede naast zetten. Wie erbij hoort, komt binnen via
-- invite_employee() + claim_invite() — de route die er al was.
--
-- Dit is de beslissende maatregel tegen bevinding A: geen tweede kantoor
-- betekent geen vreemde kantoorbeheerder, en dus niemand die in de gedeelde
-- kalender mag schrijven.
-- ============================================================
create or replace function public.create_firm_and_admin(p_firm_naam text, p_medewerker_naam text)
returns table(employee_id uuid, firm_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_email_confirmed_at timestamptz;
  v_firm_id uuid;
  v_employee_id uuid;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd';
  end if;

  -- A: het slot. Staat vóór elke andere controle zodat een buitenstaander niet
  -- eens te weten komt of zijn e-mailadres bekend is.
  if exists (select 1 from public.firms limit 1) then
    raise exception
      'Dit kantoor is al ingericht. Vraag je kantoorbeheerder om een uitnodiging in plaats van een nieuw kantoor aan te maken.'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.employees where auth_user_id = v_uid) then
    raise exception 'Deze gebruiker is al gekoppeld aan een medewerkersprofiel';
  end if;
  if p_firm_naam is null or char_length(trim(p_firm_naam)) = 0 then
    raise exception 'Kantoornaam is verplicht';
  end if;
  if p_medewerker_naam is null or char_length(trim(p_medewerker_naam)) = 0 then
    raise exception 'Je naam is verplicht';
  end if;

  select email, email_confirmed_at into v_email, v_email_confirmed_at from auth.users where id = v_uid;
  if v_email is null then
    raise exception 'Kon geen e-mailadres vinden voor deze gebruiker';
  end if;
  if v_email_confirmed_at is null then
    raise exception 'Bevestig eerst je e-mailadres via de link in de bevestigingsmail voor je een kantoor aanmaakt.';
  end if;

  if exists (select 1 from public.employees where lower(email) = lower(v_email) and auth_user_id is null) then
    raise exception 'Er staat al een uitnodiging klaar voor dit e-mailadres. Gebruik "Ik heb een uitnodiging" in plaats van een nieuw kantoor aan te maken.';
  end if;

  insert into public.firms (naam) values (trim(p_firm_naam)) returning id into v_firm_id;

  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
  values (v_firm_id, v_uid, trim(p_medewerker_naam), v_email, 'kantoorbeheerder', true, true)
  returning id into v_employee_id;

  if not exists (select 1 from public.public_holidays limit 1) then
    perform public.seed_default_public_holidays(v_employee_id);
  end if;

  perform public.seed_demo_data_for_firm(v_firm_id, v_employee_id);

  return query select v_employee_id, v_firm_id;
end;
$$;

revoke execute on function public.create_firm_and_admin(text, text) from public, anon;

-- ============================================================
-- 2. A (diepteverdediging) — de kalenderherberekening blijft binnen het
--    kantoor van wie de kalender wijzigt.
--
-- Het slot hierboven is de echte maatregel. Deze twee lussen worden er toch
-- bij gescoped: mocht er ooit alsnog een tweede firms-rij ontstaan (bewust,
-- voor een aparte entiteit), dan mag een kantoorbeheerder daarvan nog steeds
-- niet de deadlines van het andere kantoor herschrijven. Zonder dit hangt de
-- integriteit van ~100 dossiers aan één rij in `firms`.
-- ============================================================
create or replace function public.recalc_due_dates_after_holiday_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_new_due date;
  v_actor uuid;
  v_firm uuid;
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

  select firm_id into v_firm from public.employees where id = v_actor;

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op, ti.review_vereist
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    where ti.status = 'open'
      and ti.due_date_wettelijk <= new.datum
      and ti.due_date >= new.datum - 7
      and (v_firm is null or c.firm_id = v_firm)
  loop
    v_new_due := public.next_business_day(r.due_date_wettelijk);
    if v_new_due is distinct from r.due_date then
      perform set_config('taskflow.pipeline_task_id', r.id::text, true);

      if r.due_date_handmatig_op is not null then
        -- M-1: afspraak laten staan, maar wel signaleren.
        if not r.review_vereist then
          update public.task_instances
          set review_vereist = true,
              review_reden = 'De wettelijke basisdatum verschoof (' || v_notitie ||
                             '), maar deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
          where id = r.id;
        end if;
      else
        update public.task_instances set due_date = v_new_due where id = r.id;

        insert into public.task_status_log (
          task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
        ) values (
          r.id, 'due_date_herberekend', r.due_date, v_new_due, v_actor, 'kalender_herberekening', v_notitie
        );
      end if;

      perform set_config('taskflow.pipeline_task_id', '', true);
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.recalc_due_dates_after_holiday_change() from public, anon, authenticated;

-- F: review_reden kreeg letterlijk 'false' als voorvoegsel
-- (`nullif(review_vereist::text, 'true')` levert de string 'false' zodra
-- review_vereist false is) en de bestaande reden werd weggegooid.
create or replace function public.recalc_due_dates_on_legal_calendar_override()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_new_due date;
  v_firm uuid;
begin
  if not new.is_override then
    return new;
  end if;

  select firm_id into v_firm from public.employees where id = new.gewijzigd_door;

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op,
           ti.review_vereist, ti.review_reden
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    where ti.obligation_type_id = new.obligation_type_id
      and ti.status = 'open'
      and (
        extract(year from ti.periode_eind) = new.jaar
        or extract(year from ti.due_date_wettelijk) = new.jaar
      )
      and (new.scope is null or ti.periode_label ilike '%' || new.scope || '%')
      and (v_firm is null or c.firm_id = v_firm)
  loop
    v_new_due := public.next_business_day(new.deadline_datum);
    if v_new_due is distinct from r.due_date or new.deadline_datum is distinct from r.due_date_wettelijk then
      perform set_config('taskflow.pipeline_task_id', r.id::text, true);

      if r.due_date_handmatig_op is not null then
        -- Het wettelijke ijkpunt volgt de kalender, de afgesproken werkdatum
        -- blijft staan — met een signaal (M-1).
        update public.task_instances
        set due_date_wettelijk = new.deadline_datum,
            review_vereist = true,
            review_reden = coalesce(r.review_reden || ' — ', '') ||
              'De wettelijke campagnedatum werd gecorrigeerd naar ' ||
              to_char(new.deadline_datum, 'DD/MM/YYYY') ||
              ', maar deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
        where id = r.id;

        insert into public.task_status_log (
          task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
        ) values (
          r.id, 'due_date_herberekend', r.due_date_wettelijk, new.deadline_datum,
          new.gewijzigd_door, 'kalender_herberekening',
          'Wettelijke datum gecorrigeerd; de handmatig afgesproken deadline is behouden en gemarkeerd voor review.'
        );
      else
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

      perform set_config('taskflow.pipeline_task_id', '', true);
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.recalc_due_dates_on_legal_calendar_override() from public, anon, authenticated;

-- ============================================================
-- 3. J — de voorloper-herkoppeling laat een spoor na
--
-- voorloper_taak_id bepaalt de neerleggingsdeadline (AV + 30 dagen). Dat de
-- engine die koppeling herstelt is correct, maar het mag niet onzichtbaar
-- gebeuren: voor het kantoor verschuift daardoor een wettelijke datum.
-- ============================================================
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
  v_huidige_voorloper uuid;
  v_voorloper_status public.task_status;
begin
  -- H-1: alleen binnen deze functie mag bron_type 'automatisch_gegenereerd'
  -- zijn. De vlag wordt aan het einde altijd gewist; faalt de insert, dan
  -- aborteert de transactie en verdwijnt de vlag mee.
  perform set_config('taskflow.generating', 'on', true);

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
    select id, voorloper_taak_id into v_id, v_huidige_voorloper
    from public.task_instances
    where client_id = p_client_id
      and obligation_type_id = p_obligation_type_id
      and periode_label is not distinct from p_periode_label
      and bron_type = 'automatisch_gegenereerd'
      and status <> 'geannuleerd'
    limit 1;

    -- H-2: bestaat de rij al en wijst haar voorloper naar een taak die
    -- inmiddels geannuleerd is, dan kan de AV-opvolging nooit meer vuren en
    -- blijft de neerlegging voor altijd op een voorlopige datum staan.
    -- Herkoppelen aan de opgegeven (actieve) voorloper lost dat op.
    if p_voorloper_taak_id is not null
       and v_id is not null
       and v_huidige_voorloper is distinct from p_voorloper_taak_id then
      select status into v_voorloper_status
      from public.task_instances where id = v_huidige_voorloper;

      if v_huidige_voorloper is null or v_voorloper_status = 'geannuleerd' then
        perform set_config('taskflow.pipeline_task_id', v_id::text, true);
        update public.task_instances
        set voorloper_taak_id = p_voorloper_taak_id
        where id = v_id;
        perform set_config('taskflow.pipeline_task_id', '', true);

        -- J: zichtbaar maken, want hierdoor verschuift straks een wettelijke
        -- datum.
        insert into public.task_status_log (
          task_instance_id, event_type, actor_employee_id, trigger_bron, notitie
        ) values (
          v_id, 'taak_inhoud_gewijzigd', p_toegewezen, 'av_opvolging_automatisch',
          'Voorloper hergekoppeld aan de nieuwe algemene vergadering nadat de vorige geannuleerd werd; de deadline wordt opnieuw berekend zodra die AV afgerond is.'
        );
      end if;
    end if;
  end if;

  perform set_config('taskflow.generating', 'off', true);
  return v_id;
end;
$$;

revoke execute on function public.upsert_generated_task(
  uuid, uuid, uuid, text, date, date, date, uuid, public.obligation_categorie, boolean, uuid
) from public, anon, authenticated;

-- ============================================================
-- 4. B + C — de UPDATE-trigger op task_instances
--
-- B: due_date_handmatig_op wordt bevroren op de oude waarde vóór de
--    due_date-tak hem daarna legitiem op now() of null zet. Zonder die regel
--    kon iedereen met updaterecht de markering wissen (afspraak wordt alsnog
--    stil overschreven) of zetten zonder due_date aan te raken (taak wordt
--    immuun voor de kalenderpijplijn en blijft op een feestdag staan) — in
--    beide richtingen zonder audittrail.
--
-- C: 0013 maakte zichtbaar dat een toewijzing op een vertrouwelijke klant een
--    toegangsbeslissing is. Nu wordt ze ook als zodanig geautoriseerd:
--    vertrouwelijk en standaard_verantwoordelijke_id zijn sinds 0008/0009
--    kantoorbeheerder-only, dus het effectief binnenlaten van iemand hoort dat
--    ook te zijn. Herverdelen naar een collega die het dossier al kan zien
--    blijft gewoon dagelijks werk.
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
  v_vertrouwelijk boolean;
  v_notitie text;
  v_velden text[];
begin
  -- (b) Onveranderlijke kolommen, bevroren op aanmaakmoment (PLAN 2.7).
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
  -- B: eigendom van de due_date-tak hieronder, van niemand anders.
  new.due_date_handmatig_op := old.due_date_handmatig_op;

  -- L-4: deze twee weigeren luidruchtig i.p.v. stil terug te zetten.
  if new.voorloper_taak_id is distinct from old.voorloper_taak_id and not v_pipeline then
    raise exception
      'De koppeling met de voorloper-taak ligt vast en kan niet handmatig gewijzigd worden; de taakgeneratie herstelt die zelf wanneer de voorloper geannuleerd werd.'
      using errcode = 'insufficient_privilege';
  end if;

  -- H-2 (a): een kantoorbeheerder mag een blijven-hangen "voorlopige" datum
  -- definitief verklaren; voor iedereen anders blijft dit pijplijnwerk.
  if new.voorlopige_datum is distinct from old.voorlopige_datum and not v_pipeline then
    if not (old.voorlopige_datum and not new.voorlopige_datum and public.is_kantoorbeheerder()) then
      raise exception
        'De markering "voorlopige datum" wordt door de datumpijplijn beheerd; enkel een kantoorbeheerder kan een datum definitief verklaren.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- (c) Stempels zijn eigendom van deze trigger.
  new.goedgekeurd_door := old.goedgekeurd_door;
  new.goedgekeurd_op := old.goedgekeurd_op;
  new.afgerond_op := old.afgerond_op;

  if new.status is distinct from old.status then
    v_actor := public.current_employee_id();
    if v_actor is null then
      raise exception 'Statuswijziging vereist een ingelogde, gekoppelde medewerker';
    end if;

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

  -- ---------- Deadlines --------------------------------------
  if new.due_date_wettelijk is distinct from old.due_date_wettelijk and not v_pipeline then
    raise exception
      'due_date_wettelijk kan enkel door de kalenderpijplijn gewijzigd worden; pas de effectieve due_date aan.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.due_date is distinct from old.due_date then
    if v_pipeline then
      -- De pijplijn levert weer een zuiver afgeleide datum: de handmatige
      -- markering vervalt (M-1).
      new.due_date_handmatig_op := null;
    else
      v_actor := coalesce(v_actor, public.current_employee_id());
      if v_actor is null then
        raise exception 'Wijziging van de deadline vereist een ingelogde, gekoppelde medewerker';
      end if;
      new.due_date_handmatig_op := now();
      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        new.id, 'due_date_herberekend', old.due_date, new.due_date, v_actor, 'medewerker_actie',
        'Handmatig aangepast'
      );
    end if;
  end if;

  -- ---------- Toewijzing (+ kantoorgrens, + M-3, + C) --------
  if new.toegewezen_medewerker_id is distinct from old.toegewezen_medewerker_id then
    v_actor := coalesce(v_actor, public.current_employee_id());
    if v_actor is null then
      raise exception 'Herverdeling vereist een ingelogde, gekoppelde medewerker';
    end if;

    select firm_id into v_emp_firm from public.employees where id = new.toegewezen_medewerker_id;
    select firm_id, vertrouwelijk into v_client_firm, v_vertrouwelijk
    from public.clients where id = new.client_id;
    if v_emp_firm is null or v_client_firm is null or v_emp_firm <> v_client_firm then
      raise exception 'De toegewezen medewerker hoort niet bij het kantoor van deze klant'
        using errcode = 'check_violation';
    end if;

    insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron, notitie)
      values (
        new.id, 'toewijzing_gewijzigd', v_actor, 'medewerker_actie',
        format('Herverdeeld van medewerker %s naar %s', old.toegewezen_medewerker_id, new.toegewezen_medewerker_id)
      );

    -- M-3 + C: op een vertrouwelijke klant is een toewijzing niet alleen
    -- werkverdeling maar een toegangsbeslissing. Wie het dossier nog niet kon
    -- zien, kan dat hierna wel. Dat mag alleen een kantoorbeheerder beslissen
    -- (C) en hoort herkenbaar in het log, niet verstopt als gewone
    -- herverdeling (M-3).
    if coalesce(v_vertrouwelijk, false)
       and not public.can_view_client(new.client_id, new.toegewezen_medewerker_id) then
      if not public.is_kantoorbeheerder() then
        raise exception
          'Deze klant is vertrouwelijk en de gekozen collega heeft er nog geen toegang toe. Enkel een kantoorbeheerder kan iemand toegang geven tot een vertrouwelijk dossier.'
          using errcode = 'insufficient_privilege';
      end if;

      insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron, notitie)
        values (
          new.id, 'taak_inhoud_gewijzigd', v_actor, 'medewerker_actie',
          format('Toegang tot vertrouwelijk dossier verleend aan medewerker %s via deze toewijzing',
                 new.toegewezen_medewerker_id)
        );
      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
        values (
          new.client_id, 'toegang_vertrouwelijk_verleend',
          old.toegewezen_medewerker_id::text, new.toegewezen_medewerker_id::text, v_actor
        );
    end if;
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

  -- ---------- Inhoudelijke wijzigingen -----------------------
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
    if new.voorlopige_datum is distinct from old.voorlopige_datum then
      v_velden := array_append(v_velden, 'datum definitief verklaard');
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

-- ============================================================
-- 5. D — employees: identiteitskolommen bevriezen en alles auditen
--
-- employees_update (0005) laat een kantoorbeheerder élke kolom van élke
-- collega herschrijven, zonder enig spoor. Concreet mogelijk vóór deze
-- migratie, in één PATCH:
--   * auth_user_id op null  -> current_employee_id() wordt null -> de collega
--     is buitengesloten;
--   * email naar een eigen adres -> claim_invite() neemt daarna die
--     medewerkersidentiteit inclusief historiek over;
--   * mag_goedkeuren/rol stilzwijgend verhogen -> vier-ogen omzeild, en
--     rol='kantoorbeheerder' opent meteen élk vertrouwelijk dossier.
-- Dat laatste is precies de vraag die een ITAA-controle stelt ("wie mocht deze
-- aangifte goedkeuren, en sinds wanneer"), en daar was geen antwoord op.
--
-- Keuze: auth_user_id en firm_id liggen vast (de koppeling loopt uitsluitend
-- via claim_invite(), die null -> waarde zet); email ligt vast zodra de
-- uitnodiging geclaimd is (een typfout in een openstaande uitnodiging blijft
-- corrigeerbaar); rol, mag_goedkeuren en actief blijven wijzigbaar door een
-- kantoorbeheerder maar worden geaudit.
-- ============================================================
create table if not exists public.employee_change_log (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  veld text not null,
  oude_waarde text,
  nieuwe_waarde text,
  actor_employee_id uuid references public.employees(id),
  created_at timestamptz not null default now(),
  constraint employee_change_log_veld_bekend check (
    veld in ('rol', 'mag_goedkeuren', 'actief', 'email', 'naam')
  )
);

create index if not exists employee_change_log_employee_idx
  on public.employee_change_log (employee_id, created_at desc);

alter table public.employee_change_log enable row level security;

-- Zelfde zichtbaarheid als employees: binnen het eigen kantoor. Append-only:
-- geen INSERT-, UPDATE- of DELETE-policy, de trigger schrijft als definer.
drop policy if exists "employee_change_log_select" on public.employee_change_log;
create policy "employee_change_log_select" on public.employee_change_log
  for select using (
    exists (
      select 1 from public.employees e
      where e.id = employee_change_log.employee_id
        and e.firm_id = public.current_employee_firm_id()
    )
  );

create or replace function public.enforce_employee_update_integrity()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
begin
  -- Het kantoor van een medewerker ligt vast.
  if new.firm_id is distinct from old.firm_id then
    raise exception 'Het kantoor van een medewerker ligt vast en kan niet gewijzigd worden.'
      using errcode = 'insufficient_privilege';
  end if;

  -- De koppeling met het inlogaccount loopt uitsluitend via claim_invite():
  -- die zet null -> waarde. Loskoppelen of omhangen kan niet; een medewerker
  -- die weg is, wordt gedeactiveerd (actief = false), niet ontkoppeld.
  if new.auth_user_id is distinct from old.auth_user_id and old.auth_user_id is not null then
    raise exception
      'De koppeling met het inlogaccount ligt vast. Deactiveer de medewerker in plaats van het account los te koppelen.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Zolang de uitnodiging openstaat mag het adres nog gecorrigeerd worden;
  -- daarna niet meer, anders is de medewerkersidentiteit via claim_invite()
  -- over te nemen.
  if new.email is distinct from old.email and old.auth_user_id is not null then
    raise exception
      'Het e-mailadres van een gekoppelde medewerker ligt vast; het is de identiteit waarmee die persoon inlogt.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.rol is distinct from old.rol then
    insert into public.employee_change_log (employee_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
    values (new.id, 'rol', old.rol::text, new.rol::text, v_actor);
  end if;
  if new.mag_goedkeuren is distinct from old.mag_goedkeuren then
    insert into public.employee_change_log (employee_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
    values (new.id, 'mag_goedkeuren', old.mag_goedkeuren::text, new.mag_goedkeuren::text, v_actor);
  end if;
  if new.actief is distinct from old.actief then
    insert into public.employee_change_log (employee_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
    values (new.id, 'actief', old.actief::text, new.actief::text, v_actor);
  end if;
  if new.email is distinct from old.email then
    insert into public.employee_change_log (employee_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
    values (new.id, 'email', old.email, new.email, v_actor);
  end if;
  if new.naam is distinct from old.naam then
    insert into public.employee_change_log (employee_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
    values (new.id, 'naam', old.naam, new.naam, v_actor);
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_employee_update_integrity() from public, anon, authenticated;

-- AFTER, niet BEFORE: de FK van employee_change_log naar employees(id) is bij
-- een UPDATE altijd vervulbaar, maar we willen de logregels pas schrijven als
-- de rij daadwerkelijk gewijzigd is. De weigeringen hierboven werken ook vanuit
-- een AFTER-trigger als harde blokkade: de exception draait de hele UPDATE
-- terug binnen dezelfde transactie.
drop trigger if exists trg_employees_update_integrity on public.employees;
create trigger trg_employees_update_integrity
  after update on public.employees
  for each row
  execute function public.enforce_employee_update_integrity();

-- ============================================================
-- 6. H — de dode kanban-tabellen uit 0001/0002 afsluiten
--
-- boards/columns/labels/tasks/task_labels horen bij de generieke kanban-app
-- van vóór de domeinherziening. Ze staan nog met user_id = auth.uid()-policies
-- en zijn dus RLS-veilig, maar élke geregistreerde gebruiker — ook iemand
-- zonder employees-rij — kan er onbeperkt rijen in schrijven. Ze worden niet
-- gedropt (0001/0002 blijven als geschiedenis staan), alleen onbereikbaar
-- gemaakt via PostgREST.
-- ============================================================
revoke all on public.boards, public.columns, public.labels, public.tasks, public.task_labels
  from anon, authenticated;

-- ============================================================
-- 7. Advisor — vaste search_path, en geen anon-EXECUTE op helpers
--
-- Alle drie zijn SECURITY INVOKER, dus dit is geen rechtenverhoging; het is
-- het opruimen van wat 0011 §7 bij de andere triggerfuncties al gedaan had.
-- ============================================================
alter function public.set_updated_at() set search_path = public;
alter function public.normalize_employee_email() set search_path = public;
alter function public.fiscal_year_end(integer, integer, integer) set search_path = public;

revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.normalize_employee_email() from public, anon, authenticated;
revoke execute on function public.fiscal_year_end(integer, integer, integer) from public, anon;
