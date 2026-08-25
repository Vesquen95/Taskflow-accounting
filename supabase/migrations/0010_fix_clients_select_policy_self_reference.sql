-- Taskflow v1 — fix: een klant aanmaken via de app faalde altijd met
-- "new row violates row-level security policy for table clients" (42501).
--
-- Oorzaak: de SELECT-policy op `clients` (0005) luidde
-- `using (public.can_access_client(id))`, en `can_access_client()` (0004)
-- doet zelf `select 1 from public.clients c where c.id = p_client_id ...`.
-- Die policy is dus zelf-refererend: om te beslissen of je een rij van
-- `clients` mag zien, wordt `clients` opnieuw bevraagd.
--
-- Bij een gewone SELECT is dat onschuldig. Bij `INSERT ... RETURNING` niet:
-- Postgres past de SELECT-policy toe op de zojuist ingevoegde rij, maar de
-- subquery binnen de functie draait op de snapshot van het lopende commando
-- en ziet die rij nog niet. De policy antwoordt dus "niet zichtbaar" en het
-- hele INSERT-commando wordt geweigerd. PostgREST voegt RETURNING toe zodra
-- de client `.insert(...).select()` doet — wat de app bij elke nieuwe klant
-- doet — dus klanten aanmaken was volledig stuk. De demo-klanten uit 0007
-- ontsnapten eraan omdat `seed_demo_data_for_firm()` SECURITY DEFINER is en
-- RLS dus overslaat.
--
-- Fix: evalueer de policy tegen de kolommen van de rij zelf in plaats van de
-- tabel opnieuw te bevragen. Exact dezelfde toegangsregel als voorheen
-- (§2.11 + §7 punt 1), maar zonder self-reference — en meteen goedkoper,
-- want er is geen extra self-join per rij meer nodig.
--
-- `actief` blijft afgedwongen: een gedeactiveerde medewerker krijgt NULL uit
-- current_employee_firm_id() (0008), waardoor `firm_id = NULL` onwaar is en
-- er dus niets zichtbaar blijft.
--
-- can_access_client() zelf blijft ongewijzigd en in gebruik voor
-- client_obligations / task_instances / task_status_log / client_change_log:
-- daar bevraagt de functie een *andere* tabel dan die ze beschermt (de
-- clients-rij bestaat daar al), dus het probleem speelt daar niet.

drop policy if exists "clients_select" on public.clients;
create policy "clients_select" on public.clients
  for select using (
    firm_id = public.current_employee_firm_id()
    and (
      not vertrouwelijk
      or public.is_kantoorbeheerder()
      or exists (
        select 1 from public.task_instances ti
        where ti.client_id = clients.id
          and ti.toegewezen_medewerker_id = public.current_employee_id()
          and ti.status <> 'geannuleerd'
      )
    )
  );

-- Zelfde behandeling voor UPDATE. De USING-kant sloeg niet op hetzelfde
-- probleem (de bestaande rij is wél zichtbaar), maar `UPDATE ... RETURNING`
-- past de SELECT-policy toe op de NIEUWE rijversie terwijl de subquery in
-- can_access_client() nog de OUDE kolomwaarden zou zien — bij een wijziging
-- van `vertrouwelijk` levert dat een verkeerd antwoord op. Rij-gebaseerd
-- evalueren haalt die dubbelzinnigheid weg.
drop policy if exists "clients_update" on public.clients;
create policy "clients_update" on public.clients
  for update using (
    firm_id = public.current_employee_firm_id()
    and (
      not vertrouwelijk
      or public.is_kantoorbeheerder()
      or exists (
        select 1 from public.task_instances ti
        where ti.client_id = clients.id
          and ti.toegewezen_medewerker_id = public.current_employee_id()
          and ti.status <> 'geannuleerd'
      )
    )
  ) with check (firm_id = public.current_employee_firm_id());
