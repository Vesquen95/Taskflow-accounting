-- Taskflow v1 -- taken bij- en afmaken bij het opslaan van een klant.
--
-- Aanleiding: het kantoor. "Taken kunnen bijkomen, zoals een rapportering, of
-- kunnen wegvallen, zoals de btw-aangiftes. Die moeten dan ook gemaakt of
-- verwijderd worden bij het opslaan. Niet door een afzonderlijke triggerknop."
--
-- De generatie zat tot nu toe in één functie die over het HELE kantoor liep en
-- alleen door een kantoorbeheerder gestart kon worden. Dat is de juiste vorm
-- voor het opschuiven van de horizon (er komt een nieuw kwartaal bij), maar de
-- verkeerde voor het opslaan van één klant: dat is dagelijks werk van wie het
-- dossier beheert.
--
-- Deze migratie splitst die twee:
--
--   generate_task_instances_intern(...)  de eigenlijke lus, zonder rolcontrole,
--                                        te beperken tot één klant
--   generate_task_instances(horizon, backfill)
--                                        de batch: heel het kantoor, alleen
--                                        voor een kantoorbeheerder, horizon
--                                        opschuiven
--   sync_client_tasks(client_id)         één klant, voor wie het dossier mag
--                                        beheren: maakt de taken van nieuwe
--                                        verplichtingen aan en annuleert de
--                                        open toekomstige taken van
--                                        verplichtingen die zijn afgesloten
--
-- "Verwijderen" bestaat niet en komt er niet: annuleren haalt de taak uit alle
-- lijsten en houdt hem in de geschiedenis van het dossier. Wat in uitvoering of
-- ingediend is blijft staan -- dat is werk dat gebeurd is.
--
-- En passant gaat bevinding I uit de zesde security-verificatie mee: de
-- tellingen liepen instance-breed in plaats van per kantoor, waardoor het
-- getal dat de kantoorbeheerder te zien kreeg door activiteit van een ander
-- kantoor vervuild kon raken -- en die activiteit ook verried.
--
-- Additief: 0003-0020 zijn al toegepast en worden NIET gewijzigd.

-- ============================================================
-- 1. De eigenlijke lus, zonder rolcontrole en te beperken tot één klant
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_task_instances_intern(p_firm_id uuid, p_horizon_months integer, p_backfill_months integer, p_client_id uuid DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_firm_id uuid := p_firm_id;
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
  -- Tellen binnen het eigen kantoor (en de eigen klant wanneer die gegeven is).
  select count(*) into v_before_count
  from public.task_instances ti join public.clients c on c.id = ti.client_id
  where ti.bron_type = 'automatisch_gegenereerd'
    and c.firm_id = v_firm_id
    and (p_client_id is null or ti.client_id = p_client_id);

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
      and (p_client_id is null or co.client_id = p_client_id)
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

  select count(*) into v_after_count
  from public.task_instances ti join public.clients c on c.id = ti.client_id
  where ti.bron_type = 'automatisch_gegenereerd'
    and c.firm_id = v_firm_id
    and (p_client_id is null or ti.client_id = p_client_id);
  return (v_after_count - v_before_count);
end;
$function$;
revoke execute on function public.generate_task_instances_intern(uuid, integer, integer, uuid)
  from public, anon, authenticated;

-- ============================================================
-- 2. De batch: heel het kantoor, alleen voor een kantoorbeheerder
--
-- Blijft bestaan voor het opschuiven van de horizon. Dat heeft niets met een
-- klantwijziging te maken en hoort dus niet bij het opslaan van een klant.
-- ============================================================
create or replace function public.generate_task_instances(
  p_horizon_months int default 3,
  p_backfill_months int default 6
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_firm_id uuid := public.current_employee_firm_id();
begin
  if v_actor is null or v_firm_id is null or not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder kan taakgeneratie starten';
  end if;

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

  return public.generate_task_instances_intern(v_firm_id, p_horizon_months, p_backfill_months, null);
end;
$$;

revoke execute on function public.generate_task_instances(int, int) from public, anon;

-- ============================================================
-- 3. Eén klant, bij het opslaan
--
-- Geen rolbeperking tot kantoorbeheerder: wie het dossier mag beheren, mag het
-- opslaan. can_access_client() is de poort, dezelfde die de RLS gebruikt --
-- inclusief de vertrouwelijkheidsregel.
--
-- Het venster is ruimer dan de batch (36 vooruit) zodat een nieuwe klant
-- meteen zijn volledige toekomst klaar heeft staan, en 0 terug zodat er niets
-- uit het verleden bijkomt. De ondergrens per verplichting (0018) doet de rest.
-- ============================================================
create or replace function public.sync_client_tasks(p_client_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_firm_id uuid;
  v_nieuw int;
  r record;
begin
  if v_actor is null then
    raise exception 'Deze actie vereist een ingelogde, gekoppelde medewerker';
  end if;
  if not public.can_access_client(p_client_id) then
    raise exception 'Je hebt geen toegang tot dit klantdossier'
      using errcode = 'insufficient_privilege';
  end if;

  select firm_id into v_firm_id from public.clients where id = p_client_id;
  if v_firm_id is null then
    raise exception 'Klant niet gevonden';
  end if;

  -- Eerst opruimen: open, toekomstige taken van verplichtingen die niet langer
  -- lopen. Annuleren, niet verwijderen -- de geschiedenis van het dossier
  -- blijft zo kloppen.
  for r in
    select ti.id
    from public.task_instances ti
    where ti.client_id = p_client_id
      and ti.bron_type = 'automatisch_gegenereerd'
      and ti.status = 'open'
      and ti.due_date >= current_date
      and ti.obligation_type_id is not null
      and not exists (
        select 1 from public.client_obligations co
        where co.client_id = ti.client_id
          and co.obligation_type_id = ti.obligation_type_id
          and co.actief
          and co.geldig_vanaf <= current_date
          and (co.geldig_tot is null or co.geldig_tot >= current_date)
      )
  loop
    update public.task_instances
    set status = 'geannuleerd'
    where id = r.id;
  end loop;

  -- Dan aanvullen wat er bij is gekomen.
  v_nieuw := public.generate_task_instances_intern(v_firm_id, 36, 0, p_client_id);
  return v_nieuw;
end;
$$;

comment on function public.sync_client_tasks(uuid) is
  'Brengt de taken van één klant in lijn met zijn verplichtingen: nieuwe verplichtingen krijgen hun toekomstige taken, afgesloten verplichtingen zien hun open toekomstige taken geannuleerd. Bedoeld om aangeroepen te worden bij het opslaan van een klant, niet als aparte knop.';

revoke execute on function public.sync_client_tasks(uuid) from public, anon;
grant execute on function public.sync_client_tasks(uuid) to authenticated;
