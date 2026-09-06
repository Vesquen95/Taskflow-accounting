-- 0059 — De standaardverantwoordelijke doorzetten naar bestaande taken
--
-- Het probleem, gemeld door het kantoor: wie de standaardverantwoordelijke van
-- een dossier of van één verplichting aanpast, verandert alleen wat de
-- taakgeneratie hierNA aanmaakt. Alles wat er al stond blijft op naam van de
-- vorige collega. Bij een dossier dat overgaat naar iemand anders is dat geen
-- detail: de nieuwe verantwoordelijke ziet het werk niet in zijn lijst staan,
-- en de vorige blijft taken zien van een klant die niet meer van hem is.
--
-- Wat er nu gebeurt: de openstaande taken volgen mee. Met drie grenzen, want
-- blind alles verzetten maakt het erger dan het was.
--
--   1. Alleen taken die nog op de VORIGE standaardverantwoordelijke staan.
--      Heeft iemand een taak bewust aan een derde gegeven, dan is dat een
--      menselijke beslissing en die overschrijven we niet. Staat de taak in de
--      bak van het team (geen naam, 0040) en komt er een verantwoordelijke
--      bij, dan krijgt ze wél die naam -- dat is dezelfde regel, gespiegeld.
--
--   2. Alleen 'open', 'in_uitvoering' en 'wacht_op_klant'. Wat al afgerond of
--      geannuleerd is, is geschiedenis. En 'wacht_op_goedkeuring' blijft
--      staan waar het staat: dat werk is gedáán, alleen nog niet nagekeken,
--      en het op naam van een opvolger zetten maakt hem auteur van werk dat
--      hij niet deed.
--
--   3. Alleen met een ingelogde medewerker. Zonder actor weigert
--      enforce_task_instance_transition() een herverdeling sowieso; dan doet
--      deze trigger niets in plaats van de hele update te laten stranden.
--
-- De herverdeling loopt gewoon door de bestaande UPDATE-trigger op
-- task_instances. Die controleert de kantoorgrens, weigert een collega zonder
-- toegang tot een vertrouwelijk dossier, en schrijft per taak een
-- 'toewijzing_gewijzigd' in het log. Deze migratie voegt daar niets aan toe;
-- ze zorgt er alleen voor dat de update gebeurt.
--
-- Wat er BEWUST niet in zit: het team van de klant. Een dossier dat naar een
-- ander team verhuist, verhuist niet automatisch mee met de namen erop -- daar
-- gaat 0040 over, en de bak van het team vangt dat op.

-- ------------------------------------------------------------
-- 1. De verplaatsing zelf
-- ------------------------------------------------------------
-- Transactie-lokale vlag: staat aan terwijl 0059 taken verplaatst. Waarvoor
-- ze dient, staat bij punt 4 hieronder.
create or replace function public.taskflow_verantwoordelijke_verplaatsing()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('taskflow.verantwoordelijke_verplaatsing', true), '') = 'on';
$$;

create or replace function public.taken_volgen_verantwoordelijke(
  p_client_obligation_id uuid,
  p_oud uuid,
  p_nieuw uuid
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_aantal integer;
begin
  if p_oud is not distinct from p_nieuw then
    return 0;
  end if;

  perform set_config('taskflow.verantwoordelijke_verplaatsing', 'on', true);

  update public.task_instances t
  set toegewezen_medewerker_id = p_nieuw
  where t.client_obligation_id = p_client_obligation_id
    and t.status in ('open', 'in_uitvoering', 'wacht_op_klant')
    and t.toegewezen_medewerker_id is not distinct from p_oud;

  get diagnostics v_aantal = row_count;

  perform set_config('taskflow.verantwoordelijke_verplaatsing', 'off', true);
  return v_aantal;
end;
$$;

-- SECURITY DEFINER, dus buiten de triggers om onbereikbaar houden: deze
-- functie gaat langs RLS heen en zou anders taken van een ander kantoor
-- kunnen verzetten. De autorisatie zelf zit in de UPDATE-trigger op
-- task_instances, die hierna gewoon afgaat.
revoke execute on function public.taken_volgen_verantwoordelijke(uuid, uuid, uuid)
  from public, anon, authenticated;

comment on function public.taken_volgen_verantwoordelijke(uuid, uuid, uuid) is
  'Zet de openstaande taken van één verplichting over van de vorige naar de nieuwe standaardverantwoordelijke. Alleen aan te roepen vanuit de triggers van 0059.';

-- ------------------------------------------------------------
-- 2. De verantwoordelijke van één verplichting
-- ------------------------------------------------------------
create or replace function public.co_verantwoordelijke_naar_taken()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_dossier uuid;
  v_oud uuid;
  v_nieuw uuid;
  v_aantal integer;
begin
  if public.current_employee_id() is null then
    return null;
  end if;

  -- De verplichting valt terug op de verantwoordelijke van het dossier zodra
  -- ze zelf geen naam draagt (zie generate_task_instances_intern). Wie het
  -- veld leegmaakt verandert dus niet noodzakelijk iets.
  select standaard_verantwoordelijke_id into v_dossier
  from public.clients where id = new.client_id;

  v_oud := coalesce(old.standaard_toegewezen_medewerker_id, v_dossier);
  v_nieuw := coalesce(new.standaard_toegewezen_medewerker_id, v_dossier);

  v_aantal := public.taken_volgen_verantwoordelijke(new.id, v_oud, v_nieuw);

  if v_aantal > 0 then
    insert into public.client_change_log (
      client_id, client_obligation_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id
    ) values (
      new.client_id, new.id, 'taken_volgen_verantwoordelijke',
      format('%s openstaande taken stonden op %s', v_aantal, coalesce(v_oud::text, 'de bak van het team')),
      coalesce(v_nieuw::text, 'de bak van het team'),
      public.current_employee_id()
    );
  end if;

  return null;
end;
$$;

-- Triggerfuncties horen niet los oproepbaar te zijn via de API (zie 38.1).
revoke execute on function public.co_verantwoordelijke_naar_taken() from public, anon, authenticated;

drop trigger if exists trg_client_obligations_verantwoordelijke on public.client_obligations;
create trigger trg_client_obligations_verantwoordelijke
after update of standaard_toegewezen_medewerker_id on public.client_obligations
for each row
when (new.standaard_toegewezen_medewerker_id is distinct from old.standaard_toegewezen_medewerker_id)
execute function public.co_verantwoordelijke_naar_taken();

-- ------------------------------------------------------------
-- 3. De verantwoordelijke van het dossier
-- ------------------------------------------------------------
create or replace function public.klant_verantwoordelijke_naar_taken()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  r record;
  v_aantal integer := 0;
begin
  if public.current_employee_id() is null then
    return null;
  end if;

  -- Alleen de verplichtingen die op het dossier terugvallen. Draagt een
  -- verplichting een eigen naam, dan gaat die voor en verandert er niets.
  for r in
    select id from public.client_obligations
    where client_id = new.id and standaard_toegewezen_medewerker_id is null
  loop
    v_aantal := v_aantal + public.taken_volgen_verantwoordelijke(
      r.id, old.standaard_verantwoordelijke_id, new.standaard_verantwoordelijke_id
    );
  end loop;

  if v_aantal > 0 then
    insert into public.client_change_log (
      client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id
    ) values (
      new.id, 'taken_volgen_verantwoordelijke',
      format('%s openstaande taken stonden op %s', v_aantal,
             coalesce(old.standaard_verantwoordelijke_id::text, 'de bak van het team')),
      coalesce(new.standaard_verantwoordelijke_id::text, 'de bak van het team'),
      public.current_employee_id()
    );
  end if;

  return null;
end;
$$;

revoke execute on function public.klant_verantwoordelijke_naar_taken() from public, anon, authenticated;

drop trigger if exists trg_clients_verantwoordelijke on public.clients;
create trigger trg_clients_verantwoordelijke
after update of standaard_verantwoordelijke_id on public.clients
for each row
when (new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id)
execute function public.klant_verantwoordelijke_naar_taken();

-- ------------------------------------------------------------
-- 4. Eén beslissing, één regel in de historiek van het dossier
--
-- Op een vertrouwelijke klant is een toewijzing ook een toegangsbeslissing:
-- 0014 schrijft daarom bij elke herverdeling naar iemand zonder toegang een
-- 'toegang_vertrouwelijk_verleend' in het dossierlog, en 0015 doet hetzelfde
-- voor de verantwoordelijke van een verplichting.
--
-- Zonder deze patch levert het aanduiden van één nieuwe verantwoordelijke
-- straks veertig van die regels op: één van 0015, plus één per taak die
-- meeverhuist. Terwijl er maar één beslissing genomen is, op precies de plek
-- waar 0015 haar al vastlegt. De historiek van het dossier is dan onleesbaar
-- geworden door iets wat als opruimen bedoeld was.
--
-- Alleen die dubbele regel valt weg. Wat blijft: de kantoorgrens, de eis dat
-- enkel een kantoorbeheerder iemand toegang geeft tot een vertrouwelijk
-- dossier, en de 'toewijzing_gewijzigd' per taak. Er verdwijnt dus geen
-- controle en geen spoor -- alleen een echo.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_nieuw text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'enforce_task_instance_transition';

  if v_def is null then
    raise exception '0059: enforce_task_instance_transition() bestaat niet.';
  end if;

  v_anker :=
    '      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)' || E'\n' ||
    '        values (' || E'\n' ||
    '          new.client_id, ''toegang_vertrouwelijk_verleend'',' || E'\n' ||
    '          old.toegewezen_medewerker_id::text, new.toegewezen_medewerker_id::text, v_actor' || E'\n' ||
    '        );';

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0059: het anker van de dossierlogregel past niet exact één keer.';
  end if;

  v_nieuw :=
    '      -- 0059: bij het doorzetten van een nieuwe verantwoordelijke is deze' || E'\n' ||
    '      -- regel een echo van wat 0015 al vastlegde. Eén beslissing, één regel.' || E'\n' ||
    '      if not public.taskflow_verantwoordelijke_verplaatsing() then' || E'\n' ||
    '        insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)' || E'\n' ||
    '          values (' || E'\n' ||
    '            new.client_id, ''toegang_vertrouwelijk_verleend'',' || E'\n' ||
    '            old.toegewezen_medewerker_id::text, new.toegewezen_medewerker_id::text, v_actor' || E'\n' ||
    '          );' || E'\n' ||
    '      end if;';

  v_def := replace(v_def, v_anker, v_nieuw);
  execute v_def;
end $patch$;
