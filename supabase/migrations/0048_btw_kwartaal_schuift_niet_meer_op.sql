-- ============================================================
-- 0048 — De btw-kwartaaldeadline schuift niet meer op, en dus schuiven wij
--        de andere kant op
--
-- Gevonden bij het nazicht van de fiscale regels op 04/09/2026.
--
-- De datum zelf stond juist: de 25ste van de maand na het kwartaal, sinds de
-- hervorming van de btw-ketting (migratie 0017). Maar er ging daarna nog
-- `next_business_day()` overheen, en die tolerantie is voor kwartaalaangevers
-- afgeschaft. Voor maandaangevers bestaat ze nog wél — dat is geen
-- inconsistentie van ons, dat is hoe de FOD het publiceert.
--
-- De btw-kalender 2026 van de FOD zet het naast elkaar:
--
--   periodieke kwartaalaangiften   Q4-2025  26.01.2026   (nog verschoven)
--                                  Q1-2026  27.04.2026   (laatste uitzondering)
--                                  Q2-2026  25.07.2026   zaterdag, geen uitstel
--                                  Q3-2026  25.10.2026   zondag,   geen uitstel
--   maandelijkse aangiften         mei 2026 22.06.2026   nog steeds verschoven
--                                  aug 2026 21.09.2026   nog steeds verschoven
--   bijzondere aangiften           Q1-2026  25.04.2026   zaterdag, nooit verschoven
--                                  Q3-2026  25.10.2026   zondag,   nooit verschoven
--
-- De bijzondere aangifte schoof zelfs nooit mee, ook niet tijdens de
-- overgang. Die stond dus al die tijd fout.
--
-- ------------------------------------------------------------
-- Vooruit of achteruit: waarom dit een keuze van het kantoor was
--
-- Als een deadline op zondag 25 oktober valt en niet meer opschuift, dan is
-- de wettelijke datum zondag. Maar er wordt hier niemand op zondag verwacht,
-- dus in de praktijk is de deadline vrijdag 23 oktober. Het kantoor heeft
-- gekozen om dat ook zo te plannen.
--
-- Daarom schuift de werkdatum voor deze verplichtingen naar ACHTEREN, naar de
-- laatste werkdag ervoor. `due_date_wettelijk` blijft onaangeroerd de 25ste:
-- het dossier houdt de wet bij, de takenlijst houdt het werk bij. Die twee
-- kolommen bestonden al precies voor dit onderscheid.
--
-- ------------------------------------------------------------
-- Waarom een parameter en niet een kolom op het verplichtingstype
--
-- De regel verschilt BINNEN één verplichtingstype: dezelfde `btw_aangifte`
-- schuift vooruit voor een maandaangever en achteruit voor een
-- kwartaalaangever. Een kolom op `obligation_types` kan dat niet uitdrukken.
-- De motortak weet het wel — die berekent net de maand- of de kwartaalversie
-- — dus zegt de tak het bij het aanmaken.
--
-- De standaardwaarde is 'vooruit'. Elke bestaande aanroep blijft dus doen wat
-- ze deed; alleen de twee takken die het anders moeten doen, zeggen het.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De spiegel van next_business_day()
-- ------------------------------------------------------------
create or replace function public.vorige_werkdag(p_date date)
returns date
language plpgsql
stable security definer set search_path = public
as $$
declare
  v_date date := p_date;
begin
  -- Zelfde vorm als next_business_day(), maar terugtellend: zaterdag, zondag
  -- en een niet-ingetrokken feestdag zijn geen werkdag.
  while extract(isodow from v_date) in (6, 7)
     or exists (
       select 1 from public.public_holidays h
       where h.datum = v_date and not h.ingetrokken
     )
  loop
    v_date := v_date - 1;
  end loop;
  return v_date;
end;
$$;

comment on function public.vorige_werkdag(date) is
  'De laatste werkdag op of voor deze datum. Voor deadlines die NIET meer opschuiven als ze in het weekend vallen (btw-kwartaalaangifte en bijzondere aangifte sinds 2026): de wet zegt zondag, het werk moet vrijdag klaar zijn.';

revoke execute on function public.vorige_werkdag(date) from public, anon;
grant execute on function public.vorige_werkdag(date) to authenticated;

-- ------------------------------------------------------------
-- 2. De richting per taak
--
-- De functie wordt gelezen zoals ze in de databank staat en er wordt letterlijk
-- in gepatcht; overtypen zou een eerdere correctie kunnen terugdraaien. Een
-- parameter toevoegen kan niet met CREATE OR REPLACE -- dat maakt een tweede,
-- dubbelzinnige functie -- dus wordt de oude handtekening erna opgeruimd.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'upsert_generated_task';

  if v_def is null then
    raise exception '0048: upsert_generated_task() bestaat niet.';
  end if;
  if position('p_verschuiving' in v_def) > 0 then
    raise notice '0048: de richtingparameter staat er al.';
    return;
  end if;

  v_anker := 'p_voorloper_taak_id uuid DEFAULT NULL::uuid)';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0048: het anker van de handtekening past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker,
    'p_voorloper_taak_id uuid DEFAULT NULL::uuid, p_verschuiving text DEFAULT ''vooruit'')');

  v_anker := '  v_due date := public.next_business_day(p_due_raw);';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0048: het anker van de verschuiving past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker,
    '  v_due date := case when p_verschuiving = ''terug''' || E'\n' ||
    '                     then public.vorige_werkdag(p_due_raw)' || E'\n' ||
    '                     else public.next_business_day(p_due_raw) end;');

  execute v_def;

  drop function if exists public.upsert_generated_task(
    uuid, uuid, uuid, text, date, date, date, uuid, public.obligation_categorie, boolean, uuid);
end
$patch$;

-- Een nieuwe handtekening erft de standaardrechten van Supabase; de oude had
-- ze afgenomen. Zonder deze regel staat de motorfunctie open via de API --
-- sectie 38.2 van het harnas vangt precies dat, en deed dat hier ook.
revoke execute on function public.upsert_generated_task(
  uuid, uuid, uuid, text, date, date, date, uuid, public.obligation_categorie, boolean, uuid, text)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. De twee takken die achteruit schuiven
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if v_def is null then
    raise exception '0048: generate_task_instances_intern() bestaat niet.';
  end if;
  if position('p_verschuiving =>' in v_def) > 0 then
    raise notice '0048: de motor kent de richting al.';
    return;
  end if;

  -- (a) De btw-KWARTAALaangifte. De maandtak eronder blijft ongemoeid: die
  --     schuift wel degelijk nog vooruit.
  v_anker :=
    '            -- Kwartaalaangifte: de 25ste van de maand na het kwartaal.' || E'\n' ||
    '            v_due_raw := (date_trunc(''month'', v_period_eind) + interval ''1 month'')::date + 24;' || E'\n' ||
    '            continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '            v_label := to_char(v_period_start, ''YYYY'') || ''-Q'' || to_char(v_period_start, ''Q'');' || E'\n' ||
    '            v_new_id := public.upsert_generated_task(' || E'\n' ||
    '              r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '              v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie' || E'\n' ||
    '            );';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0048: het anker van de btw-kwartaaltak past niet exact één keer.';
  end if;
  -- Niet onvoorwaardelijk 'terug': de tolerantie is echt pas weggevallen
  -- tussen Q1-2026 en Q2-2026. De FOD-kalender toont Q1-2026 nog op maandag
  -- 27.04.2026 en Q2-2026 op zaterdag 25.07.2026. Een oudere periode
  -- hergenereren hoort dus nog de oude datum te geven -- anders liegt het
  -- systeem over het verleden.
  v_def := replace(v_def, v_anker, replace(v_anker,
    'v_default_employee, r_co.categorie' || E'\n' || '            );',
    'v_default_employee, r_co.categorie,' || E'\n' ||
    '              p_verschuiving => case when v_due_raw >= date ''2026-05-01''' || E'\n' ||
    '                                     then ''terug'' else ''vooruit'' end' || E'\n' ||
    '            );'));

  -- (b) De bijzondere btw-aangifte, die zelfs nooit meeschoof.
  v_anker :=
    '          v_label := to_char(v_period_start, ''YYYY'') || ''-Q'' || to_char(v_period_start, ''Q'');' || E'\n' ||
    '          v_new_id := public.upsert_generated_task(' || E'\n' ||
    '            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie' || E'\n' ||
    '          );' || E'\n' ||
    '        end loop;' || E'\n' ||
    '      end if;' || E'\n' ||
    '    end if;';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0048: het anker van de bijzondere btw-tak past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker, replace(v_anker,
    'v_default_employee, r_co.categorie' || E'\n' || '          );',
    'v_default_employee, r_co.categorie,' || E'\n' ||
    '            p_verschuiving => ''terug''' || E'\n' ||
    '          );'));

  execute v_def;
end
$patch$;

-- ------------------------------------------------------------
-- 4. De taken die er al staan
--
-- Een formulewijziging repareert niets uit het verleden: upsert_generated_task
-- doet `on conflict do nothing`, en met een horizon van 36 maanden staan de
-- foute rijen er al. Dit blok volgt hetzelfde patroon als 0017 en 0033.
--
-- Alleen wat nog moet gebeuren. Een deadline die al gepasseerd is achteraf
-- verzetten maakt de historiek onwaar -- en de tolerantie bestond toen ook
-- echt nog. Een handmatig afgesproken datum blijft staan en krijgt een
-- reviewmarkering: dat is een afspraak met een mens, geen berekening.
-- ------------------------------------------------------------
do $herstel$
declare
  r record;
  v_nieuw date;
  v_actor uuid;
  v_aantal int := 0;
begin
  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op,
           ti.review_reden, c.firm_id, ot.code
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    join public.obligation_types ot on ot.id = ti.obligation_type_id
    where ti.status not in ('ingediend_afgerond', 'geannuleerd')
      and ti.due_date_wettelijk >= current_date
      and (
        ot.code = 'btw_bijzondere_aangifte'
        -- Alleen de kwartaalaangevers: het periodelabel is hier de enige
        -- eerlijke aanwijzing, want de frequentie kan sinds de generatie
        -- gewijzigd zijn en het label niet.
        or (ot.code = 'btw_aangifte' and ti.periode_label like '%-Q%')
      )
  loop
    v_nieuw := public.vorige_werkdag(r.due_date_wettelijk);
    continue when v_nieuw is not distinct from r.due_date;

    select e.id into v_actor
    from public.employees e
    where e.firm_id = r.firm_id and e.rol = 'kantoorbeheerder' and e.actief
    order by e.created_at asc
    limit 1;
    continue when v_actor is null;

    perform set_config('taskflow.pipeline_task_id', r.id::text, true);
    if r.due_date_handmatig_op is not null then
      update public.task_instances
      set review_vereist = true,
          review_reden = coalesce(r.review_reden || ' — ', '') ||
            'De btw-deadline schuift niet meer op naar de eerstvolgende werkdag; ' ||
            'de wettelijke datum is ' || to_char(r.due_date_wettelijk, 'DD/MM/YYYY') ||
            ' en de laatste werkdag ervoor is ' || to_char(v_nieuw, 'DD/MM/YYYY') ||
            '. Deze taak heeft een handmatig afgesproken deadline; controleer of die nog haalbaar is.'
      where id = r.id;
    else
      update public.task_instances set due_date = v_nieuw where id = r.id;
    end if;
    perform set_config('taskflow.pipeline_task_id', '', true);

    insert into public.task_status_log (
      task_instance_id, event_type, oude_due_date, nieuwe_due_date,
      actor_employee_id, trigger_bron, notitie
    ) values (
      r.id, 'due_date_herberekend', r.due_date, v_nieuw, v_actor, 'kalender_herberekening',
      'De verlenging naar de eerstvolgende werkdag geldt niet meer voor deze aangifte. ' ||
      'De wettelijke datum blijft ' || to_char(r.due_date_wettelijk, 'DD/MM/YYYY') ||
      '; de taak staat nu op de laatste werkdag ervoor.'
    );
    v_aantal := v_aantal + 1;
  end loop;

  raise notice '0048: % btw-taken herberekend.', v_aantal;
end
$herstel$;
