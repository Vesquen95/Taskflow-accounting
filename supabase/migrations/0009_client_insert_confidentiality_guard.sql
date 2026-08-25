-- Taskflow v1 — closes the residual gap from the security re-review of
-- 0008 (High finding #4, follow-up): 0008's
-- block_unaudited_confidentiality_change() trigger only fires on `before
-- update of vertrouwelijk, standaard_verantwoordelijke_id` on `clients`.
-- It never covered INSERT — the `clients_insert` RLS policy (0005) only
-- checks `firm_id = current_employee_firm_id()`, not role — so any
-- ordinary medewerker could create a brand-new client with
-- `vertrouwelijk=true` and an arbitrary `standaard_verantwoordelijke_id` in
-- a single INSERT, entirely bypassing the kantoorbeheerder-only gate and
-- leaving no client_change_log trail. This is additive: 0008 is already
-- applied in production and is left untouched.
--
-- Fix: extend the *same* audit function (block_unaudited_confidentiality_
-- change(), same name, reused so there is exactly one place that owns this
-- authorization rule) to also handle TG_OP = 'INSERT', gated behind a
-- second trigger. A non-kantoorbeheerder can still create a client, just
-- only with vertrouwelijk=false and standaard_verantwoordelijke_id=null
-- (the safe defaults) — a kantoorbeheerder can promote it afterwards via
-- the already-guarded UPDATE path.
--
-- Timing note: the INSERT-side trigger must be AFTER INSERT, not BEFORE.
-- The UPDATE-side trigger can safely be BEFORE because `old`/`new` both
-- refer to a row that already exists in `clients`. On INSERT there is no
-- `old`, and — more importantly — if we tried to write the audit-log entry
-- for `new.id` from a BEFORE INSERT trigger, the client_change_log FK to
-- clients(id) would fail because the clients row has not actually been
-- written yet at that point (BEFORE triggers run before the row is added
-- to the table, even though column defaults like the generated `id` are
-- already resolved into `new`). Firing AFTER INSERT sidesteps that: the
-- row exists by then, and if the function raises an exception the entire
-- INSERT statement (including the just-written row) is rolled back
-- atomically within the same transaction — so this is just as much of a
-- hard block as a BEFORE trigger would have been, just log-safe.
create or replace function public.block_unaudited_confidentiality_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    if new.vertrouwelijk or new.standaard_verantwoordelijke_id is not null then
      if not public.is_kantoorbeheerder() then
        raise exception
          'Enkel een kantoorbeheerder kan een klant meteen als vertrouwelijk aanmaken of bij aanmaak een standaard verantwoordelijke instellen. Maak de klant eerst aan zonder deze velden; een kantoorbeheerder kan ze nadien zetten.'
          using errcode = 'insufficient_privilege';
      end if;

      v_actor := public.current_employee_id();
      if v_actor is null then
        raise exception 'Aanmaken vereist een ingelogde, gekoppelde medewerker';
      end if;

      -- A kantoorbeheerder is allowed to set these at creation time; log it
      -- for the same audit trail as the update path (oude_waarde is null,
      -- there was no prior row).
      if new.vertrouwelijk then
        insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
        values (new.id, 'vertrouwelijk', null, new.vertrouwelijk::text, v_actor);
      end if;

      if new.standaard_verantwoordelijke_id is not null then
        insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
        values (new.id, 'standaard_verantwoordelijke_id', null, new.standaard_verantwoordelijke_id::text, v_actor);
      end if;
    end if;

    return new;
  end if;

  -- tg_op = 'UPDATE' — unchanged from 0008.
  if new.vertrouwelijk is distinct from old.vertrouwelijk
     or new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id then

    if not public.is_kantoorbeheerder() then
      raise exception
        'Enkel een kantoorbeheerder kan de vertrouwelijkheid of de standaard verantwoordelijke van een klant wijzigen.'
        using errcode = 'insufficient_privilege';
    end if;

    v_actor := public.current_employee_id();
    if v_actor is null then
      raise exception 'Wijziging vereist een ingelogde, gekoppelde medewerker';
    end if;

    if new.vertrouwelijk is distinct from old.vertrouwelijk then
      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
      values (new.id, 'vertrouwelijk', old.vertrouwelijk::text, new.vertrouwelijk::text, v_actor);
    end if;

    if new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id then
      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
      values (new.id, 'standaard_verantwoordelijke_id', old.standaard_verantwoordelijke_id::text, new.standaard_verantwoordelijke_id::text, v_actor);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_clients_block_unaudited_confidentiality_insert on public.clients;
create trigger trg_clients_block_unaudited_confidentiality_insert
  after insert on public.clients
  for each row
  execute function public.block_unaudited_confidentiality_change();

revoke execute on function public.block_unaudited_confidentiality_change() from public, anon, authenticated;
