-- 0069 — Te factureren
--
-- Gevraagd (08/10/2026): "een tabblad waar we per klant onze te factureren
-- taken kunnen opnemen. Nog geen bedragen; dat komt later met de
-- opdrachtbrief."
--
-- Een FACTUURPOST is één regel op de lijst: wat er gedaan is, voor welke
-- klant, wanneer, en door wie het op de lijst gezet werd. Hij kan aan een taak
-- hangen ("Aangifte VenB 2025") of los staan ("bijkomend advies
-- herstructurering"), want niet alles wat gefactureerd wordt is een taak in
-- Taskflow.
--
-- Drie keuzes:
--
--  * NIET automatisch. Een afgewerkte taak komt niet vanzelf op de lijst: een
--    btw-aangifte zit bij de ene klant in een forfait en wordt bij de andere
--    apart aangerekend. Dat weet Taskflow pas wanneer de opdrachtbrief erin
--    staat. Tot dan beslist wie het werk doet, met één klik op de taak.
--
--  * NOOIT wissen. Wat niet gefactureerd wordt, krijgt de status
--    'niet_factureren', met wie dat besliste. Een lijst waar regels uit
--    verdwijnen, is een lijst die je niet kunt nakijken.
--
--  * Iedereen die het dossier mag zien, mag er iets op zetten. Afvinken als
--    gefactureerd (of als niet te factureren) mag alleen wie mag goedkeuren of
--    kantoorbeheerder is: dat is de stap die geld betekent.
--
-- Schrijven gebeurt uitsluitend via de functies hieronder (security definer),
-- zoals bij de boekjaarwijzigingen (0052): zo zet de databank zelf wie, wat
-- en wanneer, en kan niemand een stempel vervalsen.
--
-- Later, met de opdrachtbrief: kolommen voor bedrag en tarief erbij. De
-- structuur hier is daarop voorzien en hoeft dan niet om.

create table public.factuurposten (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  task_instance_id uuid references public.task_instances(id) on delete set null,
  omschrijving text not null check (char_length(btrim(omschrijving)) between 1 and 300),
  uitgevoerd_op date not null default current_date,
  notitie text check (notitie is null or char_length(notitie) <= 1000),
  status text not null default 'te_factureren'
    check (status in ('te_factureren', 'gefactureerd', 'niet_factureren')),
  -- Het factuurnummer of een korte verwijzing, bij het afvinken. Optioneel.
  factuurreferentie text check (factuurreferentie is null or char_length(factuurreferentie) <= 100),
  aangemaakt_door uuid not null references public.employees(id),
  aangemaakt_op timestamptz not null default now(),
  afgehandeld_door uuid references public.employees(id),
  afgehandeld_op timestamptz,
  constraint factuurposten_afgehandeld_volledig check (
    (status = 'te_factureren' and afgehandeld_door is null and afgehandeld_op is null)
    or (status <> 'te_factureren' and afgehandeld_door is not null and afgehandeld_op is not null)
  )
);

comment on table public.factuurposten is
  'Wat er per klant te factureren is (0069). Eén regel per prestatie, al dan niet aan een taak gekoppeld. Nooit gewist: niet te factureren is een status. Bedragen volgen later met de opdrachtbrief.';

create index factuurposten_open on public.factuurposten (client_id, uitgevoerd_op) where status = 'te_factureren';
create index factuurposten_client on public.factuurposten (client_id, aangemaakt_op desc);
-- Een taak staat hoogstens één keer open op de lijst: twee keer klikken mag
-- geen dubbele factuurregel opleveren.
create unique index factuurposten_een_open_per_taak
  on public.factuurposten (task_instance_id) where status = 'te_factureren' and task_instance_id is not null;

alter table public.factuurposten enable row level security;

create policy factuurposten_select on public.factuurposten
  for select using (public.can_access_client(client_id));

-- Geen insert-, update- of deletebeleid: zie de kop.
revoke all on public.factuurposten from anon;
revoke insert, update, delete, truncate on public.factuurposten from authenticated;
grant select on public.factuurposten to authenticated;

-- ------------------------------------------------------------
-- Toevoegen
-- ------------------------------------------------------------
create or replace function public.factuurpost_toevoegen(
  p_client_id uuid,
  p_omschrijving text,
  p_uitgevoerd_op date default current_date,
  p_task_instance_id uuid default null,
  p_notitie text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_mij uuid := public.current_employee_id();
  v_id uuid;
begin
  if v_mij is null or not public.can_access_client(p_client_id) then
    raise exception 'Je hebt geen toegang tot dit dossier' using errcode = '42501';
  end if;
  if p_task_instance_id is not null and not exists (
    select 1 from public.task_instances where id = p_task_instance_id and client_id = p_client_id
  ) then
    raise exception 'Deze taak hoort niet bij dit dossier' using errcode = '22023';
  end if;
  if p_task_instance_id is not null and exists (
    select 1 from public.factuurposten
    where task_instance_id = p_task_instance_id and status = 'te_factureren'
  ) then
    raise exception 'Deze taak staat al op de lijst te factureren' using errcode = '23505';
  end if;

  insert into public.factuurposten (client_id, task_instance_id, omschrijving, uitgevoerd_op, notitie, aangemaakt_door)
  values (p_client_id, p_task_instance_id, btrim(p_omschrijving), coalesce(p_uitgevoerd_op, current_date),
          nullif(btrim(p_notitie), ''), v_mij)
  returning id into v_id;
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- Aanpassen: zolang hij nog te factureren is, door wie hem toevoegde of
-- door wie mag afvinken.
-- ------------------------------------------------------------
create or replace function public.factuurpost_wijzigen(
  p_id uuid,
  p_omschrijving text,
  p_uitgevoerd_op date,
  p_notitie text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_mij uuid := public.current_employee_id();
  v_post record;
begin
  select * into v_post from public.factuurposten where id = p_id;
  if v_post.id is null or not public.can_access_client(v_post.client_id) then
    raise exception 'Deze post bestaat niet of je hebt er geen toegang toe' using errcode = '42501';
  end if;
  if v_post.status <> 'te_factureren' then
    raise exception 'Een afgehandelde post pas je niet meer aan; zet hem eerst terug' using errcode = '22023';
  end if;
  if v_post.aangemaakt_door is distinct from v_mij
     and not (public.is_kantoorbeheerder() or public.mag_goedkeuren()) then
    raise exception 'Alleen wie de post toevoegde, of wie mag goedkeuren, past hem aan' using errcode = '42501';
  end if;

  update public.factuurposten
  set omschrijving = btrim(p_omschrijving),
      uitgevoerd_op = coalesce(p_uitgevoerd_op, uitgevoerd_op),
      notitie = nullif(btrim(p_notitie), '')
  where id = p_id;
end;
$$;

-- ------------------------------------------------------------
-- Afvinken, of terugzetten. Meerdere tegelijk: na het maken van een factuur
-- vink je alles van die klant in één keer af.
-- ------------------------------------------------------------
create or replace function public.factuurposten_afhandelen(
  p_ids uuid[],
  p_status text,
  p_factuurreferentie text default null
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_mij uuid := public.current_employee_id();
  v_aantal int;
begin
  if p_status not in ('te_factureren', 'gefactureerd', 'niet_factureren') then
    raise exception 'Onbekende status %', p_status using errcode = '22023';
  end if;
  if v_mij is null or not (public.is_kantoorbeheerder() or public.mag_goedkeuren()) then
    raise exception 'Afvinken mag alleen wie mag goedkeuren of kantoorbeheerder is' using errcode = '42501';
  end if;
  -- Alles of niets: een post die je niet mag zien, laat de hele opdracht
  -- weigeren, zodat er nooit stil maar een deel afgevinkt wordt.
  if exists (
    select 1 from unnest(p_ids) as i(id)
    left join public.factuurposten f on f.id = i.id
    where f.id is null or not public.can_access_client(f.client_id)
  ) then
    raise exception 'Een of meer posten bestaan niet of je hebt er geen toegang toe' using errcode = '42501';
  end if;

  if p_status = 'te_factureren' then
    -- Terugzetten. Kan botsen met een nieuwere open post voor dezelfde taak;
    -- dan weigert de unieke index, en dat is juist.
    update public.factuurposten
    set status = 'te_factureren', afgehandeld_door = null, afgehandeld_op = null, factuurreferentie = null
    where id = any(p_ids) and status <> 'te_factureren';
  else
    update public.factuurposten
    set status = p_status, afgehandeld_door = v_mij, afgehandeld_op = now(),
        factuurreferentie = case when p_status = 'gefactureerd' then nullif(btrim(p_factuurreferentie), '') end
    where id = any(p_ids) and status = 'te_factureren';
  end if;
  get diagnostics v_aantal = row_count;
  return v_aantal;
end;
$$;

revoke execute on function public.factuurpost_toevoegen(uuid, text, date, uuid, text) from public, anon;
revoke execute on function public.factuurpost_wijzigen(uuid, text, date, text) from public, anon;
revoke execute on function public.factuurposten_afhandelen(uuid[], text, text) from public, anon;
grant execute on function public.factuurpost_toevoegen(uuid, text, date, uuid, text) to authenticated;
grant execute on function public.factuurpost_wijzigen(uuid, text, date, text) to authenticated;
grant execute on function public.factuurposten_afhandelen(uuid[], text, text) to authenticated;
