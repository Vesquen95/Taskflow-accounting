-- ============================================================
-- 0032 — De rechten op de functies van 0029 en 0030 rechtzetten
--
-- Gevonden bij de securityronde op deze reeks. Drie functies uit 0029 en 0030
-- kregen geen `revoke execute`, terwijl elke vergelijkbare functie in dit
-- project dat wél heeft (enforce_av_parameters, herbereken_av_taken,
-- flag_tasks_for_review, ...). Supabase zet elke functie in het publieke
-- schema automatisch open via /rest/v1/rpc, dus "niet expliciet ingetrokken"
-- betekent hier "voor iedereen aanroepbaar".
--
-- Twee ervan zijn triggerfuncties; die weigeren buiten een trigger sowieso.
-- De derde niet:
--
--   herbereken_jaarafsluiting_taken_voor(uuid)
--
-- Die is SECURITY DEFINER, neemt een willekeurige client_id, en deed geen
-- enkele toegangscontrole. Nagespeeld op productie met de gewone
-- testmedewerker (rol 'medewerker', geen kantoorbeheerder): één aanroep
-- verzette drie wettelijke deadlines van 01/02/2027 naar 31/12/2026 en
-- schreef daar logregels bij op naam van die medewerker. Voor een dossier
-- waar hij geen toegang toe heeft, werkte dat net zo goed -- can_access_client()
-- kwam er niet aan te pas.
--
-- In een systeem dat wettelijke deadlines bewaakt is een taak stil verzetten
-- ongeveer het ergste wat je open kunt laten staan: er verschijnt geen fout,
-- de kalender ziet er normaal uit, en de deadline is verschoven.
--
-- Twee sloten, want één is er hier één te weinig:
--   1. de rechten intrekken, zodat de functie niet meer via de API bereikbaar
--      is (dat alleen sluit dit gat al volledig);
--   2. een toegangscontrole ín de functie, zoals sync_client_tasks() die ook
--      heeft. Is er een ingelogde medewerker, dan moet die het dossier mogen
--      zien. Is er er géén, dan draait dit vanuit onderhoud en gaat het door.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De toegangscontrole
-- ------------------------------------------------------------
create or replace function public.herbereken_jaarafsluiting_taken_voor(p_client_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_ot_jaarafsluiting uuid;
  v_parameters jsonb;
  v_basis text;
  v_sla_maanden int;
  v_maanden_voor_av int;
  v_av_parameters jsonb;
  v_av_due date;
  v_nieuw date;
  v_aantal int := 0;
  r record;
begin
  -- Wie ingelogd is, moet het dossier mogen zien. Zonder ingelogde medewerker
  -- draait dit vanuit het maandelijkse onderhoud en is er niemand om tegen te
  -- toetsen; die weg loopt niet via de API.
  if v_actor is not null and not public.can_access_client(p_client_id) then
    raise exception 'Je hebt geen toegang tot dit klantdossier'
      using errcode = 'insufficient_privilege';
  end if;

  select id into v_ot_jaarafsluiting from public.obligation_types where code = 'jaarafsluiting';
  if v_ot_jaarafsluiting is null then
    return 0;
  end if;

  select co.parameters into v_parameters
  from public.client_obligations co
  where co.client_id = p_client_id
    and co.obligation_type_id = v_ot_jaarafsluiting
    and co.actief
    and co.geldig_vanaf <= current_date
    and (co.geldig_tot is null or co.geldig_tot >= current_date)
  order by co.created_at desc
  limit 1;

  if v_parameters is null then
    return 0;
  end if;

  v_basis := coalesce(v_parameters->>'basis', 'boekjaar');
  v_sla_maanden := coalesce((v_parameters->>'sla_maanden')::int, 3);
  v_maanden_voor_av := coalesce((v_parameters->>'maanden_voor_av')::int, 1);

  if v_basis = 'voor_av' then
    select co.parameters into v_av_parameters
    from public.client_obligations co
    join public.obligation_types ot on ot.id = co.obligation_type_id
    where co.client_id = p_client_id
      and ot.code = 'algemene_vergadering'
      and co.actief
    order by co.created_at desc
    limit 1;
  end if;

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.periode_eind,
           ti.due_date_handmatig_op, ti.review_reden
    from public.task_instances ti
    where ti.client_id = p_client_id
      and ti.obligation_type_id = v_ot_jaarafsluiting
      and ti.bron_type = 'automatisch_gegenereerd'
      and ti.status = 'open'
      and ti.due_date >= current_date
  loop
    if v_basis = 'voor_av' then
      v_av_due := coalesce(public.av_datum(r.periode_eind, v_av_parameters),
                           (r.periode_eind + interval '6 months')::date);
      v_nieuw := (v_av_due - (v_maanden_voor_av || ' months')::interval)::date;
      if v_nieuw < r.periode_eind then
        v_nieuw := r.periode_eind;
      end if;
    else
      v_nieuw := (r.periode_eind + (v_sla_maanden || ' months')::interval)::date;
    end if;

    continue when v_nieuw is not distinct from r.due_date_wettelijk;

    perform set_config('taskflow.pipeline_task_id', r.id::text, true);
    if r.due_date_handmatig_op is not null then
      update public.task_instances
      set due_date_wettelijk = v_nieuw,
          review_vereist = true,
          review_reden = coalesce(r.review_reden || ' — ', '') ||
            'De berekening van de jaarafsluiting is gewijzigd; de wettelijke datum wordt ' ||
            to_char(v_nieuw, 'DD/MM/YYYY') ||
            '. Deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
      where id = r.id;
    else
      update public.task_instances
      set due_date_wettelijk = v_nieuw,
          due_date = public.next_business_day(v_nieuw)
      where id = r.id;
    end if;
    perform set_config('taskflow.pipeline_task_id', '', true);

    insert into public.task_status_log (
      task_instance_id, event_type, oude_due_date, nieuwe_due_date,
      actor_employee_id, trigger_bron, notitie
    ) values (
      r.id, 'due_date_herberekend', r.due_date, public.next_business_day(v_nieuw),
      v_actor, 'kalender_herberekening',
      case when v_basis = 'voor_av'
        then 'De jaarafsluiting wordt nu ' || v_maanden_voor_av ||
             ' maand(en) voor de algemene vergadering gepland; de deadline staat op ' ||
             to_char(v_nieuw, 'DD/MM/YYYY') || '.'
        else 'De jaarafsluiting wordt nu ' || v_sla_maanden ||
             ' maand(en) na het boekjaareinde gepland; de deadline staat op ' ||
             to_char(v_nieuw, 'DD/MM/YYYY') || '.'
      end
    );
    v_aantal := v_aantal + 1;
  end loop;

  return v_aantal;
end;
$$;

-- ------------------------------------------------------------
-- 2. De rechten, precies zoals bij de gelijkaardige functies
-- ------------------------------------------------------------
revoke execute on function public.herbereken_jaarafsluiting_taken_voor(uuid)
  from public, anon, authenticated;
revoke execute on function public.herbereken_jaarafsluiting_taken()
  from public, anon, authenticated;
revoke execute on function public.enforce_jaarafsluiting_parameters()
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Een vaste search_path op de twee AV-hulpfuncties
--
-- Niet van deze ronde (ze staan er sinds 0020), maar de linter wijst ze
-- terecht aan: ze zijn voor een ingelogde gebruiker aanroepbaar en laten hun
-- search_path aan de aanroeper over. Ze zijn allebei read-only en verwijzen
-- volledig gekwalificeerd, dus er valt vandaag niets mee te doen -- maar een
-- vaste search_path is één regel en haalt de twijfel weg.
-- ------------------------------------------------------------
alter function public.av_weekdag_nummer(text) set search_path = public;
alter function public.av_datum(date, jsonb) set search_path = public;
