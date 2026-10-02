-- 0065 — Een nieuwe of ingetrokken feestdag respecteert de richting van de taak
--
-- Gevonden op 02/10/2026 door een eigenschapstest (52.6) met een verschoven
-- klok. De bijzondere btw-aangifte van 2026-Q1 heeft als wettelijke datum
-- zaterdag 25/04/2026. De motor plant ze correct op vrijdag 24/04: deze
-- aangifte schuift nooit vooruit (0048). Daarna werd 1 mei als feestdag
-- toegevoegd, en de feestdagentrigger zette de taak op maandag 27/04 -- twee
-- dagen NA de wettelijke deadline, voor een aangifte waarvoor de FOD geen
-- uitstel geeft. Het logboek zei het letterlijk: "Herberekend n.a.v. nieuwe
-- feestdag 01/05/2026".
--
-- Twee fouten in recalc_due_dates_after_holiday_change():
--
--   1. Ze rekende altijd met next_business_day(), dus vooruit. Sinds 0048
--      schuiven vier verplichtingen naar de werkdag ERVOOR: de btw-
--      kwartaalaangifte na 1 mei 2026, de bijzondere aangifte, de kwartaal-
--      IC-opgave en de bedrijfsvoorheffing (0051). De trigger was ouder dan
--      die regel en is nooit bijgewerkt.
--   2. Haar selectie (wettelijk <= feestdag, werkdatum >= feestdag - 7) was
--      op vooruitschuiven gesneden. Een feestdag op de vrijdag vóór een
--      achteruitschuivende zaterdagdeadline viel erbuiten -- de taak bleef
--      op de feestdag staan -- en een feestdag een week later viel erbinnen.
--
-- Dit raakt productie zodra iemand de feestdagenkalender aanpast: een
-- brugdag toevoegen of een feestdag intrekken verzette zo stil een reeks
-- deadlines tot na hun wettelijke datum.
--
-- De oplossing begint bij de bron. Welke kant een taak uitschuift, besliste
-- de motor bij het aanmaken (p_verschuiving), maar dat werd nergens
-- bewaard -- dus kon geen enkele trigger het later weten. Nu staat het op de
-- taak zelf, in `verschuiving`, en rekent elke herberekening met dezelfde
-- regel als de motor: werkdatum(wettelijk, verschuiving).
--
-- De override-trigger van de wettelijke kalender (recalc_due_dates_on_legal_
-- calendar_override) rekent nog met next_business_day(). Dat klopt vandaag:
-- ze raakt alleen de aangiften VenB, RPB en PB, en die schuiven vooruit. Komt
-- er ooit een achteruitschuivende verplichting in de jaarlijkse kalender,
-- dan hoort ze ook werkdatum() te gebruiken.

-- ------------------------------------------------------------
-- 1. De richting op de taak
-- ------------------------------------------------------------
alter table public.task_instances
  add column verschuiving text not null default 'vooruit'
  constraint task_instances_verschuiving_geldig check (verschuiving in ('vooruit', 'terug'));

comment on column public.task_instances.verschuiving is
  'Naar welke werkdag de werkdatum schuift als de wettelijke datum geen werkdag is: vooruit (next_business_day) of terug (vorige_werkdag). Gezet door de motor bij het aanmaken (0065), daarna vast.';

-- De bestaande taken: dezelfde regels als de motor in generate_task_instances_
-- intern() (0048, 0050, 0051).
update public.task_instances ti
set verschuiving = 'terug'
from public.obligation_types ot
where ot.id = ti.obligation_type_id
  and (
    (ot.code = 'btw_aangifte' and ti.periode_label ~ '-Q[1-4]$' and ti.due_date_wettelijk >= date '2026-05-01')
    or ot.code in ('btw_bijzondere_aangifte', 'bedrijfsvoorheffing')
    or (ot.code = 'ic_opgave' and ti.periode_label ~ '-Q[1-4]$')
  );

-- Zelfcontrole: een taak die vóór haar wettelijke datum gepland staat, zonder
-- handmatige afspraak, kan alleen achteruit geschoven zijn. Staat ze nu op
-- 'vooruit', dan klopt de regel hierboven niet met wat de motor deed, en
-- hoort deze migratie te stoppen in plaats van een verkeerde richting vast te
-- leggen.
do $$
declare v_n int;
begin
  select count(*) into v_n from public.task_instances
   where due_date < due_date_wettelijk and due_date_handmatig_op is null and verschuiving = 'vooruit';
  if v_n > 0 then
    raise exception '0065: % taak/taken staan vóór hun wettelijke datum maar kregen richting vooruit', v_n;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Eén regel voor de werkdatum
-- ------------------------------------------------------------
create or replace function public.werkdatum(p_wettelijk date, p_verschuiving text)
returns date
language sql
stable
set search_path = public
as $$
  select case when p_verschuiving = 'terug'
              then public.vorige_werkdag(p_wettelijk)
              else public.next_business_day(p_wettelijk) end
$$;

revoke execute on function public.werkdatum(date, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. De motor bewaart de richting die hij koos
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_kolommen text := E'    voorlopige_datum, vereist_goedkeuring\n  ) values (';
  v_waarden  text := E'    p_voorlopige_datum, (p_categorie = ''wettelijk'')\n  )\n  on conflict';
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'upsert_generated_task';
  if (length(v_def) - length(replace(v_def, v_kolommen, ''))) / length(v_kolommen) <> 1 then
    raise exception '0065: het anker van de kolommen past niet exact één keer in upsert_generated_task().';
  end if;
  if (length(v_def) - length(replace(v_def, v_waarden, ''))) / length(v_waarden) <> 1 then
    raise exception '0065: het anker van de waarden past niet exact één keer in upsert_generated_task().';
  end if;
  v_def := replace(v_def, v_kolommen, E'    voorlopige_datum, vereist_goedkeuring, verschuiving\n  ) values (');
  v_def := replace(v_def, v_waarden,
    E'    p_voorlopige_datum, (p_categorie = ''wettelijk''),\n' ||
    E'    case when p_verschuiving = ''terug'' then ''terug'' else ''vooruit'' end\n  )\n  on conflict');
  execute v_def;
end $patch$;

-- ------------------------------------------------------------
-- 4. ...en niemand verandert ze nadien
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text := E'  new.periode_eind := old.periode_eind;\n';
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'enforce_task_instance_transition';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0065: het anker van de bevroren kolommen past niet exact één keer.';
  end if;
  execute replace(v_def, v_anker,
    v_anker || E'  -- 0065: de richting is een beslissing van de motor bij het aanmaken.\n' ||
               E'  new.verschuiving := old.verschuiving;\n');
end $patch$;

-- ------------------------------------------------------------
-- 5. De feestdagentrigger: beide richtingen
-- ------------------------------------------------------------
create or replace function public.recalc_due_dates_after_holiday_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_new_due date;
  v_actor uuid;
  v_firm uuid;
  v_notitie text;
begin
  if tg_op = 'UPDATE' then
    if new.ingetrokken is not distinct from old.ingetrokken then
      return new;
    end if;
    v_actor := coalesce(new.ingetrokken_door, new.gewijzigd_door, new.aangemaakt_door);
    v_notitie := 'Herberekend n.a.v. ingetrokken feestdag ' || to_char(new.datum, 'DD/MM/YYYY');
  else
    v_actor := new.aangemaakt_door;
    v_notitie := 'Herberekend n.a.v. nieuwe feestdag ' || to_char(new.datum, 'DD/MM/YYYY');
  end if;

  select firm_id into v_firm from public.employees where id = v_actor;

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op,
           ti.review_vereist, ti.verschuiving
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    where ti.status = 'open'
      -- 0065: een week aan weerszijden van de wettelijke datum. Een feestdag
      -- raakt een vooruitschuivende taak als hij net na haar wettelijke datum
      -- valt, en een achteruitschuivende als hij er net vóór valt. Wat er niet
      -- door verandert, laat de vergelijking hieronder ongemoeid.
      and ti.due_date_wettelijk between new.datum - 7 and new.datum + 7
      and (v_firm is null or c.firm_id = v_firm)
  loop
    -- 0065: dezelfde regel als de motor, in de richting van de taak.
    v_new_due := public.werkdatum(r.due_date_wettelijk, r.verschuiving);
    if v_new_due is distinct from r.due_date then
      perform set_config('taskflow.pipeline_task_id', r.id::text, true);

      if r.due_date_handmatig_op is not null then
        -- M-1: afspraak laten staan, maar wel signaleren.
        if not r.review_vereist then
          update public.task_instances
          set review_vereist = true,
              review_reden = 'De wettelijke basisdatum verschoof (' || v_notitie ||
                             '), maar deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
          where id = r.id;
        end if;
      else
        update public.task_instances set due_date = v_new_due where id = r.id;

        insert into public.task_status_log (
          task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
        ) values (
          r.id, 'due_date_herberekend', r.due_date, v_new_due, v_actor, 'kalender_herberekening', v_notitie
        );
      end if;

      perform set_config('taskflow.pipeline_task_id', '', true);
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.recalc_due_dates_after_holiday_change() from public, anon, authenticated;
