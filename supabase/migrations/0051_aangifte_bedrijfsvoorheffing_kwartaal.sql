-- ============================================================
-- 0051 — De aangifte bedrijfsvoorheffing, per kwartaal
--
-- Tweede leemte uit het fiscale nazicht van 04/09/2026. Wie personeel of
-- bedrijfsleiders uitbetaalt, houdt bedrijfsvoorheffing in en geeft die aan
-- via Finprof. Onder het grensbedrag van artikel 412, derde lid WIB 92 mag
-- dat per kwartaal (51.480 euro voor 2026); daarboven moet het maandelijks.
--
-- ------------------------------------------------------------
-- De data
--
-- De kwartaalkalender van de FOD is over jaren heen volkomen regelmatig: de
-- 15de van de maand na het kwartaal, zonder uitzondering.
--
--   Q4-2025  15.01.2026     Q1-2026  15.04.2026
--   Q2-2026  15.07.2026     Q3-2026  15.10.2026
--   Q4-2026  15.01.2027
--
-- Dat is een formule, en dus hoort ze hier.
--
-- ------------------------------------------------------------
-- Waarom de MAANDaangifte hier bewust NIET in zit
--
-- Die is géén formule, en dat is precies waarom ze gevaarlijk zou zijn om te
-- gokken. Uit dezelfde FOD-kalender, 2026:
--
--   januari   13.02.2026    (15 februari is een zondag)
--   februari  13.03.2026    (15 maart is een zondag)
--   maart     15.04.2026
--   april     13.05.2026    (15 mei is een VRIJDAG, en toch de 13de)
--   mei       15.06.2026
--   augustus  14.08.2026    (15 augustus: zaterdag én O.L.V. Hemelvaart)
--   oktober   13.11.2026    (15 november is een zondag)
--
-- April breekt elke regel die je zou kunnen bedenken: de 15de is een gewone
-- werkdag en de FOD zet er toch de 13de. Vermoedelijk om Hemelvaart (14 mei
-- 2026) en de brugdag erna, maar dat is een gok — en een gok in een
-- deadlinesysteem is een gemiste aangifte. De maandaangifte is een
-- AANGEKONDIGDE kalender en hoort dus in `legal_calendar`, niet in de motor.
--
-- ------------------------------------------------------------
-- Verschuiving: achteruit
--
-- De kwartaaldata vallen in 2026 en 2027 toevallig alle vijf op een werkdag,
-- dus die tabel zegt niets over wat er gebeurt als de 15de in het weekend
-- valt. Binnen de generatiehorizon gebeurt dat wél: 15.01.2028, 15.04.2028 en
-- 15.07.2028 zijn alle drie een zaterdag.
--
-- De maandkalender hierboven toont welke kant de FOD dan op gaat: naar de
-- werkdag ERVOOR (13.02, 13.03, 14.08, 13.11 — telkens vervroegd, nooit
-- verlaat). Dat is ook de kant die het kantoor voor de btw gekozen heeft.
-- Beide wijzen dezelfde richting uit, dus: `terug`.
--
-- ------------------------------------------------------------
-- Wat hier niet in zit
--
-- Erkende sociale secretariaten storten tegen de VOORLAATSTE WERKDAG van de
-- maand na het kwartaal — een heel andere termijn. Loopt de loonverwerking
-- van een dossier via een sociaal secretariaat, dan klopt deze taak niet voor
-- dat dossier. Dat is een vraag voor het kantoor, geen aanname die hier
-- ingebakken hoort.
-- ============================================================

insert into public.obligation_types
  (code, naam, categorie, deadline_mechanisme, standaard_periodiciteit, werkstroom)
values
  ('bedrijfsvoorheffing', 'Aangifte bedrijfsvoorheffing', 'wettelijk', 'formule', 'kwartaal', 'fiches')
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
    raise exception '0051: generate_task_instances_intern() bestaat niet.';
  end if;
  if position('bedrijfsvoorheffing' in v_def) > 0 then
    raise notice '0051: de BV-tak staat er al, generator ongewijzigd gelaten.';
    return;
  end if;

  v_anker := '    elsif r_co.code = ''ic_opgave'' then';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0051: het anker van de IC-tak past niet exact één keer.';
  end if;

  v_nieuw :=
    '    elsif r_co.code = ''bedrijfsvoorheffing'' then' || E'\n' ||
    '      for v_period_start in' || E'\n' ||
    '        select generate_series(date_trunc(''quarter'', v_gen_from), date_trunc(''quarter'', v_window_end), interval ''3 months'')::date' || E'\n' ||
    '      loop' || E'\n' ||
    '        v_period_eind := (v_period_start + interval ''3 months'' - interval ''1 day'')::date;' || E'\n' ||
    '        -- De 15de van de maand na het kwartaal. De kwartaalkalender van' || E'\n' ||
    '        -- de FOD is hierin volkomen regelmatig; de MAANDkalender is dat' || E'\n' ||
    '        -- niet, en die is daarom bewust niet gemodelleerd (zie 0051).' || E'\n' ||
    '        v_due_raw := (date_trunc(''month'', v_period_eind) + interval ''1 month'')::date + 14;' || E'\n' ||
    '        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '        v_label := to_char(v_period_start, ''YYYY'') || ''-Q'' || to_char(v_period_start, ''Q'');' || E'\n' ||
    '        v_new_id := public.upsert_generated_task(' || E'\n' ||
    '          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '          v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie,' || E'\n' ||
    '          p_verschuiving => ''terug''' || E'\n' ||
    '        );' || E'\n' ||
    '      end loop;' || E'\n' ||
    '' || E'\n' ||
    v_anker;

  v_def := replace(v_def, v_anker, v_nieuw);
  execute v_def;
end
$patch$;
