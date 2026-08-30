-- ============================================================
-- 0028 — Fiches 281.20, 281.45 en 281.50, en "Aangifte VenB"
--
-- 1. Drie nieuwe verplichtingstypes voor de fiscale fiches.
-- 2. De aangifte heet voortaan "Aangifte VenB" in plaats van
--    "Aangifte VenB / PB".
-- 3. De generator maakt de fiche-taken aan.
--
-- De termijnen (art. 92 KB/WIB 92, indiening via Belcotax-on-web):
--
--   281.20  bezoldigingen van bedrijfsleiders   eind februari van jaar N+1
--   281.45  auteursrechten                      eind februari van jaar N+1
--   281.50  commissies, makelaarslonen,
--           erelonen                            30 juni van jaar N+1
--
-- "Eind februari" en niet de vaste 28e: in een schrikkeljaar is de uiterste
-- datum de 29e (inkomstenjaar 2023 -> 29 februari 2024). Daarom rekenen we
-- terug vanaf 1 maart, dan klopt het in beide gevallen vanzelf.
--
-- Alle drie lopen op het INKOMSTENJAAR (1 januari - 31 december) en niet op
-- het boekjaar. Een vennootschap met een boekjaar tot 30 juni dient haar
-- fiches nog altijd per kalenderjaar in; dat koppelen aan het boekjaar zou
-- voor elk niet-kalenderdossier een verkeerde deadline opleveren.
--
-- Ze staan niet standaard aangevinkt. Een fiche hangt aan wat een dossier
-- effectief uitbetaalt: niet elke klant heeft bedrijfsleidersbezoldigingen,
-- auteursrechten of erelonen. Het formulier zet nieuwe verplichtingen op
-- "niet gekozen", dus bestaande dossiers veranderen hier niet van.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De verplichtingstypes
-- ------------------------------------------------------------
insert into public.obligation_types
  (code, naam, categorie, deadline_mechanisme, standaard_periodiciteit, werkstroom)
values
  ('fiche_281_20', 'Fiche 281.20 (bedrijfsleiders)', 'wettelijk', 'formule', 'jaarlijks', 'fiches'),
  ('fiche_281_45', 'Fiche 281.45 (auteursrechten)', 'wettelijk', 'formule', 'jaarlijks', 'fiches'),
  ('fiche_281_50', 'Fiche 281.50 (commissies en erelonen)', 'wettelijk', 'formule', 'jaarlijks', 'fiches')
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 2. Aangifte VenB / PB -> Aangifte VenB
--
-- Voorlopig alleen de naam. Het onderscheid tussen vennootschapsbelasting en
-- personenbelasting is een echt onderscheid (andere termijn, ander formulier)
-- en verdient later een eigen type; tot dan is de naam eerlijker zonder "/ PB"
-- dan met. De code blijft aangifte_venb_pb: die zit in bestaande taken en in
-- de generator, en hernoemen zou die stil uit elkaar trekken.
-- ------------------------------------------------------------
update public.obligation_types
set naam = 'Aangifte VenB'
where code = 'aangifte_venb_pb';

-- ------------------------------------------------------------
-- 3. De generator
--
-- generate_task_instances_intern() is ruim 400 regels en werd sinds 0006 al
-- zes keer in haar geheel overgeschreven. Elke keer opnieuw uittypen om er
-- één tak bij te zetten is precies hoe je per ongeluk een eerdere correctie
-- terugdraait. Daarom lezen we de functie zoals ze in de databank staat, en
-- voegen we de nieuwe tak er letterlijk in — met een controle vooraf dat het
-- ankerpunt er inderdaad staat, zodat dit hard faalt in plaats van stil niets
-- te doen.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_nieuw text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if v_def is null then
    raise exception 'generate_task_instances_intern() bestaat niet; 0028 kan niets patchen.';
  end if;

  if position('fiche_281_' in v_def) > 0 then
    raise notice '0028: de fiche-tak staat er al, generator ongewijzigd gelaten.';
    return;
  end if;

  -- Het einde van de laatste tak (btw_klantenlisting) en de afsluiting van de
  -- keten. Hier komt de nieuwe tak vlak voor.
  v_anker :=
    '        end loop;' || E'\n' ||
    '      end if;' || E'\n' ||
    '    end if;' || E'\n' ||
    '  end loop;';

  if position(v_anker in v_def) = 0 then
    raise exception
      '0028: het ankerpunt in generate_task_instances_intern() is niet gevonden; de functie ziet er anders uit dan verwacht.';
  end if;

  v_nieuw :=
    '        end loop;' || E'\n' ||
    '      end if;' || E'\n' ||
    E'\n' ||
    '    elsif r_co.code in (''fiche_281_20'', ''fiche_281_45'', ''fiche_281_50'') then' || E'\n' ||
    '      -- Per inkomstenjaar (kalenderjaar), niet per boekjaar.' || E'\n' ||
    '      for v_year in' || E'\n' ||
    '        extract(year from v_gen_from)::int .. extract(year from v_window_end)::int' || E'\n' ||
    '      loop' || E'\n' ||
    '        if r_co.code = ''fiche_281_50'' then' || E'\n' ||
    '          v_due_raw := make_date(v_year + 1, 6, 30);' || E'\n' ||
    '        else' || E'\n' ||
    '          -- Eind februari: 1 maart min een dag, dus ook juist in een' || E'\n' ||
    '          -- schrikkeljaar.' || E'\n' ||
    '          v_due_raw := make_date(v_year + 1, 3, 1) - 1;' || E'\n' ||
    '        end if;' || E'\n' ||
    '        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '        v_new_id := public.upsert_generated_task(' || E'\n' ||
    '          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '          v_year::text, make_date(v_year, 1, 1), make_date(v_year, 12, 31),' || E'\n' ||
    '          v_due_raw, v_default_employee, r_co.categorie' || E'\n' ||
    '        );' || E'\n' ||
    '      end loop;' || E'\n' ||
    '    end if;' || E'\n' ||
    '  end loop;';

  v_def := replace(v_def, v_anker, v_nieuw);
  execute v_def;

  if position('fiche_281_' in (
    select pg_get_functiondef(oid) from pg_proc where proname = 'generate_task_instances_intern'
  )) = 0 then
    raise exception '0028: de fiche-tak staat na het patchen niet in de functie.';
  end if;
end;
$patch$;

revoke execute on function public.generate_task_instances_intern(uuid, integer, integer, uuid)
  from public, anon, authenticated;
