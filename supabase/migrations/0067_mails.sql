-- 0067 — Mails: meldingen, de maandagmail en systeemberichten
--
-- Taskflow zweeg tot je het opende. Deze migratie zet het leidingwerk neer om
-- mails te versturen; de Edge Function `mail-verzenden` doet het eigenlijke
-- versturen (via Gmail, poort 465 -- Supabase blokkeert 25 en 587).
--
-- Drie soorten mail, één weg naar buiten:
--
--   1. MELDINGEN, op het moment zelf. Een taak die iemand anders op jouw naam
--      zet; een aangifte die op jouw goedkeuring wacht; een aangifte die
--      teruggestuurd werd. Een trigger schrijft een regel in een wachtrij,
--      geen mail. De functie bundelt alles per ontvanger: wie twintig
--      aangiftes tegelijk indient, bezorgt zijn partner één mail met twintig
--      regels, geen twintig mails.
--   2. DE MAANDAGMAIL (0043). De inhoud bestond al; dit is wat hem verstuurt.
--      Eén keer per week per persoon, ook als de functie twee keer draait.
--   3. SYSTEEMBERICHTEN. De maandelijkse fiscale controle draait buiten
--      Taskflow en had geen betrouwbare weg om haar rapport te bezorgen. Ze
--      levert het nu hier in, met een sleutel, en de kantoorbeheerders
--      krijgen het als mail.
--
-- Wat NIET mailt, met opzet:
--   * wat de motor zelf aanmaakt of toewijst. Dat zijn tientallen taken per
--     maand; daar is de maandagmail voor.
--   * wat je zelf doet. Een mail over je eigen klik is ruis.
--
-- Een fout in de wachtrij mag NOOIT een statuswijziging tegenhouden. De
-- trigger vangt alles op en laat de taak met rust; een gemiste melding is
-- erger dan geen melding, maar een aangifte die niet ingediend kan worden
-- omdat de mail stuk is, is veel erger.

-- ------------------------------------------------------------
-- 1. Instellingen, geheimen en wachtrijen
-- ------------------------------------------------------------

-- Niet via de API bereikbaar: Supabase stelt alleen `public` open.
create schema if not exists intern;
revoke all on schema intern from public;

create table intern.geheimen (
  naam text primary key,
  waarde text not null
);
revoke all on intern.geheimen from public;

-- Twee sleutels, willekeurig en in de databank zelf gemaakt. Niemand hoeft ze
-- te kennen of te kopiëren: de cron leest de ene, de functie controleert ze
-- via mail_sleutel_klopt(); de andere gaat één keer mee in de opdracht van de
-- fiscale controle.
insert into intern.geheimen (naam, waarde) values
  -- gen_random_uuid() en niet gen_random_bytes(): die eerste zit in de kern
  -- van Postgres, de tweede in pgcrypto, en dat schema heet niet overal gelijk.
  ('mail_cron', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('systeembericht', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (naam) do nothing;

create table public.mail_instellingen (
  id boolean primary key default true check (id),
  -- Staat hier een adres, dan gaat ELKE mail daarheen, met de echte
  -- ontvanger in het onderwerp. Voor de testfase: wie testgebruikers met
  -- verzonnen of echte adressen aanmaakt, stuurt zo niemand per ongeluk mail.
  omleiden_naar text check (omleiden_naar is null or omleiden_naar ~ '^[^@\s]+@[^@\s]+$'),
  meldingen_aan boolean not null default true,
  weekoverzicht_aan boolean not null default true,
  app_url text,
  -- Waar de functie staat, bv. https://<project>.supabase.co/functions/v1/mail-verzenden.
  functie_url text,
  bijgewerkt_op timestamptz not null default now()
);
insert into public.mail_instellingen (id) values (true) on conflict do nothing;
alter table public.mail_instellingen enable row level security;

create table public.mail_meldingen (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id) on delete cascade,
  task_instance_id uuid not null references public.task_instances(id) on delete cascade,
  soort text not null check (soort in ('toegewezen', 'ter_goedkeuring', 'teruggestuurd')),
  door_employee_id uuid references public.employees(id) on delete set null,
  gemaakt_op timestamptz not null default now(),
  verzonden_op timestamptz,
  pogingen int not null default 0,
  laatste_fout text
);
create index mail_meldingen_wachtend on public.mail_meldingen (gemaakt_op) where verzonden_op is null;
alter table public.mail_meldingen enable row level security;

create table public.systeemberichten (
  id bigint generated always as identity primary key,
  onderwerp text not null check (char_length(onderwerp) between 1 and 200),
  tekst text not null check (char_length(tekst) between 1 and 50000),
  ontvangen_op timestamptz not null default now(),
  verzonden_op timestamptz,
  pogingen int not null default 0,
  laatste_fout text
);
alter table public.systeemberichten enable row level security;

-- Wat er verstuurd is, met een sleutel die dubbel versturen onmogelijk maakt
-- (bv. 'weekoverzicht' / '2026-10-05' / adres).
create table public.mail_verzonden (
  id bigint generated always as identity primary key,
  soort text not null check (soort in ('melding', 'weekoverzicht', 'systeem', 'test')),
  sleutel text not null,
  aan text not null,
  onderwerp text not null,
  verzonden_op timestamptz not null default now(),
  unique (soort, sleutel, aan)
);
alter table public.mail_verzonden enable row level security;

-- Geen policies: niemand leest of schrijft deze tabellen rechtstreeks. De app
-- ziet de stand via mail_status(), de functie werkt met service_role.
revoke all on public.mail_instellingen, public.mail_meldingen, public.systeemberichten, public.mail_verzonden
  from anon, authenticated;

-- ------------------------------------------------------------
-- 2. De trigger: wie hoort er iets van deze wijziging?
-- ------------------------------------------------------------
create or replace function public.mail_melding_bij_taakwijziging()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_client record;
begin
  begin
    select c.id, c.firm_id, c.actief, c.vertrouwelijk, c.team_id into v_client
    from public.clients c where c.id = new.client_id;
    if not coalesce(v_client.actief, false) then
      return null;
    end if;

    -- Toegewezen aan iemand anders dan wie het deed. Niet wat de motor doet:
    -- daar is de maandagmail voor.
    if new.toegewezen_medewerker_id is not null
       and new.toegewezen_medewerker_id is distinct from v_actor
       and new.status not in ('ingediend_afgerond', 'geannuleerd')
       and not public.taskflow_generating()
       and (
         (tg_op = 'INSERT' and new.bron_type = 'handmatig_adhoc')
         or (tg_op = 'UPDATE' and new.toegewezen_medewerker_id is distinct from old.toegewezen_medewerker_id)
       )
    then
      insert into public.mail_meldingen (employee_id, task_instance_id, soort, door_employee_id)
      select e.id, new.id, 'toegewezen', v_actor
      from public.employees e
      where e.id = new.toegewezen_medewerker_id and e.actief and e.auth_user_id is not null;
    end if;

    if tg_op = 'UPDATE' and new.status is distinct from old.status then
      -- Ingediend ter goedkeuring: iedereen die mag goedkeuren en het dossier
      -- mag zien, behalve wie het indiende of het deed.
      if new.status = 'wacht_op_goedkeuring' then
        insert into public.mail_meldingen (employee_id, task_instance_id, soort, door_employee_id)
        select e.id, new.id, 'ter_goedkeuring', v_actor
        from public.employees e
        where e.firm_id = v_client.firm_id
          and e.actief and e.mag_goedkeuren and e.auth_user_id is not null
          and e.id is distinct from new.toegewezen_medewerker_id
          and e.id is distinct from v_actor
          and public.mag_klant_zien(v_client.id, v_client.vertrouwelijk, v_client.team_id, e.id);
      end if;

      -- Teruggestuurd: uit de goedkeuring, maar niet goedgekeurd of geannuleerd.
      if old.status = 'wacht_op_goedkeuring'
         and new.status not in ('ingediend_afgerond', 'geannuleerd')
         and new.toegewezen_medewerker_id is not null
         and new.toegewezen_medewerker_id is distinct from v_actor
      then
        insert into public.mail_meldingen (employee_id, task_instance_id, soort, door_employee_id)
        select e.id, new.id, 'teruggestuurd', v_actor
        from public.employees e
        where e.id = new.toegewezen_medewerker_id and e.actief and e.auth_user_id is not null;
      end if;
    end if;
  exception when others then
    -- Zie de kop: een mail mag het werk nooit tegenhouden.
    raise warning 'mail_melding_bij_taakwijziging: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

revoke execute on function public.mail_melding_bij_taakwijziging() from public, anon, authenticated;

create trigger trg_mail_melding
  after insert or update of status, toegewezen_medewerker_id on public.task_instances
  for each row execute function public.mail_melding_bij_taakwijziging();

-- ------------------------------------------------------------
-- 3. Wat de functie gebruikt (alleen service_role)
-- ------------------------------------------------------------
create or replace function public.mail_sleutel_klopt(p_sleutel text)
returns boolean
language sql
stable security definer set search_path = public
as $$
  select exists (
    select 1 from intern.geheimen where naam = 'mail_cron' and waarde = p_sleutel
  )
$$;

-- De wachtende meldingen, gebundeld per ontvanger. Alleen wat minstens
-- `p_rustig` oud is: een bulkactie van een halve minuut komt zo in één mail.
-- De muur van 0039 wordt hier opnieuw gecontroleerd -- wie intussen het
-- dossier niet meer mag zien, krijgt er ook geen mail meer over.
create or replace function public.mail_meldingen_klaar(p_rustig interval default interval '2 minutes')
returns table (employee_id uuid, naam text, email text, meldingen jsonb, melding_ids bigint[])
language sql
stable security definer set search_path = public
as $$
  with wachtend as (
    select m.*, e.naam as ontvanger, e.email, ti.due_date, ti.periode_label, ti.title,
           c.naam as klant, coalesce(ot.naam, ti.title, 'Ad-hoc taak') as verplichting,
           d.naam as door,
           public.mag_klant_zien(c.id, c.vertrouwelijk, c.team_id, e.id) as zichtbaar
    from public.mail_meldingen m
    join public.employees e on e.id = m.employee_id and e.actief
    join public.task_instances ti on ti.id = m.task_instance_id
    join public.clients c on c.id = ti.client_id
    left join public.obligation_types ot on ot.id = ti.obligation_type_id
    left join public.employees d on d.id = m.door_employee_id
    where m.verzonden_op is null
      and m.pogingen < 5
      and m.gemaakt_op <= now() - p_rustig
  )
  select w.employee_id, min(w.ontvanger), min(w.email),
         jsonb_agg(jsonb_build_object(
           'soort', w.soort,
           'klant', w.klant,
           'verplichting', w.verplichting,
           'periode', w.periode_label,
           'deadline', w.due_date,
           'door', w.door
         ) order by w.soort, w.due_date, w.klant) filter (where w.zichtbaar),
         array_agg(w.id)
  from wachtend w
  group by w.employee_id
$$;

create or replace function public.mail_meldingen_afgehandeld(p_ids bigint[], p_fout text default null)
returns void
language sql
security definer set search_path = public
as $$
  update public.mail_meldingen
  set verzonden_op = case when p_fout is null then now() end,
      pogingen = pogingen + 1,
      laatste_fout = p_fout
  where id = any(p_ids) and verzonden_op is null
$$;

create or replace function public.systeemberichten_klaar()
returns table (id bigint, onderwerp text, tekst text, ontvangers text[])
language sql
stable security definer set search_path = public
as $$
  select s.id, s.onderwerp, s.tekst,
         array(select e.email from public.employees e
               where e.actief and e.rol = 'kantoorbeheerder' and e.auth_user_id is not null
               order by e.naam)
  from public.systeemberichten s
  where s.verzonden_op is null and s.pogingen < 5
  order by s.ontvangen_op
$$;

create or replace function public.systeembericht_afgehandeld(p_id bigint, p_fout text default null)
returns void
language sql
security definer set search_path = public
as $$
  update public.systeemberichten
  set verzonden_op = case when p_fout is null then now() end,
      pogingen = pogingen + 1,
      laatste_fout = p_fout
  where id = p_id and verzonden_op is null
$$;

revoke execute on function public.mail_sleutel_klopt(text) from public, anon, authenticated;
revoke execute on function public.mail_meldingen_klaar(interval) from public, anon, authenticated;
revoke execute on function public.mail_meldingen_afgehandeld(bigint[], text) from public, anon, authenticated;
revoke execute on function public.systeemberichten_klaar() from public, anon, authenticated;
revoke execute on function public.systeembericht_afgehandeld(bigint, text) from public, anon, authenticated;

grant execute on function public.mail_sleutel_klopt(text) to service_role;
grant execute on function public.mail_meldingen_klaar(interval) to service_role;
grant execute on function public.mail_meldingen_afgehandeld(bigint[], text) to service_role;
grant execute on function public.systeemberichten_klaar() to service_role;
grant execute on function public.systeembericht_afgehandeld(bigint, text) to service_role;
-- De maandagmail (0043) stond dicht voor iedereen; de functie moet erbij.
grant execute on function public.weekoverzicht_ontvangers(date) to service_role;
grant execute on function public.weekoverzicht_voor(uuid, date, int) to service_role;
grant select on public.mail_instellingen to service_role;
grant select, insert on public.mail_verzonden to service_role;

-- ------------------------------------------------------------
-- 4. Systeemberichten insturen (de fiscale controle)
--
-- Aanroepbaar met de publieke sleutel, want de controle draait buiten
-- Taskflow. Wat haar beveiligt is de tweede sleutel hierboven. Hoogstens tien
-- per dag: wie de sleutel zou bemachtigen, kan er geen mailkanon van maken.
-- ------------------------------------------------------------
create or replace function public.systeembericht_insturen(p_sleutel text, p_onderwerp text, p_tekst text)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  v_id bigint;
begin
  if not exists (select 1 from intern.geheimen where naam = 'systeembericht' and waarde = p_sleutel) then
    raise exception 'Onbekende sleutel' using errcode = '42501';
  end if;
  if (select count(*) from public.systeemberichten where ontvangen_op > now() - interval '1 day') >= 10 then
    raise exception 'Te veel systeemberichten vandaag' using errcode = '54000';
  end if;
  insert into public.systeemberichten (onderwerp, tekst)
  values (left(p_onderwerp, 200), left(p_tekst, 50000))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.systeembericht_insturen(text, text, text) from public;
grant execute on function public.systeembericht_insturen(text, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 5. Wat de app laat zien en mag doen (kantoorbeheerder)
-- ------------------------------------------------------------
create or replace function public.mail_status()
returns jsonb
language plpgsql
stable security definer set search_path = public
as $$
begin
  if not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder ziet de mailinstellingen' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'omleiden_naar', i.omleiden_naar,
      'meldingen_aan', i.meldingen_aan,
      'weekoverzicht_aan', i.weekoverzicht_aan,
      'ingesteld', i.functie_url is not null,
      'wachtend', (select count(*) from public.mail_meldingen where verzonden_op is null and pogingen < 5)
                + (select count(*) from public.systeemberichten where verzonden_op is null and pogingen < 5),
      'laatst_verzonden', (select max(verzonden_op) from public.mail_verzonden),
      'laatste_fout', (
        select laatste_fout from (
          select laatste_fout, gemaakt_op as op from public.mail_meldingen where laatste_fout is not null
          union all
          select laatste_fout, ontvangen_op from public.systeemberichten where laatste_fout is not null
        ) f order by op desc limit 1
      )
    )
    from public.mail_instellingen i
  );
end;
$$;

-- Een testmail naar jezelf: gaat door exact dezelfde leiding als de rest.
create or replace function public.mail_test_aanvragen()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_naam text;
begin
  if not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder kan een testmail sturen' using errcode = '42501';
  end if;
  select naam into v_naam from public.employees where id = public.current_employee_id();
  insert into public.systeemberichten (onderwerp, tekst)
  values ('Taskflow — testmail',
          'Dit is een testmail, aangevraagd door ' || coalesce(v_naam, 'een kantoorbeheerder') ||
          ' op ' || to_char(now() at time zone 'Europe/Brussels', 'DD/MM/YYYY HH24:MI') || '.' || E'\n\n' ||
          'Komt deze aan, dan werkt het versturen. Meldingen en de maandagmail gaan langs dezelfde weg.');
  perform public.mail_wekker('meldingen');
end;
$$;

revoke execute on function public.mail_status() from public, anon;
revoke execute on function public.mail_test_aanvragen() from public, anon;
grant execute on function public.mail_status() to authenticated;
grant execute on function public.mail_test_aanvragen() to authenticated;

-- ------------------------------------------------------------
-- 6. De wekker: pg_cron roept de functie aan via pg_net
--
-- Alleen als er iets te doen is: elke vijf minuten een lege oproep is
-- verspilling, en het houdt de logs leesbaar.
-- ------------------------------------------------------------
create or replace function public.mail_wekker(p_taak text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_url text;
  v_sleutel text;
begin
  select functie_url into v_url from public.mail_instellingen;
  if v_url is null then
    return;
  end if;
  if p_taak = 'meldingen'
     and not exists (select 1 from public.mail_meldingen where verzonden_op is null and pogingen < 5)
     and not exists (select 1 from public.systeemberichten where verzonden_op is null and pogingen < 5)
  then
    return;
  end if;
  select waarde into v_sleutel from intern.geheimen where naam = 'mail_cron';
  -- Dynamisch, zodat deze functie ook bestaat waar pg_net ontbreekt (de
  -- lokale testdatabank).
  execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 30000)'
    using v_url,
          jsonb_build_object('Content-Type', 'application/json', 'x-taskflow-sleutel', v_sleutel),
          jsonb_build_object('taak', p_taak);
end;
$$;

revoke execute on function public.mail_wekker(text) from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_net;
      create extension if not exists pg_cron;
      perform cron.schedule('taskflow-mail-meldingen', '*/5 * * * *',
        $job$ select public.mail_wekker('meldingen') $job$);
      -- Maandag 05:00 UTC: 07:00 in de zomer, 06:00 in de winter.
      perform cron.schedule('taskflow-weekoverzicht', '0 5 * * 1',
        $job$ select public.mail_wekker('weekoverzicht') $job$);
      raise notice '0067: mails ingepland (meldingen elke 5 minuten, weekoverzicht maandag 05:00 UTC)';
    exception when others then
      raise notice '0067: pg_cron/pg_net niet in te schakelen hier (%)', sqlerrm;
    end;
  else
    raise notice '0067: pg_cron of pg_net niet beschikbaar; mails worden niet ingepland.';
  end if;
end $cron$;
