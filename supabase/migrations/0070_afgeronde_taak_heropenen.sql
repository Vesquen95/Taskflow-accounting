-- 0070 — Een afgeronde taak heropenen
--
-- Gevraagd (10/10/2026): "een lijst met afgeronde taken; mocht iemand per
-- ongeluk te snel zijn geweest, dat je deze makkelijk kan terughalen."
--
-- Tot nu was "ingediend/afgerond" een eindpunt: de transitietrigger (0011)
-- weigerde elke wijziging. Dat blijft de regel. Deze migratie voegt één
-- uitzondering toe, en alleen langs één weg: taak_heropenen().
--
--   * Terug naar "in uitvoering", niet naar "open": het werk is begonnen, en
--     wie heropent, gaat het verbeteren.
--   * Altijd met een reden. Die komt in de historiek van de taak, naast wie
--     het deed. Een aangifte die als ingediend stond en het niet meer is, moet
--     achteraf uit te leggen zijn.
--   * De stempels gaan weg: afgerond_op, en bij een goedgekeurde taak ook
--     goedgekeurd_door en goedgekeurd_op. Wie opnieuw indient, laat opnieuw
--     goedkeuren -- anders hangt een oude goedkeuring aan nieuw werk.
--   * Wie mag het?
--       - een kantoorbeheerder of iemand die mag goedkeuren: altijd;
--       - de verantwoordelijke zelf: alleen bij een taak zonder goedkeuring.
--         Wie zijn eigen taak te vroeg afvinkte, haalt ze terug. Een
--         goedgekeurde aangifte terugdraaien is een beslissing van wie
--         goedkeurt, niet van wie indiende.
--
-- Rechtstreeks de status terugzetten blijft onmogelijk: de trigger laat de
-- overgang alleen toe wanneer taak_heropenen() haar voor precies deze taak
-- aangekondigd heeft (transactie-lokaal, zoals taskflow_zet_nvt in 0058).

create or replace function public.taskflow_heropent(p_task_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(
    nullif(current_setting('taskflow.heropen_task_id', true), '') = p_task_id::text,
    false
  );
$$;

revoke execute on function public.taskflow_heropent(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- De transitietrigger: één uitzondering, op vier plaatsen
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_ankers text[] := array[
    -- 1. Het slot op afgesloten taken.
    E'      if not (old.status = ''geannuleerd'' and new.status = ''open'' and public.is_kantoorbeheerder()) then\n',
    -- 2. De toegelaten overgangen.
    E'      when ''geannuleerd'' then\n        new.status = ''open''\n',
    -- 3. De logregel.
    E'      when old.status = ''geannuleerd'' then ''Geannuleerde taak heropend door een kantoorbeheerder.''\n',
    -- 4. De stempels wissen.
    E'    if old.status = ''geannuleerd'' then\n      new.afgerond_op := null;\n'
  ];
  v_nieuw text[] := array[
    E'      if not (old.status = ''geannuleerd'' and new.status = ''open'' and public.is_kantoorbeheerder())\n' ||
    E'         -- 0070: heropenen, alleen langs taak_heropenen().\n' ||
    E'         and not (old.status = ''ingediend_afgerond'' and new.status = ''in_uitvoering'' and public.taskflow_heropent(old.id)) then\n',
    E'      when ''geannuleerd'' then\n        new.status = ''open''\n' ||
    E'      when ''ingediend_afgerond'' then\n        new.status = ''in_uitvoering'' and public.taskflow_heropent(old.id)\n',
    E'      when old.status = ''geannuleerd'' then ''Geannuleerde taak heropend door een kantoorbeheerder.''\n' ||
    E'      when old.status = ''ingediend_afgerond'' then\n' ||
    E'        ''Afgeronde taak heropend. Reden: '' || coalesce(nullif(current_setting(''taskflow.heropen_reden'', true), ''''), ''geen reden opgegeven'')\n',
    E'    if old.status in (''geannuleerd'', ''ingediend_afgerond'') then\n      new.afgerond_op := null;\n'
  ];
  i int;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'enforce_task_instance_transition';
  for i in 1 .. array_length(v_ankers, 1) loop
    if (length(v_def) - length(replace(v_def, v_ankers[i], ''))) / length(v_ankers[i]) <> 1 then
      raise exception '0070: anker % past niet exact één keer in enforce_task_instance_transition().', i;
    end if;
    v_def := replace(v_def, v_ankers[i], v_nieuw[i]);
  end loop;
  execute v_def;
end $patch$;

-- ------------------------------------------------------------
-- De enige weg
-- ------------------------------------------------------------
create or replace function public.taak_heropenen(p_task_id uuid, p_reden text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_mij uuid := public.current_employee_id();
  v_taak record;
begin
  if v_mij is null then
    raise exception 'Heropenen vereist een ingelogde, gekoppelde medewerker' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reden, ''))) < 3 then
    raise exception 'Geef een reden op: waarom wordt deze taak heropend?' using errcode = '22023';
  end if;

  select id, client_id, status, vereist_goedkeuring, toegewezen_medewerker_id into v_taak
  from public.task_instances where id = p_task_id;
  if v_taak.id is null or not public.can_access_client(v_taak.client_id) then
    raise exception 'Deze taak bestaat niet of je hebt er geen toegang toe' using errcode = '42501';
  end if;
  if v_taak.status <> 'ingediend_afgerond' then
    raise exception 'Alleen een afgeronde taak kan heropend worden' using errcode = '22023';
  end if;
  if not (
    public.is_kantoorbeheerder() or public.mag_goedkeuren()
    or (not v_taak.vereist_goedkeuring and v_taak.toegewezen_medewerker_id = v_mij)
  ) then
    raise exception
      'Een goedgekeurde taak heropent alleen wie mag goedkeuren; een taak zonder goedkeuring ook de verantwoordelijke zelf'
      using errcode = '42501';
  end if;

  perform set_config('taskflow.heropen_task_id', p_task_id::text, true);
  perform set_config('taskflow.heropen_reden', left(btrim(p_reden), 500), true);
  update public.task_instances set status = 'in_uitvoering' where id = p_task_id;
  perform set_config('taskflow.heropen_task_id', '', true);
  perform set_config('taskflow.heropen_reden', '', true);
end;
$$;

revoke execute on function public.taak_heropenen(uuid, text) from public, anon;
grant execute on function public.taak_heropenen(uuid, text) to authenticated;
