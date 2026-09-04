-- ============================================================
-- 0042 — De zes niveaus, en het goedkeuringsrecht dat eruit volgt
--
-- Het kantoor werkt met zes graden: junior, senior, supervisor, manager,
-- director, partner. Vanaf manager mag je aangiftes goedkeuren.
--
-- Tot nu stonden er twee schakelaars los naast elkaar: `rol` (medewerker of
-- kantoorbeheerder) en een handmatig vinkje `mag_goedkeuren`. Dat vinkje kon
-- op een junior staan zonder dat iets protesteerde, en het kon ontbreken bij
-- een manager zonder dat iemand het zag. Twee bronnen voor één regel.
--
-- Vanaf nu is er één bron: de graad. `mag_goedkeuren` blijft als kolom bestaan
-- -- de statusmachine (0011) leest ze, en die wil ik hiervoor niet openbreken
-- -- maar wordt door een trigger uit het niveau afgeleid. Wie het vinkje met
-- de hand probeert te zetten, ziet het meteen terugspringen naar wat de graad
-- zegt.
--
-- ------------------------------------------------------------
-- Waarom `rol` blijft bestaan
--
-- De graad is een BEROEPSniveau; de rol gaat over beheer in de app: mede-
-- werkers uitnodigen, de wettelijke kalender onderhouden, over de teammuur
-- kijken. Dat zijn twee assen. Een partner is vermoedelijk kantoorbeheerder,
-- een manager niet noodzakelijk, en een supervisor kan het zijn zonder ooit
-- iets te mogen goedkeuren. Ze samenvoegen zou een van de twee stil
-- verruimen.
--
-- ------------------------------------------------------------
-- Waarom niveau LEEG mag zijn
--
-- Een verplicht veld met een standaardwaarde zou hier meteen schade doen: elke
-- bestaande medewerker zou "senior" worden en daarmee zijn goedkeuringsrecht
-- verliezen, zonder dat iemand daarom vroeg. Dus: leeg toegestaan, en zolang
-- het leeg is blijft `mag_goedkeuren` gewoon staan zoals het stond. Het
-- medewerkersscherm vraagt erom; het systeem verzint het niet.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'medewerker_niveau') then
    create type public.medewerker_niveau as enum (
      'junior', 'senior', 'supervisor', 'manager', 'director', 'partner'
    );
  end if;
end $$;

alter table public.employees
  add column if not exists niveau public.medewerker_niveau;

comment on column public.employees.niveau is
  'De beroepsgraad: junior, senior, supervisor, manager, director, partner. Vanaf manager volgt het goedkeuringsrecht hieruit (0042). Leeg = nog niet ingevuld; dan blijft mag_goedkeuren staan zoals het met de hand gezet was.';

comment on column public.employees.mag_goedkeuren is
  'Mag aangiftes goedkeuren. Wordt afgeleid uit het niveau zodra dat ingevuld is (manager en hoger); enkel bij een leeg niveau is dit nog een handmatige waarde.';

-- ------------------------------------------------------------
-- De afleiding
-- ------------------------------------------------------------
create or replace function public.niveau_mag_goedkeuren(p_niveau public.medewerker_niveau)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_niveau in ('manager', 'director', 'partner');
$$;

comment on function public.niveau_mag_goedkeuren(public.medewerker_niveau) is
  'Vanaf manager mag je aangiftes goedkeuren. Eén plek, zodat het scherm en de databank niet uit elkaar kunnen lopen.';

revoke execute on function public.niveau_mag_goedkeuren(public.medewerker_niveau) from public, anon;
grant execute on function public.niveau_mag_goedkeuren(public.medewerker_niveau) to authenticated;

create or replace function public.enforce_goedkeuring_volgt_niveau()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.niveau is not null then
    new.mag_goedkeuren := public.niveau_mag_goedkeuren(new.niveau);
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_goedkeuring_volgt_niveau() from public, anon, authenticated;

drop trigger if exists trg_employees_goedkeuring_volgt_niveau on public.employees;
create trigger trg_employees_goedkeuring_volgt_niveau
  before insert or update of niveau, mag_goedkeuren on public.employees
  for each row execute function public.enforce_goedkeuring_volgt_niveau();
