-- ============================================================
-- 0031 — De neerlegging blijft staan zolang haar AV staat
--
-- Gevonden bij het nakijken van de import. Elke ronde van
-- sync_client_tasks() annuleerde de neerleggingstaken van een klant en maakte
-- ze meteen daarna opnieuw aan. Nagemeten op productie:
--
--   vooraf        3 open, 0 geannuleerd
--   na 1 ronde    3 open, 3 geannuleerd
--   na 2 rondes   3 open, 6 geannuleerd
--
-- Dat groeit door: bij elk opslaan van een klant en bij elke maandelijkse
-- onderhoudsronde komen er per dossier drie geannuleerde taken en drie
-- logregels bij. Bij honderd dossiers is dat driehonderd rommeltaken per
-- ronde, en een historiek waarin niet meer te zien is wat er écht geannuleerd
-- werd.
--
-- Waarom het gebeurde: neerlegging_jaarrekening heeft geen eigen tak in de
-- generator. Die taken worden aangemaakt vanuit de AV-tak, als vervolgtaak met
-- voorloper_taak_id naar de algemene vergadering. Maar de opruimstap van
-- sync_client_tasks() oordeelde puur op "bestaat er een lopende
-- client_obligation voor dit verplichtingstype?". Heeft een klant wel een AV
-- maar geen aangevinkte neerlegging -- en dat is precies wat de Excel-import
-- oplevert -- dan zag de opruimstap wezen, terwijl de AV-tak ze een tel later
-- opnieuw aanmaakte.
--
-- De oplossing: een taak met een voorloper wordt bestuurd door die voorloper,
-- niet door haar eigen verplichting. Ze wordt pas opgeruimd wanneer de
-- voorloper zelf weg of geannuleerd is -- dan is er echt geen vergadering meer
-- om na te leggen.
-- ============================================================

create or replace function public.sync_client_tasks(p_client_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_firm_id uuid;
  v_nieuw int;
  r record;
begin
  if v_actor is null then
    raise exception 'Deze actie vereist een ingelogde, gekoppelde medewerker';
  end if;
  if not public.can_access_client(p_client_id) then
    raise exception 'Je hebt geen toegang tot dit klantdossier'
      using errcode = 'insufficient_privilege';
  end if;

  select firm_id into v_firm_id from public.clients where id = p_client_id;
  if v_firm_id is null then
    raise exception 'Klant niet gevonden';
  end if;

  -- Eerst opruimen: open, toekomstige taken van verplichtingen die niet langer
  -- lopen. Annuleren, niet verwijderen -- de geschiedenis van het dossier
  -- blijft zo kloppen.
  for r in
    select ti.id
    from public.task_instances ti
    where ti.client_id = p_client_id
      and ti.bron_type = 'automatisch_gegenereerd'
      and ti.status = 'open'
      and ti.due_date >= current_date
      and ti.obligation_type_id is not null
      and not exists (
        select 1 from public.client_obligations co
        where co.client_id = ti.client_id
          and co.obligation_type_id = ti.obligation_type_id
          and co.actief
          and co.geldig_vanaf <= current_date
          and (co.geldig_tot is null or co.geldig_tot >= current_date)
      )
      -- Een vervolgtaak (de neerlegging na de algemene vergadering) hangt aan
      -- haar voorloper en niet aan een eigen verplichting. Zolang die
      -- vergadering staat, blijft de neerlegging staan; anders annuleren we
      -- hier iets wat de generator een tel later weer aanmaakt.
      and (
        ti.voorloper_taak_id is null
        or not exists (
          select 1 from public.task_instances vl
          where vl.id = ti.voorloper_taak_id
            and vl.status <> 'geannuleerd'
        )
      )
  loop
    update public.task_instances
    set status = 'geannuleerd'
    where id = r.id;
  end loop;

  -- Dan aanvullen wat er bij is gekomen.
  v_nieuw := public.generate_task_instances_intern(v_firm_id, 36, 0, p_client_id);
  return v_nieuw;
end;
$$;
