-- ============================================================
-- 0036 — Patrimoniumtaks en de bijzondere btw-aangifte
--
-- Twee verplichtingen die het kantoor als CONTROLE voert, niet als zekere
-- indiening. Dat verschil staat in de naam, en dat is geen woordenspel:
--
--   * De patrimoniumtaks is pas verschuldigd boven 50.000 euro vermogen, en
--     die drempel toets je elk jaar opnieuw. Een taak die "aangifte indienen"
--     heet en die je in de helft van de jaren afvinkt zonder iets in te
--     dienen, maakt het afvinken zelf betekenisloos.
--   * De bijzondere btw-aangifte is enkel verschuldigd in een kwartaal waarin
--     er echt een intracommunautaire verwerving of een ontvangen dienst was.
--     Het kantoor wil ze toch elk kwartaal zien staan -- juist om te kunnen
--     nakijken of er iets was.
--
-- De termijnen:
--
--   patrimoniumtaks            31 maart van hetzelfde jaar. De taks wordt
--                              geheven op het vermogen op 1 januari, dus de
--                              deadline valt binnen de periode zelf.
--   bijzondere btw-aangifte    de 25ste van de maand na het kwartaal. Dat was
--                              de 20ste; sinds 1 januari 2025 is het de 25ste,
--                              samen met de gewone kwartaalaangifte.
--
-- De bijzondere aangifte bestaat juist voor wie GEEN periodieke aangifte
-- indient. Bij een periodieke aangever is ze dus niet aan de orde, en dat
-- staat hieronder op twee plaatsen: de motor maakt er geen taken voor aan, en
-- de controle op botsende verplichtingen weigert de combinatie meteen.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De verplichtingstypes
-- ------------------------------------------------------------
insert into public.obligation_types
  (code, naam, categorie, deadline_mechanisme, standaard_periodiciteit, werkstroom)
values
  ('patrimoniumtaks', 'Patrimoniumtaks (toetsen)', 'wettelijk', 'formule', 'jaarlijks', 'vennootschapsbelasting'),
  ('btw_bijzondere_aangifte', 'Bijzondere btw-aangifte (toetsen)', 'wettelijk', 'formule', 'kwartaal', 'btw')
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 2. De motor
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_aantal int;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if v_def is null then
    raise exception '0036: generate_task_instances_intern() bestaat niet.';
  end if;

  if position('patrimoniumtaks' in v_def) > 0 then
    raise notice '0036: de takken staan er al.';
    return;
  end if;

  -- Vlak voor het einde van de keten, na de fiche-tak.
  v_anker :=
    '      end loop;' || E'\n' ||
    '    end if;' || E'\n' ||
    '  end loop;' || E'\n';
  v_aantal := (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker);
  if v_aantal <> 1 then
    raise exception '0036: anker % keer gevonden, verwacht 1.', v_aantal;
  end if;

  v_def := replace(
    v_def,
    v_anker,
    '      end loop;' || E'\n' ||
    E'\n' ||
    '    elsif r_co.code = ''patrimoniumtaks'' then' || E'\n' ||
    '      -- Geheven op het vermogen op 1 januari, in te dienen tegen 31 maart' || E'\n' ||
    '      -- van datzelfde jaar. De deadline valt dus binnen de periode.' || E'\n' ||
    '      for v_year in' || E'\n' ||
    '        extract(year from v_gen_from)::int .. extract(year from v_window_end)::int' || E'\n' ||
    '      loop' || E'\n' ||
    '        v_due_raw := make_date(v_year, 3, 31);' || E'\n' ||
    '        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '        v_new_id := public.upsert_generated_task(' || E'\n' ||
    '          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '          v_year::text, make_date(v_year, 1, 1), make_date(v_year, 12, 31),' || E'\n' ||
    '          v_due_raw, v_default_employee, r_co.categorie' || E'\n' ||
    '        );' || E'\n' ||
    '      end loop;' || E'\n' ||
    E'\n' ||
    '    elsif r_co.code = ''btw_bijzondere_aangifte'' then' || E'\n' ||
    '      -- Bestaat voor wie geen periodieke aangifte indient. Bij een' || E'\n' ||
    '      -- periodieke aangever hoort ze er niet, en dan maken we ze ook niet:' || E'\n' ||
    '      -- zo verdwijnen de taken vanzelf zodra het regime verandert.' || E'\n' ||
    '      if r_co.btw_regime <> ''periodieke_aangever'' then' || E'\n' ||
    '        for v_period_start in' || E'\n' ||
    '          select generate_series(date_trunc(''quarter'', v_gen_from), date_trunc(''quarter'', v_window_end), interval ''3 months'')::date' || E'\n' ||
    '        loop' || E'\n' ||
    '          v_period_eind := (v_period_start + interval ''3 months'' - interval ''1 day'')::date;' || E'\n' ||
    '          -- De 25ste van de maand na het kwartaal (sinds 1 januari 2025).' || E'\n' ||
    '          v_due_raw := (date_trunc(''month'', v_period_eind) + interval ''1 month'')::date + 24;' || E'\n' ||
    '          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '          v_label := to_char(v_period_start, ''YYYY'') || ''-Q'' || to_char(v_period_start, ''Q'');' || E'\n' ||
    '          v_new_id := public.upsert_generated_task(' || E'\n' ||
    '            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie' || E'\n' ||
    '          );' || E'\n' ||
    '        end loop;' || E'\n' ||
    '      end if;' || E'\n' ||
    '    end if;' || E'\n' ||
    '  end loop;' || E'\n'
  );
  execute v_def;

  if position('btw_bijzondere_aangifte' in (
    select pg_get_functiondef(oid) from pg_proc where proname = 'generate_task_instances_intern'
  )) = 0 then
    raise exception '0036: de takken staan na het patchen niet in de motor.';
  end if;
end;
$patch$;

revoke execute on function public.generate_task_instances_intern(uuid, integer, integer, uuid)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. De bijzondere aangifte hoort niet bij een periodieke aangever
--
-- Hier botst een verplichting niet met een andere verplichting maar met het
-- btw-regime van de klant. Dezelfde functie, want het is voor de gebruiker
-- dezelfde soort fout: iets aanvinken dat niet van toepassing is.
-- ------------------------------------------------------------
create or replace function public.enforce_botsende_verplichtingen()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_code text;
  v_botst text[];
  v_andere_code text;
  v_andere_naam text;
  v_deze_naam text;
  v_reden text;
  v_regime public.btw_regime;
begin
  select code, naam into v_code, v_deze_naam
  from public.obligation_types where id = new.obligation_type_id;
  if v_code is null then
    return new;
  end if;

  -- Een verplichting die stopgezet wordt of nog niet loopt, botst met niets.
  if not new.actief
     or new.geldig_vanaf > current_date
     or (new.geldig_tot is not null and new.geldig_tot < current_date) then
    return new;
  end if;

  -- Botsing met het btw-regime van de klant.
  if v_code = 'btw_bijzondere_aangifte' then
    select btw_regime into v_regime from public.clients where id = new.client_id;
    if v_regime = 'periodieke_aangever' then
      raise exception
        'De bijzondere btw-aangifte bestaat voor wie géén periodieke btw-aangifte indient. Deze klant is periodieke aangever, dus ze is hier niet van toepassing.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Botsing met een andere verplichting.
  v_botst := case v_code
    when 'aangifte_venb_pb' then array['aangifte_rpb']
    when 'aangifte_rpb'     then array['aangifte_venb_pb', 'va_venb']
    when 'va_venb'          then array['aangifte_rpb']
    else null
  end;
  if v_botst is null then
    return new;
  end if;

  select ot.code, ot.naam into v_andere_code, v_andere_naam
  from public.client_obligations co
  join public.obligation_types ot on ot.id = co.obligation_type_id
  where co.client_id = new.client_id
    and ot.code = any(v_botst)
    and co.actief
    and co.geldig_vanaf <= current_date
    and (co.geldig_tot is null or co.geldig_tot >= current_date)
    and co.id is distinct from new.id
  limit 1;

  if v_andere_naam is null then
    return new;
  end if;

  v_reden := case
    when 'va_venb' in (v_code, v_andere_code)
      then 'Voorafbetalingen horen bij de vennootschapsbelasting; in de rechtspersonenbelasting bestaan ze niet.'
    else 'Een dossier valt onder de vennootschapsbelasting óf onder de rechtspersonenbelasting, niet onder allebei.'
  end;

  raise exception '"%" gaat niet samen met "%", en die loopt al voor deze klant. % Vink de andere eerst af.',
    v_deze_naam, v_andere_naam, v_reden
    using errcode = 'check_violation';
end;
$$;

revoke execute on function public.enforce_botsende_verplichtingen()
  from public, anon, authenticated;
