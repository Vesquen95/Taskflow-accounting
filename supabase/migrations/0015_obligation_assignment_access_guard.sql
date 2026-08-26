-- Taskflow v1 — de toegangscontrole op vertrouwelijke dossiers sluiten aan de
-- kant van de verplichting.
--
-- Aanleiding: de zesde security-verificatie (na 0014). Bevinding C uit de
-- vijfde ronde ("enkel een kantoorbeheerder kan iemand toegang geven tot een
-- vertrouwelijk dossier") werd in 0014 afgedwongen in
-- enforce_task_instance_transition() — dus op de herverdeling van een taak.
-- Maar dat is niet de enige weg waarlangs iemand een taak op een vertrouwelijk
-- dossier krijgt.
--
-- Gereproduceerd als gewone `medewerker` met toegang tot het dossier:
--   update client_obligations set standaard_toegewezen_medewerker_id = <collega>
--   -- daarna draait de kantoorbeheerder gewoon de taakgeneratie:
--   taken op naam van de collega        = 2
--   collega ziet vertrouwelijk dossier  = true
--   auditregels toegangverlening        = 0
--
-- De medewerker raakt zelf geen enkele taak aan, dus de controle uit 0014
-- vuurt niet. generate_task_instances() is SECURITY DEFINER, dus daar gelden
-- RLS noch die trigger. can_view_client() (0008) verleent toegang tot een
-- vertrouwelijke klant zodra iemand er één niet-geannuleerde taak op heeft —
-- en die taken maakt de generator hier keurig aan. Netto: een medewerker
-- beslist over vertrouwelijkheid, zonder spoor, met de generatieronde van de
-- kantoorbeheerder als onwetend hulpmiddel.
--
-- Additief: 0003-0014 zijn al toegepast en worden NIET gewijzigd.
--
-- De generator kiest zijn toegewezene uit drie bronnen (0008):
--   1. client_obligations.standaard_toegewezen_medewerker_id  <- stond open
--   2. clients.standaard_verantwoordelijke_id                 <- al beheerder-only (0008/0009)
--   3. de oudste actieve kantoorbeheerder                     <- ziet per definitie alles
-- Alleen bron 1 ontbrak; die wordt hier gesloten, op dezelfde plek en met
-- dezelfde regel als 0014: wie het dossier nog niet kan zien, kan er alleen
-- door een kantoorbeheerder op gezet worden, en dat komt in het audittrail.
--
-- Bewuste keuze om dit NIET in upsert_generated_task() te zetten: die functie
-- moet kunnen toewijzen wat haar opgedragen wordt. De beslissing hoort waar ze
-- genomen wordt — bij het invullen van de verplichting — zodat de medewerker
-- de weigering meteen ziet in plaats van dagen later een generatieronde die
-- stilletjes iets anders doet.

create or replace function public.enforce_obligation_assignment_access()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid;
  v_vertrouwelijk boolean;
  v_oud uuid;
begin
  v_oud := case when tg_op = 'UPDATE' then old.standaard_toegewezen_medewerker_id else null end;

  -- Niets toegewezen, of niets veranderd: geen toegangsbeslissing.
  if new.standaard_toegewezen_medewerker_id is null
     or new.standaard_toegewezen_medewerker_id is not distinct from v_oud then
    return new;
  end if;

  select vertrouwelijk into v_vertrouwelijk from public.clients where id = new.client_id;
  if not coalesce(v_vertrouwelijk, false) then
    return new;
  end if;

  -- De gekozen medewerker kan het dossier al zien: dit is gewone
  -- werkverdeling, geen toegangverlening.
  if public.can_view_client(new.client_id, new.standaard_toegewezen_medewerker_id) then
    return new;
  end if;

  if not public.is_kantoorbeheerder() then
    raise exception
      'Deze klant is vertrouwelijk en de gekozen collega heeft er nog geen toegang toe. Enkel een kantoorbeheerder kan iemand toegang geven tot een vertrouwelijk dossier.'
      using errcode = 'insufficient_privilege';
  end if;

  v_actor := public.current_employee_id();
  if v_actor is null then
    raise exception 'Deze wijziging vereist een ingelogde, gekoppelde medewerker';
  end if;

  -- Zelfde audittrail als de toewijzingsroute in 0014, zodat beide wegen naar
  -- toegang op één plek in het dossier terugkomen.
  insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
  values (
    new.client_id, 'toegang_vertrouwelijk_verleend',
    v_oud::text, new.standaard_toegewezen_medewerker_id::text, v_actor
  );

  return new;
end;
$$;

revoke execute on function public.enforce_obligation_assignment_access() from public, anon, authenticated;

-- BEFORE: de controle moet de rij tegenhouden vóór ze bestaat. De logregel
-- verwijst naar clients(id), niet naar de verplichting, dus de FK is hier al
-- vervulbaar — anders dan bij de INSERT-trigger op clients in 0009.
drop trigger if exists trg_client_obligations_assignment_access on public.client_obligations;
create trigger trg_client_obligations_assignment_access
  before insert or update of standaard_toegewezen_medewerker_id on public.client_obligations
  for each row
  execute function public.enforce_obligation_assignment_access();
