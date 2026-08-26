-- Taskflow v1 — herkomst van gegenereerde taken, herstelbaarheid van de
-- neerleggingsdatum, en bescherming van handmatige deadline-afspraken.
--
-- Aanleiding: de vierde security-verificatie (na 0012). B-1 bleek structureel
-- dicht, het audittrail niet manipuleerbaar en de klant-isolatie intact, maar
-- twee HIGH-bevindingen blokkeerden nog de go-live, plus twee medium punten.
-- Alles hieronder is als gewone `medewerker` gereproduceerd.
--
-- Additief: 0003-0012 zijn al toegepast en worden NIET gewijzigd.
--
-- Opgeloste bevindingen:
--   H-1 (High)   bron_type was vervalsbaar bij INSERT. Een medewerker kon een
--                rij aanmaken die zich voordeed als engine-output met dezelfde
--                (klant, verplichting, periode) als een echte, en daarmee de
--                plek bezetten: upsert_generated_task botst dan op de unieke
--                index, doet `do nothing`, en geeft sinds 0012 juist die
--                vervalste rij terug als "de actieve rij". De echte wettelijke
--                verplichting werd zo permanent onderdrukt, met een verzonnen
--                due_date_wettelijk die door de bevriezing niemand nog kon
--                corrigeren.
--   H-2 (High)   De neerlegging jaarrekening kon permanent op een foute
--                voorlopige datum vastlopen: na annulering + hergeneratie van
--                de AV bleef de neerlegging naar de geannuleerde AV wijzen,
--                dus de +30-dagenberekening vuurde nooit. Elke correctiepoging
--                (voorloper herkoppelen, voorlopige_datum uitzetten) werd stil
--                teruggezet en meldde succes.
--   M-1 (Medium) Een nieuwe feestdag overschreef stil elk handmatig
--                afgesproken uitstel.
--   M-3 (Medium) Een collega toewijzen op een vertrouwelijke klant verleent
--                die persoon het volledige dossier, maar verscheen in het log
--                als een gewone herverdeling.
--   M-4 (Medium) Vier RPC's hadden nog het PUBLIC-default EXECUTE-recht.
--   L-2 (Low)    De AV-fallback in 0006 miste `status <> 'geannuleerd'` en
--                `limit 1` en was daardoor niet-deterministisch sinds 0012.

-- ============================================================
-- 0. H-1 — generatie-vlag: alleen de engine mag engine-output maken
--
-- Zelfde patroon als de pijplijnvlag uit 0012, en met hetzelfde argument:
-- upsert_generated_task() is SECURITY DEFINER en niet uitvoerbaar door
-- `authenticated`, dus een PostgREST-client kan deze vlag niet zetten. Alleen
-- schrijfacties die door de engine lopen mogen `bron_type` zelf kiezen; al de
-- rest wordt naar 'handmatig_adhoc' geduwd. De bestaande
-- `task_instances_adhoc_shape`-constraint (0003) dwingt dan meteen af dat zo'n
-- rij géén obligation_type_id mag dragen — waarmee het bezetten van een
-- periode-slot structureel onmogelijk wordt in plaats van alleen ontraden.
-- ============================================================
create or replace function public.taskflow_generating()
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce(current_setting('taskflow.generating', true), 'off') = 'on';
$$;

revoke execute on function public.taskflow_generating() from public, anon, authenticated;

-- ============================================================
-- 1. M-1 — handmatige deadline-afspraken herkenbaar maken
--
-- Zonder deze markering kon de kalenderpijplijn niet weten dat een due_date
-- een afspraak was in plaats van een berekening, en overschreef een nieuwe
-- feestdag stil een maand uitstel. De kolom wordt gezet door dezelfde trigger
-- die de "Handmatig aangepast"-logregel schrijft, en gewist zodra de pijplijn
-- de datum opnieuw berekent (dan is er weer een zuiver afgeleide datum).
-- ============================================================
alter table public.task_instances
  add column if not exists due_date_handmatig_op timestamptz;

comment on column public.task_instances.due_date_handmatig_op is
  'Gezet wanneer een medewerker de effectieve due_date handmatig verzet (migratie 0013, M-1). '
  'De kalender-/feestdagpijplijn overschrijft zo een afspraak niet meer stil, maar markeert de taak '
  'als review_vereist wanneer de onderliggende wettelijke datum verschuift.';

-- ============================================================
-- 2. H-2 (b) + L-2 — de engine herstelt een verweesde neerlegging-koppeling
--
-- upsert_generated_task krijgt de generatie-vlag (H-1) en repareert meteen de
-- situatie uit H-2: bestaat er al een actieve rij, dan wordt haar
-- voorloper_taak_id bijgewerkt wanneer die naar een geannuleerde of afgeronde
-- voorloper wijst. Die update gaat door de pijplijnvlag van 0012, zodat de
-- bevriezing in enforce_task_instance_transition intact blijft.
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
-- 3. H-1 + H-2 — INSERT: bron_type afdwingen
-- ============================================================
create or replace function public.enforce_task_instance_insert_provenance()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_categorie public.obligation_categorie;
  v_voorloper_client uuid;
begin
  -- H-1: engine-output kan alleen uit de engine komen.
  if not public.taskflow_generating() then
    new.bron_type := 'handmatig_adhoc';
  end if;

  if new.obligation_type_id is null then
    new.vereist_goedkeuring := false;
  else
    select categorie into v_categorie from public.obligation_types where id = new.obligation_type_id;
    if v_categorie is null then
      raise exception 'Onbekend verplichtingtype' using errcode = 'foreign_key_violation';
    end if;
    new.vereist_goedkeuring := (v_categorie = 'wettelijk');
  end if;

  new.status := 'open';
  new.goedgekeurd_door := null;
  new.goedgekeurd_op := null;
  new.afgerond_op := null;
  new.due_date_handmatig_op := null;

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

-- ============================================================
-- 4. H-2 (a/c) + M-1 + M-3 — UPDATE-trigger
--
-- Verschillen t.o.v. de 0012-versie:
--   * voorloper_taak_id en voorlopige_datum worden niet langer STIL
--     teruggezet maar weigeren met een exception (L-4). Een stille reset met
--     HTTP 200 was juist bij deze twee velden misleidend: het zijn precies de
--     velden die een beheerder legitiem wil corrigeren (H-2).
--   * voorlopige_datum mag door een kantoorbeheerder uitgezet worden, met
--     logregel — anders is een verkeerd gebleven "voorlopige" NBB-datum door
--     niemand meer recht te zetten.
--   * een handmatige due_date-wijziging zet due_date_handmatig_op (M-1); de
--     pijplijn wist die markering weer.
--   * toewijzing op een vertrouwelijke klant naar iemand die het dossier nog
--     niet kon zien, krijgt een herkenbare logregel én een
--     client_change_log-entry (M-3).
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
  -- (b) Onveranderlijke kolommen, bevroren op aanmaakmoment (PLAN §2.7).
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

  -- ---------- Toewijzing (+ kantoorgrens, + M-3) -------------
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

    -- M-3: op een vertrouwelijke klant is een toewijzing niet alleen
    -- werkverdeling maar een toegangsbeslissing. Wie het dossier nog niet kon
    -- zien, kan dat hierna wel — dat hoort herkenbaar in het log, niet
    -- verstopt als gewone herverdeling.
    if coalesce(v_vertrouwelijk, false)
       and not public.can_view_client(new.client_id, new.toegewezen_medewerker_id) then
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
-- 5. M-1 — de kalenderpijplijnen respecteren een handmatige afspraak
--
-- Keuze: een handmatig verzette due_date wordt NOOIT stil overschreven. De
-- taak wordt in plaats daarvan op review_vereist gezet met een leesbare reden,
-- zodat het kantoor zelf beslist of de afspraak nog houdbaar is nu de
-- wettelijke basis verschoven is. Stil terugdraaien was het probleem; stil
-- laten staan zonder iemand te verwittigen zou het spiegelbeeld zijn.
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
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op, ti.review_vereist
    from public.task_instances ti
    where ti.status = 'open'
      and ti.due_date_wettelijk <= new.datum
      and ti.due_date >= new.datum - 7
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
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op, ti.review_vereist
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

      if r.due_date_handmatig_op is not null then
        -- Het wettelijke ijkpunt volgt de kalender, de afgesproken werkdatum
        -- blijft staan — met een signaal (M-1).
        update public.task_instances
        set due_date_wettelijk = new.deadline_datum,
            review_vereist = true,
            review_reden = coalesce(nullif(r.review_vereist::text, 'true'), '') ||
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
-- 6. M-4 — de vier RPC's hadden nog het PUBLIC-default EXECUTE-recht.
--    Niet direct uitbuitbaar (ze weigeren zelf zonder geldige identiteit),
--    maar 0011 §7 heeft dit bij de helpers wél opgeruimd en hier niet.
-- ============================================================
revoke execute on function public.create_firm_and_admin(text, text) from public, anon;
revoke execute on function public.invite_employee(text, text, public.employee_rol, boolean) from public, anon;
revoke execute on function public.claim_invite() from public, anon;
revoke execute on function public.generate_task_instances(int, int) from public, anon;
