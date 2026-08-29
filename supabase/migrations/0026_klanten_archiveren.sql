-- Taskflow v1 -- klanten archiveren.
--
-- Aanleiding: het kantoor. "Klanten archiveren. Als een klant dan wordt
-- gearchiveerd moeten de taken automatisch geannuleerd of ook gearchiveerd
-- worden."
--
-- clients.actief bestond al, en generate_task_instances_intern() slaat een
-- inactieve klant over -- er kwamen dus geen taken meer bij. Maar er stond geen
-- enkele trigger op clients die de taken opruimde die er al waren. Een
-- gearchiveerde klant verdween daardoor uit de klantenlijst terwijl zijn
-- openstaande taken in de werkstroomblokken bleven staan, op naam van een
-- medewerker, met een deadline die niemand nog ging halen. Bij honderd dossiers
-- is dat precies het soort stille rommel waar dit systeem al twee keer op
-- vastgelopen is.
--
-- Drie regels sturen deze migratie:
--
--   1. "Verwijderen bestaat niet" (zie docs/PLAN.md en migratie 0021).
--      Annuleren haalt de taak uit alle lijsten en houdt hem in de
--      geschiedenis van het dossier. Er komt dus GEEN aparte archiefstatus
--      voor taken bij: dat zou een tweede manier zijn om hetzelfde te zeggen,
--      en elke lijst, filter en telling zou ze allebei moeten kennen.
--
--   2. Afgesloten werk blijft afgesloten. Taken met status
--      'ingediend_afgerond' of 'geannuleerd' worden niet aangeraakt -- dat is
--      werk dat gebeurd is, of al afgesloten.
--      enforce_task_instance_transition() weigert die overgangen sowieso.
--
--   3. Niets gebeurt in stilte. Elke geannuleerde taak krijgt haar eigen regel
--      in task_status_log, op naam van wie archiveerde, met een notitie die
--      zegt waarom. En het dossier zelf houdt bij hoeveel taken het gekost
--      heeft, naast de bestaande 'actief'-regel in client_change_log.
--
-- Het omgekeerde -- een klant die weer op actief gezet wordt -- vroeg geen
-- code. De geannuleerde taken komen niet terug (dat hoort ook niet: ze zijn
-- geannuleerd, niet vergeten), maar de partiele unieke index op
-- (client_id, obligation_type_id, periode_label) telt alleen rijen met status
-- <> 'geannuleerd' mee, dus upsert_generated_task() maakt bij de eerstvolgende
-- ronde gewoon nieuwe taken aan voor de verplichtingen die nog lopen -- zonder
-- dubbels. Alleen periodes waarvan de deadline intussen verstreken is komen
-- niet terug; dat is de regel uit 0018 (geen taken in het verleden) en die
-- blijft hier gelden. Sectie 34 van de regressietests legt dat gedrag vast.
--
-- Nevengevolg, bewust en niet weggewerkt: bij een VERTROUWELIJKE klant loopt de
-- toegang van een gewone medewerker via "ik heb hier een niet-geannuleerde
-- taak" (can_view_client, 0004/0008). Na het archiveren is er geen enkele
-- niet-geannuleerde taak meer, dus blijft zo'n dossier alleen nog zichtbaar
-- voor een kantoorbeheerder. Dat is de bedoelde kant op (minder toegang, niet
-- meer), maar het betekent ook dat wie zelf archiveert het dossier daarna niet
-- meer terugvindt. Het scherm waarschuwt daarvoor voor het archiveren.
--
-- Additief: 0003-0025 zijn al toegepast en worden NIET gewijzigd.

-- ============================================================
-- 1. De vlag: "deze klant wordt op dit moment gearchiveerd"
--
-- Zelfde patroon als taskflow_generating() (0013) en
-- taskflow_pipeline_owns_row() (0012): een transactie-lokale vlag die de
-- trigger hieronder rond zijn eigen update zet. Een PostgREST-client kan hem
-- niet zetten -- er is geen RPC die dat doet en elke request draait in een
-- eigen transactie -- en de vlag stuurt hoe dan ook geen enkele autorisatie:
-- ze bepaalt uitsluitend welke notitie in het log terechtkomt.
-- ============================================================
create or replace function public.taskflow_archiveert_klant(p_client_id uuid)
returns boolean
language sql stable
set search_path = public
as $$
  -- coalesce is niet cosmetisch: current_setting(..., true) geeft NULL wanneer
  -- de vlag nooit gezet is, en NULL zou hier via `when ... then` stilzwijgend
  -- als "niet waar" en elders als "onbekend" lezen.
  select coalesce(
    nullif(current_setting('taskflow.klant_archivering', true), '') = p_client_id::text,
    false
  );
$$;

comment on function public.taskflow_archiveert_klant(uuid) is
  'True wanneer deze transactie op dit moment exact deze klant aan het archiveren is (migratie 0026). Stuurt enkel de notitie in task_status_log, geen enkele autorisatie.';

revoke execute on function public.taskflow_archiveert_klant(uuid) from public, anon, authenticated;

-- ============================================================
-- 2. De statusregel vertelt waarom
--
-- Ongewijzigd t.o.v. 0014 op een na: de notitie bij een annulering. Stond daar
-- tot nu toe altijd "de taakgeneratie kan deze periode opnieuw aanmaken", en
-- dat is bij een gearchiveerde klant het tegenovergestelde van waar --
-- generate_task_instances_intern() slaat een inactieve klant juist over. Een
-- tweede logregel ernaast schrijven was het alternatief, maar dan staan er
-- twee status_wijziging-regels voor een overgang die maar een keer gebeurde.
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
  -- Zet door annuleer_taken_bij_archivering() (0026), transactie-lokaal en
  -- alleen voor de klant die op dat moment gearchiveerd wordt.
  v_archivering boolean := public.taskflow_archiveert_klant(old.client_id);
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
      -- 0026: de klant wordt op dit moment gearchiveerd. Dan is de gewone
      -- notitie hieronder ronduit misleidend -- de taakgeneratie slaat een
      -- inactieve klant juist over -- dus zegt de logregel wat er echt gebeurde.
      when new.status = 'geannuleerd' and v_archivering then
        'Klant gearchiveerd; deze taak is daarbij automatisch geannuleerd. Zolang de klant gearchiveerd blijft, maakt de taakgeneratie geen nieuwe taken meer aan.'
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

-- De trigger zelf blijft die van 0012 (before update, for each row); alleen de
-- functie erachter is vervangen.

-- ============================================================
-- 3. Archiveren ruimt het dossier op
--
-- Alles wat nog niet afgesloten is wordt geannuleerd: open, in uitvoering,
-- wachtend op de klant en wachtend op goedkeuring. Ook ad-hoc taken -- ook die
-- gaan over een klant die het kantoor niet meer bedient.
--
-- De trigger draait binnen de sessie van de gebruiker, dus auth.uid() is
-- beschikbaar en de bestaande controle op een ingelogde medewerker in
-- enforce_task_instance_transition() blijft gewoon werken. Sterker: hij is al
-- afgedwongen voor we hier zijn -- block_unaudited_confidentiality_change()
-- (0011) rekent 'actief' tot de geauditeerde velden en weigert de wijziging
-- zonder gekoppelde medewerker.
-- ============================================================
create or replace function public.annuleer_taken_bij_archivering()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_aantal int := 0;
begin
  if v_actor is null then
    raise exception 'Een klant archiveren vereist een ingelogde, gekoppelde medewerker';
  end if;

  perform set_config('taskflow.klant_archivering', new.id::text, true);

  -- Een gewone update: de bestaande UPDATE-trigger op task_instances doet de
  -- overgangscontrole en schrijft per taak haar statusregel. Zo kan deze
  -- opruiming per definitie niets wat een medewerker niet ook met de hand had
  -- mogen doen.
  update public.task_instances
     set status = 'geannuleerd'
   where client_id = new.id
     and status not in ('ingediend_afgerond', 'geannuleerd');
  get diagnostics v_aantal = row_count;

  perform set_config('taskflow.klant_archivering', '', true);

  -- Het aantal hoort bij het dossier, niet alleen verspreid over zestig taken:
  -- de wijzigingshistoriek van de klant is de plek waar je achteraf leest wat
  -- het archiveren gekost heeft.
  if v_aantal > 0 then
    insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
    values (new.id, 'taken_geannuleerd_bij_archivering', null, v_aantal::text, v_actor);
  end if;

  return null;
end;
$$;

comment on function public.annuleer_taken_bij_archivering() is
  'Annuleert bij het archiveren van een klant al zijn nog niet afgesloten taken (migratie 0026). Afgeronde en eerder geannuleerde taken blijven ongemoeid; elke annulering krijgt haar eigen regel in task_status_log en het aantal komt in client_change_log.';

revoke execute on function public.annuleer_taken_bij_archivering() from public, anon, authenticated;

-- Alleen op de overgang actief -> gearchiveerd. Een tweede opslag van een al
-- gearchiveerde klant mag niet opnieuw door het hele dossier lopen, en een
-- heractivering hoort hier niets te doen.
drop trigger if exists trg_clients_archiveren on public.clients;
create trigger trg_clients_archiveren
  after update of actief on public.clients
  for each row
  when (old.actief and not new.actief)
  execute function public.annuleer_taken_bij_archivering();
