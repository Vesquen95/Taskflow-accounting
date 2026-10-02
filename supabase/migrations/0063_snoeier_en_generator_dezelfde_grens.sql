-- 0063 — De snoeier en de generator gebruiken dezelfde grens
--
-- Gevonden op 02/10/2026 door de testharnas met een verschoven klok te
-- draaien: op sommige dagen leverde een tweede onderhoudsronde opnieuw taken
-- op (test 33.3), op 31/12/2027 zelfs zeventien.
--
-- De oorzaak: twee functies, twee grenzen.
--
--   generate_task_instances_intern()  maakt een taak aan als haar WETTELIJKE
--                                     datum binnen de horizon valt;
--   snoei_taken_buiten_horizon()      annuleerde een taak als haar VERSCHOVEN
--                                     datum (na weekend of feestdag) erbuiten
--                                     valt.
--
-- Valt een wettelijke deadline vlak voor de grens op een zaterdag, dan maakt
-- de generator ze aan en annuleert de snoeier ze in dezelfde ronde. De
-- geannuleerde rij geeft haar periodeslot vrij, dus de volgende ronde maakt
-- ze opnieuw aan, en annuleert ze weer. Elke maand een geannuleerde dubbel
-- erbij en een logregel "buiten de horizon gevallen", tot de grens voorbij is.
--
-- Dat is geen theoretisch randgeval. De cron loopt op de 1e van de maand. Op
-- 1 juli 2027 ligt de grens op 1 oktober 2028, en 30 september 2028 -- de
-- deadline van de aangifte VenB voor elke klant met een boekjaar per 31/12 --
-- is een zaterdag. Dan worden al die aangiften aangemaakt en in dezelfde ronde
-- weer geannuleerd.
--
-- De oplossing: de snoeier kijkt naar wat de generator ook bekijkt, de
-- wettelijke datum. Dan zijn ze het per definitie eens.
--
-- En een tweede regel die hier hoort: een taak waarvan iemand de deadline met
-- de hand verzette, wordt niet gesnoeid. Dat is een afspraak met de klant
-- (0013, M-1), en die wissen we niet omdat een kalenderberekening dat zegt.
-- Met de verschoven datum als grens werd zo'n taak gesnoeid als iemand haar
-- verder dan de horizon had gelegd; met de wettelijke datum zou het omgekeerde
-- gebeuren als iemand een verre taak naar voren haalde. Ze overslaan is in
-- beide richtingen juist.

create or replace function public.snoei_taken_buiten_horizon()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r_firm record;
  r record;
  v_grens date := (current_date + (public.horizon_maanden() || ' months')::interval)::date;
  v_auth uuid;
  v_actor uuid;
  v_aantal int := 0;
begin
  for r_firm in select id from public.firms loop
    select e.id, e.auth_user_id into v_actor, v_auth
    from public.employees e
    where e.firm_id = r_firm.id and e.rol = 'kantoorbeheerder' and e.actief
      and e.auth_user_id is not null
    order by e.created_at asc
    limit 1;
    continue when v_actor is null;

    perform set_config('taskflow.test_uid', v_auth::text, true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);

    for r in
      select ti.id
      from public.task_instances ti
      join public.clients c on c.id = ti.client_id
      where c.firm_id = r_firm.id
        and ti.bron_type = 'automatisch_gegenereerd'
        and ti.status = 'open'
        -- 0063: dezelfde datum als de generator, niet de verschoven.
        and ti.due_date_wettelijk > v_grens
        and ti.voorloper_taak_id is null
        -- 0063: een met de hand afgesproken deadline blijft staan.
        and ti.due_date_handmatig_op is null
    loop
      update public.task_instances set status = 'geannuleerd' where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'taak_inhoud_gewijzigd', v_actor, 'kalender_herberekening',
        'Buiten de generatiehorizon van ' || public.horizon_maanden() ||
        ' maanden gevallen. De taakgeneratie maakt deze periode opnieuw aan zodra de horizon opschuift.'
      );
      v_aantal := v_aantal + 1;
    end loop;
  end loop;

  perform set_config('taskflow.test_uid', '', true);
  perform set_config('request.jwt.claims', '', true);
  return v_aantal;
end;
$$;

revoke execute on function public.snoei_taken_buiten_horizon() from public, anon, authenticated;
