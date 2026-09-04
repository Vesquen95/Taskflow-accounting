-- ============================================================
-- 0047 — Hoelang wacht dit dossier al op de klant?
--
-- "Wacht op klant" is de enige status waarin het kantoor zelf niets kan
-- doen: de bal ligt bij de klant. Precies daarom is het de status waarin
-- werk het langst blijft liggen -- er gebeurt niets, dus niemand kijkt.
--
-- Op de testomgeving staan er zevenentwintig taken in. Op het scherm zien ze
-- er alle zevenentwintig identiek uit: een paars bolletje "Wacht op klant".
-- Een dossier dat sinds eergisteren op één ontbrekend rekeninguittreksel
-- wacht, en een dossier dat sinds maart op de jaarrekening van een
-- dochtervennootschap wacht, zijn dezelfde regel. Terwijl het ene "even
-- geduld" is en het andere "hier moet je bellen".
--
-- ------------------------------------------------------------
-- Waarom een kolom en niet een berekening uit het logboek
--
-- Het antwoord staat al in `task_status_log`: de laatste regel met
-- `nieuw_status = 'wacht_op_klant'` is het moment waarop het wachten begon.
-- Voor alle zevenentwintig taken staat dat spoor er ook echt.
--
-- Toch een kolom, om twee redenen. De takenlijst haalt honderden rijen op en
-- zou er een lateral join per rij bij krijgen, door PostgREST heen, alleen om
-- één datum te tonen. En de statusmachine houdt al drie zulke stempels bij
-- (`afgerond_op`, `goedgekeurd_op`, `goedgekeurd_door`) volgens exact dit
-- patroon: de trigger is er eigenaar van, niemand anders mag ze zetten. Een
-- vierde stempel in dezelfde stijl is te lezen; een uitzondering niet.
--
-- ------------------------------------------------------------
-- Wat de kolom betekent
--
-- Gevuld = deze taak wacht nu op de klant, sinds dat moment.
-- Leeg    = deze taak wacht niet op de klant.
--
-- Ze wordt dus gewist zodra de taak de status verlaat, en opnieuw gezet als
-- ze er later weer in komt. Dat is met opzet: het gaat om de HUIDIGE wachttijd,
-- niet om de som van alle keren. Wie de volledige geschiedenis wil, vindt ze
-- in het logboek -- dat blijft de bron.
-- ============================================================

alter table public.task_instances
  add column if not exists wacht_op_klant_sinds timestamptz;

comment on column public.task_instances.wacht_op_klant_sinds is
  'Sinds wanneer deze taak op de klant wacht. Gezet door enforce_task_instance_transition() bij het binnengaan van de status en gewist bij het verlaten ervan; niemand anders schrijft ze. Leeg = wacht niet op de klant. Enkel de huidige wachtbeurt -- de volledige geschiedenis staat in task_status_log.';

-- ------------------------------------------------------------
-- De taken die nu al wachten
--
-- Zonder terugvulling zou elke wachtende taak vanaf vandaag tellen, en dan
-- ziet een dossier dat al maanden ligt er splinternieuw uit -- precies de
-- verkeerde kant op liegen. Het logboek weet het wel, dus halen we het
-- daaruit.
--
-- Dit blok staat VOOR de trigger hieronder, en dat is geen stijlkeuze: zodra
-- de trigger de kolom in bezit neemt, wist ze elke waarde die een gewone
-- UPDATE erin zet. Precies wat sectie 51.5 bewijst -- en wat deze
-- terugvulling stil op nul hield toen ze er nog achter stond.
-- ------------------------------------------------------------
update public.task_instances ti
   set wacht_op_klant_sinds = l.created_at
  from (
    select distinct on (task_instance_id) task_instance_id, created_at
    from public.task_status_log
    where nieuw_status = 'wacht_op_klant'
    order by task_instance_id, created_at desc
  ) l
 where l.task_instance_id = ti.id
   and ti.status = 'wacht_op_klant'
   and ti.wacht_op_klant_sinds is null;

-- ------------------------------------------------------------
-- De statusmachine
--
-- Zelfde aanpak als 0028/0029/0036/0041/0046: de functie lezen zoals ze in de
-- databank staat en er letterlijk in patchen.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_nieuw text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'enforce_task_instance_transition';

  if v_def is null then
    raise exception '0047: enforce_task_instance_transition() bestaat niet.';
  end if;

  if position('wacht_op_klant_sinds' in v_def) > 0 then
    raise notice '0047: de stempel staat er al, trigger ongewijzigd gelaten.';
    return;
  end if;

  -- (a) De stempel is eigendom van deze trigger, net als de drie andere.
  --     Zonder deze regel kan een medewerker de wachttijd zelf terugzetten
  --     en ziet een dossier er jonger uit dan het is.
  v_anker := '  new.afgerond_op := old.afgerond_op;';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0047: het anker van de stempels past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker,
    v_anker || E'\n' || '  new.wacht_op_klant_sinds := old.wacht_op_klant_sinds;');

  -- (b) Zetten bij het binnengaan, wissen bij het verlaten. Dit blok draait
  --     alleen bij een échte statuswijziging, dus "binnengaan" is hier ook
  --     werkelijk binnengaan en geen herbevestiging.
  v_anker :=
    '    if new.status = ''ingediend_afgerond'' then' || E'\n' ||
    '      new.afgerond_op := now();' || E'\n' ||
    '    end if;';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0047: het anker van afgerond_op past niet exact één keer.';
  end if;
  v_nieuw := v_anker || E'\n' || E'\n' ||
    '    -- 0047: hoelang wacht dit dossier al op de klant? Wissen bij het' || E'\n' ||
    '    -- verlaten, zodat de kolom altijd over de HUIDIGE wachtbeurt gaat.' || E'\n' ||
    '    if new.status = ''wacht_op_klant'' then' || E'\n' ||
    '      new.wacht_op_klant_sinds := now();' || E'\n' ||
    '    else' || E'\n' ||
    '      new.wacht_op_klant_sinds := null;' || E'\n' ||
    '    end if;';
  v_def := replace(v_def, v_anker, v_nieuw);

  execute v_def;
end
$patch$;
