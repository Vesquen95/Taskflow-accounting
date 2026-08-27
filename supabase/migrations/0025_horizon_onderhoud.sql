-- Taskflow v1 -- de horizon schuift vanzelf mee.
--
-- Aanleiding: op 27/08/2026 bleken er kantoorbreed 182 taken te ontbreken. Niet
-- omdat de rekenregels fout waren, maar omdat de generatie sinds de eerste
-- opzet nooit meer gedraaid had. De horizon liep tot november 2026 terwijl hij
-- 36 maanden hoort te reiken. Dat kwam pas aan het licht toen het kantoor bij
-- toeval naar een dossier keek waar een taak ontbrak.
--
-- Hetzelfde geldt voor de feestdagenkalender: die liep tot 2027 terwijl de
-- generatie tot 2029 rekende, waardoor een algemene vergadering op Nieuwjaar
-- 2029 belandde.
--
-- Beide gaten hadden dezelfde vorm: werk dat met de hand moest gebeuren en dat
-- niemand herinnerde. Deze migratie automatiseert het, met een uitdrukkelijke
-- voorwaarde -- het mag niet stil gebeuren. Een maandelijkse job die honderd
-- dossiers herberekent zonder spoor is precies het soort stilte waar dit
-- systeem al twee keer op vastliep. Vandaar de logtabel, en de laatste stand
-- ervan op het beheerscherm.
--
-- Additief: 0003-0024 zijn al toegepast en worden NIET gewijzigd.

-- ============================================================
-- 1. Het logboek van het onderhoud
-- ============================================================
create table if not exists public.onderhoud_log (
  id uuid primary key default gen_random_uuid(),
  gestart_op timestamptz not null default now(),
  geeindigd_op timestamptz,
  -- Wie de ronde startte: 'cron' of de naam van wie op de knop duwde.
  aanleiding text not null default 'cron' check (char_length(aanleiding) <= 100),
  nieuwe_taken int,
  nieuwe_feestdagen int,
  -- Gevuld wanneer de ronde afbrak. Een lege ronde en een mislukte ronde zien
  -- er in een teller allebei uit als nul; dit veld houdt ze uit elkaar.
  fout text
);

create index if not exists idx_onderhoud_log_gestart on public.onderhoud_log(gestart_op desc);

alter table public.onderhoud_log enable row level security;

-- Alleen lezen, en alleen door wie het onderhoud van het kantoor beheert. Er
-- is geen INSERT/UPDATE-policy: schrijven gebeurt uitsluitend door de
-- onderhoudsfunctie hieronder (security definer), nooit via de app.
drop policy if exists "onderhoud_log_select" on public.onderhoud_log;
create policy "onderhoud_log_select" on public.onderhoud_log
  for select to authenticated
  using (public.is_kantoorbeheerder());

revoke all on public.onderhoud_log from anon;
grant select on public.onderhoud_log to authenticated;

comment on table public.onderhoud_log is
  'Elke ronde horizon-onderhoud laat hier een spoor na. Zonder dit spoor is een maandelijkse job die honderd dossiers herberekent onzichtbaar -- en dan merk je een gat pas als er een deadline mist.';

-- ============================================================
-- 2. De onderhoudsronde
-- ============================================================
-- Twee dingen, in deze volgorde:
--   1. de feestdagenkalender aanvullen tot ruim over de horizon
--   2. de taken opnieuw genereren, per kantoor
--
-- De volgorde is niet vrijblijvend. Genereer je eerst, dan worden deadlines
-- berekend tegen een kalender die de laatste jaren nog niet kent, en verschuift
-- de motor daar alleen op weekends. De feestdagen eerst betekent dat elke taak
-- meteen op de juiste dag landt.
create or replace function public.onderhoud_taken(p_aanleiding text default 'cron')
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_log_id uuid;
  v_actor uuid;
  v_horizon_jaar int := extract(year from (current_date + interval '36 months'))::int;
  v_jaar int;
  v_feestdagen int := 0;
  v_taken int := 0;
  v_n int;
  r_firm record;
begin
  insert into public.onderhoud_log (aanleiding) values (coalesce(p_aanleiding, 'cron'))
    returning id into v_log_id;

  begin
    -- 1. Feestdagen tot drie jaar over de horizon, zodat dit niet elke maand
    --    net aan is. belgische_feestdagen() rekent ze uit (migratie 0023).
    select e.id into v_actor from public.employees e
     where e.rol = 'kantoorbeheerder' and e.actief order by e.created_at limit 1;

    if v_actor is not null then
      for v_jaar in extract(year from current_date)::int .. v_horizon_jaar + 3 loop
        insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
        select v_jaar, f.datum, f.omschrijving, v_actor, v_actor
          from public.belgische_feestdagen(v_jaar) f
         where not exists (select 1 from public.public_holidays h where h.datum = f.datum);
        get diagnostics v_n = row_count;
        v_feestdagen := v_feestdagen + v_n;
      end loop;
    end if;

    -- 2. De horizon opschuiven, kantoor per kantoor. Backfill 0: taken in het
    --    verleden alsnog aanmaken helpt niemand (migratie 0018).
    for r_firm in select id from public.firms loop
      v_taken := v_taken + public.generate_task_instances_intern(r_firm.id, 36, 0);
    end loop;

    update public.onderhoud_log
       set geeindigd_op = now(), nieuwe_taken = v_taken, nieuwe_feestdagen = v_feestdagen
     where id = v_log_id;

  exception when others then
    -- De fout vastleggen en NIET opnieuw opwerpen.
    --
    -- Dat laatste is bewust en contra-intuïtief. Werp je de fout door, dan
    -- draait de aanroepende transactie terug -- inclusief de logregel die de
    -- mislukking vastlegt. De storing verdwijnt dan spoorloos, en dat is exact
    -- de stilte waar deze migratie tegen bedoeld is. Postgres kent geen
    -- autonome transactie om dat te omzeilen.
    --
    -- Het logboek is dus de plek waar een mislukking zichtbaar wordt, niet de
    -- afloop van de cron-taak. Het beheerscherm toont de laatste ronde en zet
    -- ze in het rood zodra `fout` gevuld is.
    update public.onderhoud_log
       set geeindigd_op = now(), nieuwe_taken = v_taken, nieuwe_feestdagen = v_feestdagen,
           fout = left(sqlerrm, 2000)
     where id = v_log_id;
  end;

  return v_log_id;
end $$;

comment on function public.onderhoud_taken(text) is
  'Een ronde horizon-onderhoud: feestdagen aanvullen, dan de taken opnieuw genereren per kantoor. Laat altijd een rij na in onderhoud_log, ook bij een fout.';

-- Niet aanroepbaar vanuit de app: dit is instance-breed werk dat over alle
-- kantoren loopt. De kantoorbeheerder heeft de knop "Genereer taken nu" voor
-- zijn eigen kantoor (generate_task_instances, 0021).
revoke all on function public.onderhoud_taken(text) from public, anon, authenticated;

-- ============================================================
-- 3. De maandelijkse afspraak
-- ============================================================
-- pg_cron zit niet in elke opzet (de lokale testdatabase heeft het niet), dus
-- dit deel is voorwaardelijk. Ontbreekt de extensie, dan blijft alles hierboven
-- gewoon werken en kan het onderhoud met de hand gestart worden.
--
-- Eén keer per maand volstaat: de horizon reikt 36 maanden, dus een gemiste
-- ronde is nooit meteen een gemiste deadline. 's Nachts op de eerste, want de
-- herberekening raakt open taken en dat doe je niet tijdens het werk.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.unschedule('taskflow-horizon-onderhoud')
        where exists (select 1 from cron.job where jobname = 'taskflow-horizon-onderhoud');
      perform cron.schedule(
        'taskflow-horizon-onderhoud',
        '0 3 1 * *',
        $cron$select public.onderhoud_taken('cron')$cron$
      );
      raise notice 'pg_cron: taskflow-horizon-onderhoud staat gepland op de 1e van de maand, 03:00 UTC';
    exception when insufficient_privilege or feature_not_supported then
      raise notice 'pg_cron aanwezig maar niet in te schakelen hier; plan het onderhoud met de hand.';
    end;
  else
    raise notice 'pg_cron niet beschikbaar; public.onderhoud_taken() moet met de hand gestart worden.';
  end if;
end $$;
