-- 0061 — Ook de taken zonder verplichting volgen de verantwoordelijke
--
-- 0059 en 0060 verplaatsen de taken van één verplichting. Op een echt dossier
-- bleef er daardoor precies één taak achter: de neerlegging van de jaarrekening.
-- Die hangt niet aan een eigen verplichting maar aan haar voorloper, de
-- algemene vergadering, en draagt dus geen client_obligation_id. Ze viel buiten
-- elke lus en bleef naamloos in de bak liggen terwijl de rest van het dossier
-- al lang bij de nieuwe verantwoordelijke stond.
--
-- Dat is geen randgeval: elke vennootschap met een jaarrekening heeft zo'n
-- taak, en het is er een met een deadline waar een boete aan hangt.
--
-- De verplaatsing krijgt daarom een tweede vorm: naast "de taken van deze
-- verplichting" ook "de taken van dit dossier die aan geen verplichting
-- hangen". Die tweede vorm hoort bij de verantwoordelijke van het DOSSIER --
-- er is immers geen verplichting die een eigen naam kan dragen.
--
-- Losse, met de hand gemaakte taken vallen in diezelfde groep. Ook goed: staan
-- ze op de vorige verantwoordelijke of op niemand, dan volgen ze mee; heeft
-- iemand ze bewust aan een derde gegeven, dan blijven ze staan. Dat is exact
-- de regel van 0059.

drop function if exists public.taken_volgen_verantwoordelijke(uuid, uuid, uuid);

create or replace function public.taken_volgen_verantwoordelijke(
  p_client_id uuid,
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
  where t.client_id = p_client_id
    -- Geen verplichting meegegeven: dan gaat het om de taken die aan geen
    -- enkele verplichting hangen (de neerlegging, en losse taken).
    and (
      case
        when p_client_obligation_id is null then t.client_obligation_id is null
        else t.client_obligation_id = p_client_obligation_id
      end
    )
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

revoke execute on function public.taken_volgen_verantwoordelijke(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;

comment on function public.taken_volgen_verantwoordelijke(uuid, uuid, uuid, uuid) is
  'Zet de openstaande taken over van de vorige naar de nieuwe standaardverantwoordelijke. Met een verplichting: de taken van die verplichting. Zonder: de taken van het dossier die aan geen verplichting hangen. Alleen aan te roepen vanuit de triggers van 0059.';

-- ------------------------------------------------------------
-- De twee triggers geven nu ook de klant mee
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

  select standaard_verantwoordelijke_id into v_dossier
  from public.clients where id = new.client_id;

  v_oud := coalesce(old.standaard_toegewezen_medewerker_id, v_dossier);
  v_nieuw := coalesce(new.standaard_toegewezen_medewerker_id, v_dossier);

  v_aantal := public.taken_volgen_verantwoordelijke(new.client_id, new.id, v_oud, v_nieuw);

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

revoke execute on function public.co_verantwoordelijke_naar_taken() from public, anon, authenticated;

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

  for r in
    select id from public.client_obligations
    where client_id = new.id and standaard_toegewezen_medewerker_id is null
  loop
    v_aantal := v_aantal + public.taken_volgen_verantwoordelijke(
      new.id, r.id, old.standaard_verantwoordelijke_id, new.standaard_verantwoordelijke_id
    );
  end loop;

  -- 0061: en de taken die aan geen verplichting hangen -- de neerlegging van
  -- de jaarrekening voorop.
  v_aantal := v_aantal + public.taken_volgen_verantwoordelijke(
    new.id, null, old.standaard_verantwoordelijke_id, new.standaard_verantwoordelijke_id
  );

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
