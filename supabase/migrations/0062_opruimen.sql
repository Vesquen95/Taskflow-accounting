-- 0062 — Opruimen na 61 migraties
--
-- Een systematische doorlichting van de databank (02/10/2026): elke functie is
-- nagelopen op wie ze gebruikt — de app, een trigger, een policy, cron of een
-- andere functie. Op één na wordt alles gebruikt. Wat hieronder staat is het
-- weinige dat weg kon, plus twee kleine verbeteringen die de advisors van
-- Supabase aanwezen.
--
-- Wat er BEWUST niet in staat, omdat het verleidelijk is en fout zou zijn:
--
--   * De vijftien "ongebruikte" indexen die de advisor meldt. Die statistiek
--     komt uit een databank die net leeggemaakt is, vijf dossiers telt en
--     twee keer op pauze stond (wat de tellers wist). Op zo'n tabel kiest
--     Postgres altijd een volledige scan, dus elke index lijkt ongebruikt. Bij
--     honderd dossiers zijn ze nodig.
--   * Indexen op de veertien foreign keys zonder index. Het zijn bijna allemaal
--     auditkolommen (`*_door`, `actor_employee_id`) op tabellen van een paar
--     honderd rijen. Ze aanleggen is werk voor als het ergens traag wordt.
--   * De 23 SECURITY DEFINER-functies die `authenticated` mag aanroepen. Dat is
--     geen lek maar de opzet: het zijn de RPC's van de app en de helpers die de
--     RLS-policies nodig hebben. Ze dichtzetten breekt de app. De ene die wél
--     een vraag oproept, mag_klant_zien(), staat al in PLAN §21.
--   * De functies van het weekoverzicht. Niemand roept ze vandaag aan, maar ze
--     horen bij de maandagmail die geparkeerd staat (PLAN §21), niet geschrapt.

-- ------------------------------------------------------------
-- 1. Geen demodata meer bij het inrichten van een kantoor
--
-- create_firm_and_admin() zaaide bij het allereerste aanmelden vier
-- voorbeelddossiers ("[DEMO] Bakkerij Verhaegen BV" en co.). In deze
-- installatie kan dat pad nooit meer lopen: het slot van 0014 weigert zodra
-- er een kantoor bestaat. Het raakt dus alleen een lege databank -- een
-- nieuwe installatie voor een ander kantoor -- en daar is het precies
-- verkeerd: een echt kantoor begint dan met verzonnen klanten in zijn
-- productiedatabank, en het kantoor heeft al eens alle testklanten moeten
-- wissen om met eigen dossiers te kunnen testen.
--
-- De feestdagen blijven wél: zonder die kalender verschuift de motor
-- deadlines alleen op weekends.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text := E'\n  perform public.seed_demo_data_for_firm(v_firm_id, v_employee_id);\n';
begin
  select pg_get_functiondef('public.create_firm_and_admin(text, text)'::regprocedure) into v_def;

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0062: het anker van de demodata past niet exact één keer in create_firm_and_admin().';
  end if;

  execute replace(v_def, v_anker, E'\n');
end $patch$;

drop function public.seed_demo_data_for_firm(uuid, uuid);

-- ------------------------------------------------------------
-- 2. Twee interne helpers uit de publieke API
--
-- Allebei lezen ze alleen een transactie-lokale vlag, en ze worden
-- uitsluitend aangeroepen door SECURITY DEFINER-functies -- die voeren hun
-- aanroepen uit als eigenaar, dus dit dichtzetten breekt niets. Hun broers
-- (taskflow_generating, taskflow_zet_nvt, taskflow_archiveert_klant) stonden
-- al dicht; deze twee waren vergeten, de laatste door mij in 0059.
-- ------------------------------------------------------------
revoke execute on function public.taskflow_pipeline_owns_row(uuid) from public, anon, authenticated;
revoke execute on function public.taskflow_verantwoordelijke_verplaatsing() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. employees_select_own: auth.uid() één keer per query in plaats van per rij
--
-- Supabase' eigen advies (lint 0003). `auth.uid()` rechtstreeks in een policy
-- wordt voor elke rij opnieuw uitgerekend; als scalaire subquery één keer.
-- Dezelfde uitkomst, dus geen gedragswijziging.
--
-- De advisor meldt deze policy ook als "dubbel" naast employees_select. Dat
-- klopt niet: employees_select steunt op current_employee_firm_id(), en die
-- geeft niets terug voor een gedeactiveerde medewerker. Zonder deze tweede
-- policy kan de app niet meer lezen dat iemand gedeactiveerd is, en blijft die
-- hangen op een laadscherm in plaats van het afmeldscherm te zien. Ze blijven
-- dus twee aparte policies, met elk hun reden.
-- ------------------------------------------------------------
alter policy employees_select_own on public.employees
  using (auth_user_id = (select auth.uid()));
