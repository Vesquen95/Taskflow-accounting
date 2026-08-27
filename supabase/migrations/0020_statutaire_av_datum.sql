-- Taskflow v1 -- de algemene vergadering krijgt haar statutaire datum.
--
-- Aanleiding: het kantoor. De motor rekende de AV op boekjaareinde + 6 maanden,
-- de WETTELIJKE UITERSTE datum, niet de datum die in de statuten staat:
--
--   Sluit 30/06  ->  AV op 30/12
--   Sluit 31/12  ->  AV op 30/06
--
-- Een klant waarvan de statuten "de eerste maandag van april" zeggen, stond dus
-- op 30 juni: twee maanden naast de werkelijkheid in de planning. En omdat de
-- neerlegging als AV + 30 dagen berekend wordt, schoof die fout door naar de
-- neerleggingsdatum.
--
-- De AV-datum staat in de statuten en wordt per klant ingevuld. Twee vormen,
-- beide komen voor in de dossiers van het kantoor:
--
--   {"av_vorm": "vaste_datum",  "av_maand": 4, "av_dag": 1}
--   {"av_vorm": "nde_weekdag",  "av_maand": 4, "av_rang": "eerste", "av_weekdag": "maandag"}
--
-- De datum wordt gelezen als de eerstvolgende gelegenheid NA het boekjaareinde.
-- Ze moet binnen zes maanden daarna vallen; een combinatie die daarbuiten valt
-- wordt geweigerd bij het invullen, niet stilzwijgend tot een onwettige datum
-- verwerkt. Zet je bij een 30/06-klant "1 april", dan valt de eerstvolgende
-- 1 april op 1 april van het jaar erop -- te laat. Dat hoor je op het moment
-- dat je het typt.
--
-- Staan er geen statuten ingevuld, dan blijft de motor terugvallen op de
-- wettelijke uiterste datum. Dat is juridisch veilig en verandert niets aan
-- bestaande dossiers; het lege veld in het klantdossier is het signaal.
--
-- Additief: 0003-0019 zijn al toegepast en worden NIET gewijzigd.

-- ============================================================
-- 1. De berekening
-- ============================================================
create or replace function public.av_weekdag_nummer(p_naam text)
returns int
language sql immutable
as $$
  select case lower(trim(p_naam))
    when 'maandag'  then 1
    when 'dinsdag'  then 2
    when 'woensdag' then 3
    when 'donderdag' then 4
    when 'vrijdag'  then 5
    when 'zaterdag' then 6
    when 'zondag'   then 7
    else null
  end;
$$;

comment on function public.av_weekdag_nummer(text) is
  'Weekdagnaam -> ISO-nummer (maandag = 1). Null bij een onbekende naam, zodat av_datum() dat als "niet ingevuld" behandelt in plaats van een verkeerde dag te kiezen.';

create or replace function public.av_datum(p_boekjaar_einde date, p_parameters jsonb)
returns date
language plpgsql immutable
as $$
declare
  v_vorm text;
  v_maand int;
  v_dag int;
  v_rang text;
  v_weekdag int;
  v_jaar int;
  v_kandidaat date;
  v_poging int;
begin
  if p_boekjaar_einde is null or p_parameters is null then
    return null;
  end if;

  v_vorm := p_parameters->>'av_vorm';
  v_maand := nullif(p_parameters->>'av_maand', '')::int;
  if v_vorm is null or v_maand is null or v_maand < 1 or v_maand > 12 then
    return null;
  end if;

  -- Twee pogingen: de maand in het jaar van het boekjaareinde, en zo nodig
  -- dezelfde maand een jaar later. De AV valt per definitie NA het
  -- boekjaareinde, dus een datum die er nog voor ligt schuift een jaar op.
  v_jaar := extract(year from p_boekjaar_einde)::int;

  for v_poging in 0..1 loop
    if v_vorm = 'vaste_datum' then
      v_dag := nullif(p_parameters->>'av_dag', '')::int;
      if v_dag is null or v_dag < 1 or v_dag > 31 then
        return null;
      end if;
      -- Een dag die niet bestaat in die maand (31 april) is geen geldige
      -- statutaire datum; make_date zou hier een fout gooien.
      if v_dag > extract(day from (date_trunc('month', make_date(v_jaar + v_poging, v_maand, 1))
                                   + interval '1 month' - interval '1 day'))::int then
        return null;
      end if;
      v_kandidaat := make_date(v_jaar + v_poging, v_maand, v_dag);

    elsif v_vorm = 'nde_weekdag' then
      v_rang := lower(trim(coalesce(p_parameters->>'av_rang', '')));
      v_weekdag := public.av_weekdag_nummer(p_parameters->>'av_weekdag');
      if v_weekdag is null then
        return null;
      end if;

      if v_rang = 'laatste' then
        -- Vanaf de laatste dag van de maand terugstappen naar die weekdag.
        v_kandidaat := (date_trunc('month', make_date(v_jaar + v_poging, v_maand, 1))
                        + interval '1 month' - interval '1 day')::date;
        v_kandidaat := v_kandidaat
          - ((extract(isodow from v_kandidaat)::int - v_weekdag + 7) % 7);
      else
        -- Vanaf de eerste dag vooruit naar het eerste voorkomen, dan hele
        -- weken bij. De vierde bestaat altijd: elke maand telt minstens 28
        -- dagen, dus vier keer elke weekdag.
        v_kandidaat := make_date(v_jaar + v_poging, v_maand, 1);
        v_kandidaat := v_kandidaat
          + ((v_weekdag - extract(isodow from v_kandidaat)::int + 7) % 7);
        v_kandidaat := v_kandidaat + (case v_rang
          when 'eerste' then 0
          when 'tweede' then 7
          when 'derde'  then 14
          when 'vierde' then 21
          else null
        end);
        if v_kandidaat is null then
          return null;
        end if;
      end if;

    else
      return null;
    end if;

    if v_kandidaat > p_boekjaar_einde then
      return v_kandidaat;
    end if;
  end loop;

  return null;
end;
$$;

comment on function public.av_datum(date, jsonb) is
  'De statutaire AV-datum: de eerstvolgende gelegenheid na het boekjaareinde, uit de parameters van de AV-verplichting. Null wanneer de statuten niet (geldig) ingevuld zijn -- de motor valt dan terug op de wettelijke uiterste datum.';

revoke execute on function public.av_datum(date, jsonb) from public, anon;
revoke execute on function public.av_weekdag_nummer(text) from public, anon;

-- ============================================================
-- 2. De controle bij het invullen
--
-- De AV moet binnen zes maanden na het boekjaareinde gehouden worden. Een
-- statutaire datum die daarbuiten valt is geen planningsfout maar een
-- onwettige datum, en die hoort geweigerd te worden op het moment dat iemand
-- ze intypt -- niet in december zichtbaar te worden.
-- ============================================================
create or replace function public.enforce_av_parameters()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  v_be_maand int;
  v_be_dag int;
  v_be date;
  v_av date;
  v_uiterste date;
begin
  select code into v_code from public.obligation_types where id = new.obligation_type_id;
  if v_code is distinct from 'algemene_vergadering' then
    return new;
  end if;

  -- Geen statuten ingevuld: toegestaan, de motor valt terug op de wettelijke
  -- uiterste datum.
  if new.parameters is null or (new.parameters->>'av_vorm') is null then
    return new;
  end if;

  select boekjaar_einde_maand, boekjaar_einde_dag
    into v_be_maand, v_be_dag
  from public.clients where id = new.client_id;

  v_be := public.fiscal_year_end(v_be_maand, v_be_dag, extract(year from current_date)::int);
  v_av := public.av_datum(v_be, new.parameters);

  if v_av is null then
    raise exception
      'De statutaire AV-datum is onvolledig of ongeldig. Kies een vaste datum (maand + dag) of een n-de weekdag (maand + rang + weekdag).'
      using errcode = 'check_violation';
  end if;

  v_uiterste := (v_be + interval '6 months')::date;
  if v_av > v_uiterste then
    raise exception
      'Deze AV-datum (%) valt buiten de wettelijke termijn: de algemene vergadering moet binnen zes maanden na het boekjaareinde (%) gehouden worden, dus uiterlijk %.',
      to_char(v_av, 'DD/MM/YYYY'), to_char(v_be, 'DD/MM/YYYY'), to_char(v_uiterste, 'DD/MM/YYYY')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_av_parameters() from public, anon, authenticated;

drop trigger if exists trg_client_obligations_av_parameters on public.client_obligations;
create trigger trg_client_obligations_av_parameters
  before insert or update of parameters, client_id, obligation_type_id
  on public.client_obligations
  for each row
  execute function public.enforce_av_parameters();

-- ============================================================
-- 3. Bij een statutenwijziging schuift alles mee
--
-- Het kantoor: "bij een nieuwe AV moet alles mee verschuiven, dit is een
-- eenmalige interactie." Een statutenwijziging is zeldzaam en mag dus zwaar
-- zijn. Alleen OPEN, TOEKOMSTIGE, gegenereerde AV-taken schuiven; wat in
-- uitvoering of ingediend is blijft staan, dat is werk dat gebeurd is.
--
-- De neerlegging hangt met voorloper_taak_id aan de AV en is AV + 30 dagen,
-- dus die volgt mee. Een handmatig afgesproken deadline wordt niet
-- overschreven: daar verschuift enkel het wettelijke ijkpunt en gaat de taak
-- naar review (dezelfde M-1-regel als in 0013/0014).
-- ============================================================
create or replace function public.herbereken_av_taken()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  v_actor uuid := public.current_employee_id();
  r record;
  n record;
  v_nieuw date;
  v_neer date;
  v_aantal int := 0;
begin
  select code into v_code from public.obligation_types where id = new.obligation_type_id;
  if v_code is distinct from 'algemene_vergadering' then
    return new;
  end if;
  if new.parameters is not distinct from old.parameters then
    return new;
  end if;

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.periode_eind,
           ti.due_date_handmatig_op, ti.review_vereist, ti.review_reden
    from public.task_instances ti
    where ti.client_id = new.client_id
      and ti.obligation_type_id = new.obligation_type_id
      and ti.bron_type = 'automatisch_gegenereerd'
      and ti.status = 'open'
      and ti.due_date >= current_date
  loop
    v_nieuw := coalesce(public.av_datum(r.periode_eind, new.parameters),
                        (r.periode_eind + interval '6 months')::date);
    continue when v_nieuw is not distinct from r.due_date_wettelijk;

    perform set_config('taskflow.pipeline_task_id', r.id::text, true);
    if r.due_date_handmatig_op is not null then
      update public.task_instances
      set due_date_wettelijk = v_nieuw,
          review_vereist = true,
          review_reden = coalesce(r.review_reden || ' — ', '') ||
            'De statutaire AV-datum is gewijzigd naar ' || to_char(v_nieuw, 'DD/MM/YYYY') ||
            '; deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
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
      'De statutaire AV-datum is gewijzigd; de vergadering staat nu op ' ||
      to_char(v_nieuw, 'DD/MM/YYYY') || '.'
    );
    v_aantal := v_aantal + 1;

    -- De neerlegging jaarrekening volgt de AV (+ 30 dagen).
    v_neer := (v_nieuw + 30)::date;
    for n in
      select ti.id, ti.due_date, ti.due_date_handmatig_op, ti.review_vereist, ti.review_reden
      from public.task_instances ti
      where ti.voorloper_taak_id = r.id
        and ti.status = 'open'
        and ti.bron_type = 'automatisch_gegenereerd'
    loop
      perform set_config('taskflow.pipeline_task_id', n.id::text, true);
      if n.due_date_handmatig_op is not null then
        update public.task_instances
        set due_date_wettelijk = v_neer,
            review_vereist = true,
            review_reden = coalesce(n.review_reden || ' — ', '') ||
              'De algemene vergadering is verplaatst, dus de neerleggingstermijn verschuift naar ' ||
              to_char(v_neer, 'DD/MM/YYYY') || '; deze taak heeft een handmatig afgesproken deadline.'
        where id = n.id;
      else
        update public.task_instances
        set due_date_wettelijk = v_neer,
            due_date = public.next_business_day(v_neer)
        where id = n.id;
      end if;
      perform set_config('taskflow.pipeline_task_id', '', true);

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date,
        actor_employee_id, trigger_bron, notitie
      ) values (
        n.id, 'due_date_herberekend', n.due_date, public.next_business_day(v_neer),
        v_actor, 'av_opvolging_automatisch',
        'De algemene vergadering is verplaatst; de neerlegging volgt op ' ||
        to_char(v_neer, 'DD/MM/YYYY') || '.'
      );
    end loop;
  end loop;

  if v_aantal > 0 then
    insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
    values (new.client_id, 'av_statutaire_datum',
            old.parameters::text, new.parameters::text, v_actor);
  end if;

  return new;
end;
$$;

revoke execute on function public.herbereken_av_taken() from public, anon, authenticated;

drop trigger if exists trg_client_obligations_av_herbereken on public.client_obligations;
create trigger trg_client_obligations_av_herbereken
  after update of parameters on public.client_obligations
  for each row
  execute function public.herbereken_av_taken();


-- ============================================================
-- 4. De motor gebruikt de statutaire datum
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_task_instances(p_horizon_months integer DEFAULT 3, p_backfill_months integer DEFAULT 6)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := public.current_employee_id();
  v_firm_id uuid := public.current_employee_firm_id();
  v_window_start date := current_date - (p_backfill_months || ' months')::interval;
  v_window_end date := current_date + (p_horizon_months || ' months')::interval;
  v_gen_from date := v_window_start - interval '6 months';
  v_before_count bigint;
  v_after_count bigint;

  r_co record;
  v_default_employee uuid;
  v_ondergrens date;

  v_ot_neerlegging uuid;

  v_period_start date;
  v_period_eind date;
  v_due_raw date;
  v_label text;
  v_year int;
  v_be date;
  v_bstart date;
  v_i int;
  v_month_offset int;
  v_day int;
  v_sla_maanden int;
  v_av_id uuid;
  v_scope text;
  v_lc_date date;
  v_frequentie text;
  v_termijn_dagen int;
  v_new_id uuid;
begin
  if v_actor is null or v_firm_id is null or not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder kan taakgeneratie starten';
  end if;

  -- Weigeren i.p.v. stil afkappen: wie 120 typt waar 12 bedoeld was, hoort
  -- dat te weten. Negatieve waarden leverden voorheen stil nul taken op.
  if p_horizon_months is null or p_horizon_months < 0 or p_horizon_months > 36 then
    raise exception
      'De generatiehorizon moet tussen 0 en 36 maanden vooruit liggen (gevraagd: %).',
      coalesce(p_horizon_months::text, 'niets')
      using errcode = 'check_violation';
  end if;
  if p_backfill_months is null or p_backfill_months < 0 or p_backfill_months > 24 then
    raise exception
      'Het inhaalvenster moet tussen 0 en 24 maanden terug liggen (gevraagd: %).',
      coalesce(p_backfill_months::text, 'niets')
      using errcode = 'check_violation';
  end if;

  select id into v_ot_neerlegging from public.obligation_types where code = 'neerlegging_jaarrekening';
  select count(*) into v_before_count from public.task_instances where bron_type = 'automatisch_gegenereerd';

  for r_co in
    select
      co.id as client_obligation_id, co.client_id, co.parameters,
      co.standaard_toegewezen_medewerker_id, co.geldig_vanaf,
      c.firm_id, c.actief as client_actief,
      c.btw_regime, c.btw_aangifte_frequentie,
      c.boekjaar_einde_maand, c.boekjaar_einde_dag,
      c.standaard_verantwoordelijke_id,
      ot.id as obligation_type_id, ot.code, ot.categorie
    from public.client_obligations co
    join public.clients c on c.id = co.client_id
    join public.obligation_types ot on ot.id = co.obligation_type_id
    where co.actief
      and c.actief
      and c.firm_id = v_firm_id
      and co.geldig_vanaf <= current_date
      and (co.geldig_tot is null or co.geldig_tot >= current_date)
  loop
    -- De ondergrens is de datum waarop deze verplichting begon te lopen, niet
    -- het globale terugkijkvenster.
    v_ondergrens := greatest(v_window_start, r_co.geldig_vanaf);

    select coalesce(
      r_co.standaard_toegewezen_medewerker_id,
      r_co.standaard_verantwoordelijke_id,
      (
        select e.id from public.employees e
        where e.firm_id = r_co.firm_id and e.rol = 'kantoorbeheerder' and e.actief
        order by e.created_at asc limit 1
      )
    ) into v_default_employee;

    -- toegewezen_medewerker_id is NOT NULL; if a firm somehow has no
    -- active kantoorbeheerder and no default responsible configured at
    -- all, we cannot safely invent an assignee — skip rather than fail
    -- the whole run for every other client.
    if v_default_employee is null then
      continue;
    end if;

    if r_co.code = 'btw_aangifte' then
      if r_co.btw_regime = 'periodieke_aangever' and r_co.btw_aangifte_frequentie is not null then
        if r_co.btw_aangifte_frequentie = 'maand' then
          for v_period_start in
            select generate_series(date_trunc('month', v_gen_from), date_trunc('month', v_window_end), interval '1 month')::date
          loop
            v_period_eind := (v_period_start + interval '1 month' - interval '1 day')::date;
            v_due_raw := (date_trunc('month', v_period_eind) + interval '1 month')::date + 19;
            continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
            v_label := to_char(v_period_start, 'YYYY-MM');
            v_new_id := public.upsert_generated_task(
              r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
              v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
            );
          end loop;
        else
          for v_period_start in
            select generate_series(date_trunc('quarter', v_gen_from), date_trunc('quarter', v_window_end), interval '3 months')::date
          loop
            v_period_eind := (v_period_start + interval '3 months' - interval '1 day')::date;
            -- Kwartaalaangifte: de 25ste van de maand na het kwartaal.
            v_due_raw := (date_trunc('month', v_period_eind) + interval '1 month')::date + 24;
            continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
            v_label := to_char(v_period_start, 'YYYY') || '-Q' || to_char(v_period_start, 'Q');
            v_new_id := public.upsert_generated_task(
              r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
              v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
            );
          end loop;
        end if;
      end if;

    elsif r_co.code = 'va_venb' then
      for v_year in
        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1
      loop
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);
        v_bstart := (v_be - interval '1 year' + interval '1 day')::date;
        for v_i in 1..4 loop
          -- Terugrekenen vanaf de maand van het boekjaareinde.
          v_month_offset := case v_i when 1 then -8 when 2 then -5 when 3 then -2 else 0 end;
          v_day := case v_i when 4 then 20 else 10 end;
          v_due_raw := (date_trunc('month', v_be) + (v_month_offset || ' months')::interval)::date + (v_day - 1);
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
          v_label := 'VA' || v_i || '-' || to_char(v_be, 'YYYY');
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      end loop;

    elsif r_co.code = 'jaarafsluiting' then
      v_sla_maanden := coalesce((r_co.parameters->>'sla_maanden')::int, 3);
      for v_year in
        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1
      loop
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);
        v_bstart := (v_be - interval '1 year' + interval '1 day')::date;
        v_due_raw := (v_be + (v_sla_maanden || ' months')::interval)::date;
        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
        v_label := to_char(v_be, 'YYYY');
        v_new_id := public.upsert_generated_task(
          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
          v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie
        );
      end loop;

    elsif r_co.code = 'algemene_vergadering' then
      for v_year in
        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1
      loop
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);
        v_bstart := (v_be - interval '1 year' + interval '1 day')::date;
        -- De statutaire AV-datum uit de parameters van deze verplichting.
        -- Zonder ingevulde statuten valt de motor terug op de wettelijke
        -- uiterste datum (boekjaareinde + 6 maanden): juridisch veilig, maar
        -- zelden de datum waarop de vergadering werkelijk plaatsvindt.
        v_due_raw := coalesce(public.av_datum(v_be, r_co.parameters),
                              (v_be + interval '6 months')::date);
        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
        v_label := to_char(v_be, 'YYYY');

        v_av_id := public.upsert_generated_task(
          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
          v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie
        );
        if v_av_id is null then
          select id into v_av_id from public.task_instances
          where client_id = r_co.client_id and obligation_type_id = r_co.obligation_type_id
            and periode_label = v_label and bron_type = 'automatisch_gegenereerd';
        end if;

        -- Companion neerlegging_jaarrekening instance (§2.5/§3.5):
        -- provisional due date now (AV due + 30d), recalculated for real
        -- once the AV task is actually completed (see 0004 trigger).
        if v_av_id is not null and v_ot_neerlegging is not null then
          perform public.upsert_generated_task(
            r_co.client_id, v_ot_neerlegging, null,
            v_label, v_be, v_be, (v_due_raw + 30), v_default_employee, 'wettelijk',
            true, v_av_id
          );
        end if;
      end loop;

    elsif r_co.code = 'aangifte_venb_pb' then
      v_scope := 'boekjaar_' || r_co.boekjaar_einde_maand;
      for v_year in
        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1
      loop
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);

        -- Standaard: de laatste dag van de zevende maand na het boekjaareinde.
        -- 31/12 -> 31/07, 30/06 -> 31/01, 30/09 -> 30/04, 31/03 -> 31/10.
        v_due_raw := (date_trunc('month', v_be) + interval '8 months' - interval '1 day')::date;

        -- De wettelijke kalender is hier een OVERRIDE, geen voorwaarde. Vroeger
        -- werd de datum uitsluitend daar opgezocht en werd de periode
        -- overgeslagen als er geen rij stond: geen taak, geen melding, een
        -- deadline die nergens bestond. Nu rekent de motor zelf en wint een
        -- ingevulde campagnedatum.
        select deadline_datum into v_lc_date
        from public.legal_calendar
        where obligation_type_id = r_co.obligation_type_id
          and jaar = v_year
          and (scope = v_scope or scope is null)
        order by is_override desc, updated_at desc
        limit 1;
        if v_lc_date is not null then
          v_due_raw := v_lc_date;
        end if;

        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
        v_bstart := (v_be - interval '1 year' + interval '1 day')::date;
        v_label := to_char(v_be, 'YYYY');
        v_new_id := public.upsert_generated_task(
          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
          v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie
        );
      end loop;

    elsif r_co.code = 'rapportering' then
      v_frequentie := coalesce(r_co.parameters->>'frequentie', 'kwartaal');
      v_termijn_dagen := coalesce((r_co.parameters->>'termijn_dagen')::int, 10);
      if v_frequentie = 'maand' then
        for v_period_start in
          select generate_series(date_trunc('month', v_gen_from), date_trunc('month', v_window_end), interval '1 month')::date
        loop
          v_period_eind := (v_period_start + interval '1 month' - interval '1 day')::date;
          v_due_raw := v_period_eind + v_termijn_dagen;
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
          v_label := to_char(v_period_start, 'YYYY-MM');
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      elsif v_frequentie = 'jaar' then
        for v_year in
          extract(year from v_gen_from)::int .. extract(year from v_window_end)::int
        loop
          v_period_start := make_date(v_year, 1, 1);
          v_period_eind := make_date(v_year, 12, 31);
          v_due_raw := v_period_eind + v_termijn_dagen;
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
          v_label := v_year::text;
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      else
        for v_period_start in
          select generate_series(date_trunc('quarter', v_gen_from), date_trunc('quarter', v_window_end), interval '3 months')::date
        loop
          v_period_eind := (v_period_start + interval '3 months' - interval '1 day')::date;
          v_due_raw := v_period_eind + v_termijn_dagen;
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
          v_label := to_char(v_period_start, 'YYYY') || '-Q' || to_char(v_period_start, 'Q');
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      end if;

    elsif r_co.code = 'btw_klantenlisting' then
      if r_co.btw_regime <> 'geen' then
        for v_year in
          extract(year from v_gen_from)::int .. extract(year from v_window_end)::int
        loop
          v_due_raw := make_date(v_year + 1, 3, 31);
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_year::text, make_date(v_year, 1, 1), make_date(v_year, 12, 31),
            v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      end if;
    end if;
  end loop;

  select count(*) into v_after_count from public.task_instances where bron_type = 'automatisch_gegenereerd';
  return (v_after_count - v_before_count);
end;
$function$;

revoke execute on function public.generate_task_instances(int, int) from public, anon;
