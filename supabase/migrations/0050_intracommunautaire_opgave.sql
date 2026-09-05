-- ============================================================
-- 0050 — De intracommunautaire opgave
--
-- Derde vondst van het fiscale nazicht van 04/09/2026, en de enige die geen
-- correctie is maar een gat: Taskflow kende deze verplichting helemaal niet.
--
-- Wie vrijgestelde intracommunautaire leveringen doet, aan driehoeksverkeer
-- deelneemt of B2B-diensten in een andere lidstaat verricht, moet een
-- intracommunautaire opgave indienen (art. 53sexies W.BTW). Ze staat in
-- dezelfde btw-kalender van de FOD als de gewone aangifte, met eigen data.
--
-- ------------------------------------------------------------
-- De data, en waarom de kwartaalopgave achteruit schuift
--
--   maandopgave      de 20ste van de maand erna, mét verschuiving naar de
--                    eerstvolgende werkdag (mei 2026 -> 22.06.2026)
--   kwartaalopgave   de 25ste van de maand na het kwartaal, ZONDER
--                    verschuiving (Q1-2026 -> 25.04.2026, een zaterdag)
--
-- Precies hetzelfde patroon als bij de gewone aangifte (migratie 0048), en om
-- dezelfde reden: de tolerantie is voor de kwartaalindieners weggevallen. De
-- kwartaalopgave is zelfs nooit meeverschoven -- de FOD zette Q1-2026 op
-- zaterdag 25 april terwijl de periodieke kwartaalaangifte 27 april kreeg.
--
-- Voor de werkdatum geldt dus dezelfde keuze van het kantoor: de laatste
-- werkdag vóór de wettelijke datum.
--
-- ------------------------------------------------------------
-- De frequentie hangt niet aan het btw-regime maar aan een drempel
--
-- Dit is het eigenaardige aan deze verplichting. Een kwartaalaangever die in
-- één kwartaal boven 50.000 euro aan vrijgestelde IC-leveringen uitkomt, moet
-- vanaf de maand daarna MAANDELIJKSE opgaven indienen -- en verliest daardoor
-- ook zijn recht op kwartaalaangiften voor de btw zelf.
--
-- In de praktijk lopen die twee dus samen: wie maandelijks aangifte doet, doet
-- maandelijks opgave. Daarom volgt de standaard het btw-ritme van de klant, en
-- kan het kantoor er per dossier van afwijken via de parameter `frequentie`.
-- Dat is eerlijker dan een vaste standaard: het klopt in het gewone geval, en
-- het uitzonderingsgeval is één keuzelijst ver.
--
-- Taskflow weet NIET wie EU-handel doet. Deze verplichting wordt daarom niet
-- automatisch aan bestaande dossiers gehangen -- anders dan de
-- UBO-bevestiging, die voor elke rechtspersoon geldt. Het kantoor vinkt ze
-- aan waar ze van toepassing is.
--
-- ------------------------------------------------------------
-- Wat hier niet in zit
--
-- De JAARLIJKSE intracommunautaire opgave (vóór 31 maart) bestaat alleen voor
-- de bijzondere landbouwregeling. Geen enkel dossier van dit kantoor valt
-- daaronder; ze wordt bewust niet gemodelleerd.
-- ============================================================

insert into public.obligation_types
  (code, naam, categorie, deadline_mechanisme, standaard_periodiciteit, werkstroom)
values
  ('ic_opgave', 'Intracommunautaire opgave', 'wettelijk', 'formule', 'maand_of_kwartaal', 'btw')
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- De motor
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
    raise exception '0050: generate_task_instances_intern() bestaat niet.';
  end if;
  if position('ic_opgave' in v_def) > 0 then
    raise notice '0050: de IC-tak staat er al, generator ongewijzigd gelaten.';
    return;
  end if;

  v_anker := '    elsif r_co.code = ''btw_klantenlisting'' then';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0050: het anker van de klantenlisting past niet exact één keer.';
  end if;

  v_nieuw :=
    '    elsif r_co.code = ''ic_opgave'' then' || E'\n' ||
    '      -- De frequentie volgt standaard het btw-ritme van de klant: wie' || E'\n' ||
    '      -- maandelijks aangifte doet, doet maandelijks opgave. Het kantoor kan' || E'\n' ||
    '      -- er per dossier van afwijken -- de echte regel is een drempel van' || E'\n' ||
    '      -- 50.000 euro per kwartaal, en die kent Taskflow niet.' || E'\n' ||
    '      v_frequentie := coalesce(' || E'\n' ||
    '        r_co.parameters->>''frequentie'',' || E'\n' ||
    '        r_co.btw_aangifte_frequentie::text,' || E'\n' ||
    '        ''kwartaal'');' || E'\n' ||
    '      if v_frequentie = ''maand'' then' || E'\n' ||
    '        for v_period_start in' || E'\n' ||
    '          select generate_series(date_trunc(''month'', v_gen_from), date_trunc(''month'', v_window_end), interval ''1 month'')::date' || E'\n' ||
    '        loop' || E'\n' ||
    '          v_period_eind := (v_period_start + interval ''1 month'' - interval ''1 day'')::date;' || E'\n' ||
    '          -- De 20ste, mét verschuiving: zo publiceert de FOD de' || E'\n' ||
    '          -- maandopgave (mei 2026 -> 22.06.2026).' || E'\n' ||
    '          v_due_raw := (date_trunc(''month'', v_period_eind) + interval ''1 month'')::date + 19;' || E'\n' ||
    '          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '          v_label := to_char(v_period_start, ''YYYY-MM'');' || E'\n' ||
    '          v_new_id := public.upsert_generated_task(' || E'\n' ||
    '            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie' || E'\n' ||
    '          );' || E'\n' ||
    '        end loop;' || E'\n' ||
    '      else' || E'\n' ||
    '        for v_period_start in' || E'\n' ||
    '          select generate_series(date_trunc(''quarter'', v_gen_from), date_trunc(''quarter'', v_window_end), interval ''3 months'')::date' || E'\n' ||
    '        loop' || E'\n' ||
    '          v_period_eind := (v_period_start + interval ''3 months'' - interval ''1 day'')::date;' || E'\n' ||
    '          -- De 25ste, ZONDER verschuiving: de kwartaalopgave is nooit' || E'\n' ||
    '          -- meeverschoven (Q1-2026 -> zaterdag 25.04.2026).' || E'\n' ||
    '          v_due_raw := (date_trunc(''month'', v_period_eind) + interval ''1 month'')::date + 24;' || E'\n' ||
    '          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '          v_label := to_char(v_period_start, ''YYYY'') || ''-Q'' || to_char(v_period_start, ''Q'');' || E'\n' ||
    '          v_new_id := public.upsert_generated_task(' || E'\n' ||
    '            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie,' || E'\n' ||
    '            p_verschuiving => ''terug''' || E'\n' ||
    '          );' || E'\n' ||
    '        end loop;' || E'\n' ||
    '      end if;' || E'\n' ||
    '' || E'\n' ||
    v_anker;

  v_def := replace(v_def, v_anker, v_nieuw);
  execute v_def;
end
$patch$;
