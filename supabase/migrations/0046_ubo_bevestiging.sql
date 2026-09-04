-- ============================================================
-- 0046 — UBO-register: de jaarlijkse bevestiging
--
-- Het UBO-register houdt bij wie er werkelijk achter een entiteit zit. Wie
-- informatieplichtig is, moet twee dingen doen: elke wijziging binnen de
-- maand doorgeven, en de gegevens ELK JAAR bevestigen, ook wanneer er niets
-- veranderd is. Die tweede is de stille: er gebeurt niets, dus niemand denkt
-- eraan, en de sanctie loopt op tot 50.000 euro en uiteindelijk een
-- schrapping uit de KBO -- waarna banken de relatie kunnen stilleggen.
--
-- Precies daarom hoort ze in een deadlinesysteem: het is de verplichting
-- waar je zonder herinnering niet aan denkt.
--
-- ------------------------------------------------------------
-- Voor wie
--
-- De wet noemt de informatieplichtigen: vennootschappen, (i)vzw's en
-- stichtingen, trusts en fiducieën. Een eenmanszaak staat er niet bij -- daar
-- is geen entiteit om achter te kijken, de ondernemer ís de natuurlijke
-- persoon. Deze migratie zet het type klaar; het scherm beslist wie het
-- aangeboden krijgt (rechtspersonen, met de eenmanszaak er expliciet uit).
--
-- ------------------------------------------------------------
-- Wanneer: het jaar na de vorige keer, niet een datum uit de wet
--
-- Hier zit de eigenaardigheid. De wet geeft GEEN kalenderdatum. Ze zegt: de
-- gegevens moeten jaarlijks bevestigd worden, en een wijziging binnen de
-- maand. De uiterste datum van jouw bevestiging hangt dus af van wanneer je
-- ze vorig jaar deed -- een bewegend anker dat een generator niet kan volgen.
--
-- De keuze hier: boekjaareinde + 6 maanden. Drie redenen.
--
--   * Het is dezelfde grens als de algemene vergadering, en dat is precies
--     het moment waarop de aandeelhoudersstructuur toch al nagekeken wordt.
--     De bevestiging valt zo in hetzelfde werkblok als de afsluiting.
--   * Het spreidt zich vanzelf over het jaar mee met de boekjaren. Eén vaste
--     datum voor alle dossiers zou honderd bevestigingen op één dag zetten.
--   * Elk jaar hetzelfde anker betekent precies twaalf maanden tussen twee
--     bevestigingen, en dus altijd binnen de termijn. Wie een jaar te laat
--     is, staat het jaar erop gewoon weer op het anker -- korter dan een
--     jaar, dus nog altijd in orde.
--
-- Wat dit NIET doet: de wijziging binnen de maand. Die heeft geen ritme --
-- ze hangt aan een gebeurtenis die het kantoor pas kent wanneer de klant
-- belt. Dat is werk voor een ad-hoc taak, en die bestaat al.
-- ============================================================

-- Kort gehouden: deze naam staat in de kolom "Verplichting" naast negentig
-- andere regels. "UBO-register (jaarlijkse bevestiging)" kapte daar af tot
-- "UBO-register (jaarlijkse be...", en dan draagt de helft van de naam niets.
insert into public.obligation_types
  (code, naam, categorie, deadline_mechanisme, standaard_periodiciteit, werkstroom)
values
  ('ubo_bevestiging', 'UBO-bevestiging', 'wettelijk',
   'boekjaar_relatief', 'jaarlijks', 'afsluiting')
on conflict (code) do update set naam = excluded.naam;

-- ------------------------------------------------------------
-- De motor
--
-- Zelfde aanpak als 0028/0029/0036/0041: de functie lezen zoals ze in de
-- databank staat en er letterlijk in patchen. Ze overtypen zou een eerdere
-- correctie kunnen terugdraaien.
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
    raise exception '0046: generate_task_instances_intern() bestaat niet.';
  end if;

  if position('ubo_bevestiging' in v_def) > 0 then
    raise notice '0046: de UBO-tak staat er al, generator ongewijzigd gelaten.';
    return;
  end if;

  v_anker := '    elsif r_co.code = ''patrimoniumtaks'' then';

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0046: het anker van de patrimoniumtaks-tak past niet exact één keer.';
  end if;

  v_nieuw :=
    '    elsif r_co.code = ''ubo_bevestiging'' then' || E'\n' ||
    '      -- De wet geeft geen kalenderdatum: bevestigen moet jaarlijks, en' || E'\n' ||
    '      -- een wijziging binnen de maand. Het anker is hier het boekjaar,' || E'\n' ||
    '      -- op dezelfde grens als de algemene vergadering -- daar wordt de' || E'\n' ||
    '      -- aandeelhoudersstructuur toch al nagekeken. Zie de kop van 0046.' || E'\n' ||
    '      for v_year in' || E'\n' ||
    '        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1' || E'\n' ||
    '      loop' || E'\n' ||
    '        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);' || E'\n' ||
    '        v_due_raw := (v_be + interval ''6 months'')::date;' || E'\n' ||
    '        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '        v_bstart := (v_be - interval ''1 year'' + interval ''1 day'')::date;' || E'\n' ||
    '        v_label := to_char(v_be, ''YYYY'');' || E'\n' ||
    '        v_new_id := public.upsert_generated_task(' || E'\n' ||
    '          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '          v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie' || E'\n' ||
    '        );' || E'\n' ||
    '      end loop;' || E'\n' ||
    '' || E'\n' ||
    v_anker;

  v_def := replace(v_def, v_anker, v_nieuw);
  execute v_def;
end $patch$;
