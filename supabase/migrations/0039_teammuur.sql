-- ============================================================
-- 0039 — De muur: je ziet de dossiers van je eigen team
--
-- Team AAL hoort niet in de dossiers van ANT te kunnen kijken. De drie
-- Zaventem-teams staan onderling ook apart: de afscherming loopt per team,
-- niet per vestiging.
--
-- Drie uitzonderingen, elk met een reden:
--
--  1. Een dossier ZONDER team blijft voor iedereen van het kantoor zichtbaar.
--     Honderd bestaande dossiers hebben nog geen team; ze onzichtbaar maken
--     tot iemand ze indeelt zou werk laten verdwijnen zonder dat iemand het
--     merkt. Het scherm zegt dat er nog een team gekozen moet worden.
--
--  2. Een KANTOORBEHEERDER ziet alles. Iemand moet over de muur kunnen kijken,
--     al was het maar om dossiers in te delen.
--
--  3. Wie een TAAK TOEGEWEZEN kreeg op een dossier, ziet dat dossier -- ook
--     over de teamgrens heen. Dat is dezelfde uitzondering die er al staat
--     voor vertrouwelijke dossiers, en om dezelfde reden: iemand heeft dat
--     bewust gedaan, en een taak die je moet doen maar niet mag openen is
--     erger dan een dossier te veel zien.
--
-- ------------------------------------------------------------
-- Waarom de regel in TWEE functies staat en niet in één
--
-- De verleiding is om de policy op `clients` gewoon can_view_client(id, ...)
-- te laten aanroepen. Dat werkt niet, en migratie 0010 legt precies uit
-- waarom: can_view_client() bevraagt zelf `clients`, en bij
-- `INSERT ... RETURNING` -- wat de app bij elke nieuwe klant doet -- draait
-- die subquery op een snapshot waarin de zojuist ingevoegde rij nog niet
-- bestaat. De policy antwoordt dan "niet zichtbaar" en het hele INSERT wordt
-- geweigerd. Klanten aanmaken was daardoor ooit volledig stuk.
--
-- Daarom hieronder één predikaat met twee ingangen:
--
--   mag_klant_zien(client_id, vertrouwelijk, team_id, medewerker)
--       krijgt de kolommen van de rij MEE en bevraagt `clients` dus nooit.
--       Dit is wat de policies op `clients` zelf gebruiken.
--
--   can_view_client(client_id, medewerker)
--       haalt die kolommen op en geeft ze door. Voor alle andere tabellen --
--       verplichtingen, taken, logs -- waar de klantrij al bestaat en het
--       probleem niet speelt.
--
-- Zo staat de regel op één plek en blijft de val van 0010 dicht.
-- ============================================================

create or replace function public.mag_klant_zien(
  p_client_id uuid,
  p_vertrouwelijk boolean,
  p_team_id uuid,
  p_employee_id uuid
)
returns boolean
language sql
stable security definer set search_path = public
as $$
  select
    e.actief
    -- Vertrouwelijkheid (0008): ongewijzigd.
    and (
      not p_vertrouwelijk
      or e.rol = 'kantoorbeheerder'
      or exists (
        select 1 from public.task_instances ti
        where ti.client_id = p_client_id
          and ti.toegewezen_medewerker_id = p_employee_id
          and ti.status <> 'geannuleerd'
      )
    )
    -- Team (0039): per team, dus ZAV1 ziet ZAV2 niet.
    and (
      p_team_id is null
      or e.rol = 'kantoorbeheerder'
      or exists (
        select 1 from public.employee_teams et
        where et.employee_id = p_employee_id
          and et.team_id = p_team_id
      )
      or exists (
        select 1 from public.task_instances ti
        where ti.client_id = p_client_id
          and ti.toegewezen_medewerker_id = p_employee_id
          and ti.status <> 'geannuleerd'
      )
    )
  from public.employees e
  where e.id = p_employee_id;
$$;

comment on function public.mag_klant_zien(uuid, boolean, uuid, uuid) is
  'Het toegangspredikaat op de kolommen van de klantrij zelf, zodat het ook binnen de policies op clients gebruikt kan worden zonder die tabel opnieuw te bevragen (zie migratie 0010). Twee regels: vertrouwelijkheid (0008) en team (0039).';

-- De policies op `clients` roepen dit aan, en een policy wordt uitgevoerd als
-- de rol die de query stelt. `authenticated` heeft er dus EXECUTE op nodig --
-- net als can_access_client(), can_view_client() en can_access_task_row(), die
-- om exact dezelfde reden aanroepbaar zijn. Anoniem blijft het dicht.
revoke execute on function public.mag_klant_zien(uuid, boolean, uuid, uuid) from public, anon;
grant execute on function public.mag_klant_zien(uuid, boolean, uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- De ingang voor alle andere tabellen
-- ------------------------------------------------------------
create or replace function public.can_view_client(p_client_id uuid, p_employee_id uuid)
returns boolean
language sql
stable security definer set search_path = public
as $$
  select public.mag_klant_zien(c.id, c.vertrouwelijk, c.team_id, p_employee_id)
  from public.clients c
  where c.id = p_client_id;
$$;

comment on function public.can_view_client(uuid, uuid) is
  'Mag deze medewerker dit dossier zien? Haalt de klantrij op en legt ze langs mag_klant_zien(). Gebruik deze variant overal BEHALVE in de policies op clients zelf.';

revoke execute on function public.can_view_client(uuid, uuid) from public, anon;

-- ------------------------------------------------------------
-- De taakregel volgt hetzelfde predikaat
--
-- can_access_task_row() had de vertrouwelijkheidsregel overgeschreven in
-- plaats van ze op te vragen. Twee kopieën van dezelfde regel lopen vroeg of
-- laat uiteen, en dan is er één die te veel toont. Ze houdt alleen haar eigen
-- uitzondering over: een taak die aan jou toegewezen is, mag je zien.
-- ------------------------------------------------------------
create or replace function public.can_access_task_row(
  p_client_id uuid,
  p_toegewezen_medewerker_id uuid,
  p_status public.task_status
)
returns boolean
language sql
stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.clients c
    where c.id = p_client_id
      and c.firm_id = public.current_employee_firm_id()
      and (
        public.mag_klant_zien(c.id, c.vertrouwelijk, c.team_id, public.current_employee_id())
        or (
          p_toegewezen_medewerker_id = public.current_employee_id()
          and p_status <> 'geannuleerd'
        )
      )
  );
$$;

comment on function public.can_access_task_row(uuid, uuid, public.task_status) is
  'Mag deze medewerker deze taakrij zien? Het dossier moet zichtbaar zijn (mag_klant_zien), of de taak moet aan hem toegewezen zijn en niet geannuleerd.';

revoke execute on function public.can_access_task_row(uuid, uuid, public.task_status) from public, anon;

-- ------------------------------------------------------------
-- De klantpolicies: rij-gebaseerd, zonder clients opnieuw te bevragen
-- ------------------------------------------------------------
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select using (
    firm_id = public.current_employee_firm_id()
    and public.mag_klant_zien(id, vertrouwelijk, team_id, public.current_employee_id())
  );

drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients
  for update
  using (
    firm_id = public.current_employee_firm_id()
    and public.mag_klant_zien(id, vertrouwelijk, team_id, public.current_employee_id())
  )
  with check (firm_id = public.current_employee_firm_id());
