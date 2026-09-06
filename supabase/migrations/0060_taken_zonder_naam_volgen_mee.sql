-- 0060 — Ook de taken zonder naam volgen de verantwoordelijke
--
-- 0059 zette de openstaande taken over van de vórige standaardverantwoordelijke
-- naar de nieuwe. Dat dekte het geval niet dat zich meteen voordeed op een echt
-- dossier:
--
--   1. het dossier wordt aangemaakt zonder verantwoordelijke;
--   2. de taken worden gegenereerd en komen zonder naam in de bak van het team
--      terecht (0040, en dat hoort zo);
--   3. er wordt een verantwoordelijke aangeduid -- maar de taken die er al
--      staan blijven naamloos;
--   4. later wisselt die verantwoordelijke van A naar B. 0059 zoekt taken op
--      naam van A, vindt er nul, en er gebeurt niets.
--
-- Voor wie het scherm bedient ziet stap 4 eruit als een knop die niet werkt.
--
-- De regel wordt daarom breder: een taak ZONDER naam volgt de nieuwe
-- verantwoordelijke, ongeacht wie de vorige standaard was. De grond daarvoor is
-- dezelfde als in 0059: we ontzien menselijke beslissingen. Een taak zonder naam
-- is er geen -- niemand heeft ze opgenomen, ze ligt te wachten tot iemand dat
-- doet.
--
-- De prijs, eerlijk benoemd: wie een taak bewust terugléégt in de bak van het
-- team ("teruggelegd in de bak" in het log) ziet die bij de volgende wissel van
-- verantwoordelijke weer een naam krijgen. Dat is te herstellen met één klik en
-- weegt niet op tegen het omgekeerde: werk dat na een dossieroverdracht
-- onzichtbaar in de bak blijft liggen, wat precies de melding was.
--
-- Andersom geldt het niet: wordt de verantwoordelijke léég gemaakt, dan gaan de
-- taken naar de bak en blijft de bak de bak.

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
    and (
      t.toegewezen_medewerker_id is not distinct from p_oud
      -- 0060: een taak zonder naam ligt in de bak van het team. Niemand heeft
      -- haar opgenomen, dus er is geen beslissing om te ontzien.
      or (p_nieuw is not null and t.toegewezen_medewerker_id is null)
    );

  get diagnostics v_aantal = row_count;

  perform set_config('taskflow.verantwoordelijke_verplaatsing', 'off', true);
  return v_aantal;
end;
$$;

revoke execute on function public.taken_volgen_verantwoordelijke(uuid, uuid, uuid)
  from public, anon, authenticated;
