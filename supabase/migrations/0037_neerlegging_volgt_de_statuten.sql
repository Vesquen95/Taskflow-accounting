-- ============================================================
-- 0037 — De neerlegging schuift niet mee met een late vergadering
--
-- Gevonden in de testronde met honderd dossiers (03/09/2026).
--
-- Wat er gebeurde: bij het afvinken van de algemene vergadering zette
-- recalc_neerlegging_after_av() de neerlegging op "afgerond_op + 30 dagen".
-- Voor een AV die op tijd doorgaat klopt dat — de wet geeft je dertig dagen
-- na de goedkeuring. Maar voor een AV die te laat gehouden wordt, schoof de
-- deadline mee naar voren. In de test kregen 57 dossiers zo een neerlegging
-- op 02/10/2026, ook een klant met boekjaar 31/12/2025 voor wie de uiterste
-- datum 31/07/2026 was. Het scherm toonde dan een deadline die comfortabel in
-- de toekomst lag terwijl de klant al te laat was en de neerleggingskosten bij
-- de NBB al aan het oplopen waren.
--
-- De regel van het kantoor: de statuten blijven het ijkpunt. Gaat de
-- vergadering niet door op die dag, dan is het dossier gewoon te laat — dat
-- hoort dringend te ogen, niet uitgesteld.
--
-- Dus:
--
--   neerlegging = de vroegste van
--                   (a) de dag waarop de AV effectief afgerond werd + 30 dagen
--                   (b) de geplande AV-datum + 30 dagen
--
-- (a) alleen is wat er stond en schuift op bij te laat. (b) is de bovengrens:
-- de statutaire datum, of bij dossiers zonder statutaire datum de wettelijke
-- uiterste datum (boekjaareinde + 6 maanden). Die grens valt daarmee vanzelf
-- samen met de wettelijke uiterste neerlegging van zeven maanden na het
-- boekjaareinde.
--
-- Wat blijft: gaat de AV vróéger door, dan komt de neerlegging ook vroeger.
-- De termijn van dertig dagen loopt vanaf de goedkeuring, en strenger dan de
-- planning is nooit een probleem.
--
-- De logregel zegt welk van de twee gold. Anders staat er straks een datum in
-- het dossier waarvan niemand nog weet waar hij vandaan komt.
-- ============================================================

create or replace function public.recalc_neerlegging_after_av()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_ot_av uuid;
  v_ot_neerlegging uuid;
  v_actor uuid;
  v_afgerond date;
  v_gepland date;
  v_raw date;
  v_due date;
  v_notitie text;
  r record;
begin
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_neerlegging from public.obligation_types where code = 'neerlegging_jaarrekening';

  if new.status = 'ingediend_afgerond' and old.status <> 'ingediend_afgerond' and new.obligation_type_id = v_ot_av then
    v_actor := coalesce(public.current_employee_id(), new.toegewezen_medewerker_id);

    v_afgerond := coalesce(new.afgerond_op::date, current_date);
    -- De geplande datum, niet de eventueel handmatig verzette: de statuten
    -- (of de wettelijke uiterste datum) zijn het ijkpunt.
    v_gepland := new.due_date_wettelijk;

    if v_gepland is null then
      v_raw := v_afgerond + 30;
      v_notitie := 'Definitieve datum berekend op basis van de effectieve afronding van de AV (+30 dagen).';
    elsif v_afgerond > v_gepland then
      -- Te laat vergaderd. De neerlegging schuift niet mee: ze blijft staan op
      -- de geplande AV-datum + 30 dagen, en is daarmee zelf te laat.
      v_raw := v_gepland + 30;
      v_notitie := format(
        'De algemene vergadering ging door op %s, na de geplande datum %s. De neerlegging blijft staan op %s (geplande AV + 30 dagen): een late vergadering geeft geen extra tijd om neer te leggen.',
        to_char(v_afgerond, 'DD/MM/YYYY'), to_char(v_gepland, 'DD/MM/YYYY'),
        to_char(v_gepland + 30, 'DD/MM/YYYY')
      );
    else
      v_raw := v_afgerond + 30;
      v_notitie := format(
        'Definitieve datum: de AV werd afgerond op %s, dus dertig dagen later.',
        to_char(v_afgerond, 'DD/MM/YYYY')
      );
    end if;

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
      perform set_config('taskflow.pipeline_task_id', r.id::text, true);

      update public.task_instances
      set due_date_wettelijk = v_raw, due_date = v_due, voorlopige_datum = false
      where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date_wettelijk, v_raw, v_actor, 'av_opvolging_automatisch',
        v_notitie
      );

      perform set_config('taskflow.pipeline_task_id', '', true);
    end loop;
  end if;

  return new;
end;
$$;

comment on function public.recalc_neerlegging_after_av() is
  'Zet de definitieve neerleggingsdatum zodra de AV afgerond is: de vroegste van (effectieve afronding + 30 dagen) en (geplande AV-datum + 30 dagen). Een te late vergadering schuift de neerlegging dus niet vooruit — het dossier is dan gewoon te laat (0037).';

revoke execute on function public.recalc_neerlegging_after_av() from public, anon, authenticated;

-- ------------------------------------------------------------
-- Herstel van wat er al staat
--
-- Dossiers waarvan de AV al afgevinkt is, dragen nog de datum van de oude
-- regel. Laten staan zou betekenen dat dezelfde vraag twee antwoorden heeft,
-- afhankelijk van wanneer je toevallig op de knop drukte. Dus rekenen we ze
-- opnieuw uit -- alleen wat nog openstaat, en alleen wat niemand handmatig
-- heeft vastgezet.
--
-- Een datum kan hierdoor naar het verleden schuiven. Dat is geen verlies maar
-- de waarheid: die neerlegging was al te laat, ze zag er alleen niet zo uit.
-- ------------------------------------------------------------
do $herstel$
declare
  r record;
  v_raw date;
  v_aantal int := 0;
begin
  for r in
    select nl.id, nl.due_date_wettelijk as oude,
           nl.toegewezen_medewerker_id as actor,
           least(av.afgerond_op::date, av.due_date_wettelijk) + 30 as nieuwe
    from public.task_instances nl
    join public.task_instances av on av.id = nl.voorloper_taak_id
    join public.obligation_types ot on ot.id = nl.obligation_type_id
    where ot.code = 'neerlegging_jaarrekening'
      and nl.bron_type = 'automatisch_gegenereerd'
      and nl.status not in ('ingediend_afgerond', 'geannuleerd')
      and nl.due_date_handmatig_op is null
      and av.status = 'ingediend_afgerond'
      and av.afgerond_op is not null
      and av.due_date_wettelijk is not null
      and nl.due_date_wettelijk is distinct from least(av.afgerond_op::date, av.due_date_wettelijk) + 30
  loop
    v_raw := r.nieuwe;
    perform set_config('taskflow.pipeline_task_id', r.id::text, true);

    update public.task_instances
    set due_date_wettelijk = v_raw, due_date = public.next_business_day(v_raw)
    where id = r.id;

    -- actor_employee_id is verplicht en er is hier geen mens aan de knoppen:
    -- de verantwoordelijke van de taak is wie het aangaat.
    insert into public.task_status_log (
      task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
    ) values (
      r.id, 'due_date_herberekend', r.oude, v_raw, r.actor, 'av_opvolging_automatisch',
      'Herrekend volgens 0037: de neerlegging schuift niet mee met een algemene vergadering die te laat gehouden werd.'
    );

    perform set_config('taskflow.pipeline_task_id', '', true);
    v_aantal := v_aantal + 1;
  end loop;

  raise notice '0037: % neerlegging(en) herrekend', v_aantal;
end $herstel$;
