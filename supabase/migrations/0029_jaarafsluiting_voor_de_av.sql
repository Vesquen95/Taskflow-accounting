-- ============================================================
-- 0029 — De jaarafsluiting kan ook vóór de algemene vergadering vallen
--
-- Tot nu rekende de jaarafsluiting altijd vanaf het boekjaareinde:
-- boekjaareinde + `sla_maanden` (standaard 3). Dat klopt voor kantoren die
-- een vaste doorlooptijd afspreken, maar niet voor de manier waarop het werk
-- echt geordend is: de boeken moeten klaar zijn *voor* de algemene
-- vergadering, want daar worden ze goedgekeurd.
--
-- Daarom een tweede manier van rekenen, gekozen per klant:
--
--   parameters.basis = 'boekjaar'  (of afwezig)  boekjaareinde + sla_maanden
--   parameters.basis = 'voor_av'                 AV-datum - maanden_voor_av
--
-- Afwezig = 'boekjaar': elk bestaand dossier houdt exact de deadline die het
-- vandaag heeft. Deze migratie verzet geen enkele bestaande taak.
--
-- De AV-datum wordt hier op precies dezelfde manier bepaald als in de AV-tak
-- zelf: av_datum() uit de statuten van dat dossier, en zonder ingevulde
-- statuten de wettelijke uiterste datum (boekjaareinde + 6 maanden). Ze twee
-- keer verschillend berekenen zou betekenen dat de jaarafsluiting stil naar
-- een andere vergadering wijst dan de AV-taak ernaast.
--
-- Een klant zonder AV-verplichting valt in diezelfde terugval. Dat is een
-- echte datum en geen verzinsel, maar het blijft een configuratiefout: wie
-- 'voor_av' kiest zonder AV heeft iets anders bedoeld.
--
-- Ondergrens: de deadline kan nooit vóór het boekjaareinde liggen. Je kunt de
-- boeken van een jaar niet afsluiten voor dat jaar voorbij is; een taak die
-- dat wel beweert leest als een fout in het systeem. Wie maanden_voor_av zo
-- groot zet dat het daar toch uitkomt, krijgt het boekjaareinde zelf.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De parameters afgrenzen
--
-- Zonder deze controle levert een typefout ('voor-av', 6 maanden voor een AV
-- die maar 1 maand na het boekjaareinde valt) een deadline op die er
-- plausibel uitziet en toch nergens op slaat.
-- ------------------------------------------------------------
create or replace function public.enforce_jaarafsluiting_parameters()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_code text;
  v_basis text;
  v_maanden int;
begin
  select code into v_code from public.obligation_types where id = new.obligation_type_id;
  if v_code is distinct from 'jaarafsluiting' then
    return new;
  end if;

  v_basis := coalesce(new.parameters->>'basis', 'boekjaar');
  if v_basis not in ('boekjaar', 'voor_av') then
    raise exception
      'Onbekende basis "%" voor de jaarafsluiting. Kies "boekjaar" (maanden na het boekjaareinde) of "voor_av" (maanden voor de algemene vergadering).',
      v_basis
      using errcode = 'check_violation';
  end if;

  if v_basis = 'voor_av' then
    v_maanden := nullif(new.parameters->>'maanden_voor_av', '')::int;
    if v_maanden is null or v_maanden < 1 or v_maanden > 6 then
      raise exception
        'Het aantal maanden voor de algemene vergadering moet tussen 1 en 6 liggen (gekregen: %). De AV valt zelf uiterlijk zes maanden na het boekjaareinde.',
        coalesce(new.parameters->>'maanden_voor_av', 'niets')
        using errcode = 'check_violation';
    end if;
  else
    v_maanden := nullif(new.parameters->>'sla_maanden', '')::int;
    if v_maanden is not null and (v_maanden < 1 or v_maanden > 12) then
      raise exception
        'De doorlooptijd van de jaarafsluiting moet tussen 1 en 12 maanden na het boekjaareinde liggen (gekregen: %).',
        new.parameters->>'sla_maanden'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_jaarafsluiting_parameters on public.client_obligations;
create trigger trg_jaarafsluiting_parameters
  before insert or update of parameters on public.client_obligations
  for each row execute function public.enforce_jaarafsluiting_parameters();

-- ------------------------------------------------------------
-- 2. De generator
--
-- Zelfde aanpak als in 0026 en 0028: de functie in de databank lezen en er
-- letterlijk in patchen, in plaats van 400 regels over te typen en daarbij
-- een eerdere correctie terug te draaien. Twee vervangingen — de declaraties
-- en de tak zelf — en allebei moeten ze exact één keer passen.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_aantal int;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if v_def is null then
    raise exception '0029: generate_task_instances_intern() bestaat niet.';
  end if;

  if position('v_jaarafsluiting_basis' in v_def) > 0 then
    raise notice '0029: de tak staat er al, generator ongewijzigd gelaten.';
    return;
  end if;

  -- 2a. De extra declaraties.
  v_anker := '  v_sla_maanden int;' || E'\n';
  v_aantal := (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker);
  if v_aantal <> 1 then
    raise exception '0029: declaratie-anker % keer gevonden, verwacht 1.', v_aantal;
  end if;
  v_def := replace(
    v_def,
    v_anker,
    '  v_sla_maanden int;' || E'\n' ||
    '  v_jaarafsluiting_basis text;' || E'\n' ||
    '  v_maanden_voor_av int;' || E'\n' ||
    '  v_av_parameters jsonb;' || E'\n' ||
    '  v_av_due date;' || E'\n'
  );

  -- 2b. Het begin van de tak: de parameters uitlezen en, bij 'voor_av', de
  --     statuten van de AV-verplichting van deze klant erbij halen. Eén keer
  --     per verplichting, niet per boekjaar.
  v_anker := '      v_sla_maanden := coalesce((r_co.parameters->>''sla_maanden'')::int, 3);' || E'\n';
  v_aantal := (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker);
  if v_aantal <> 1 then
    raise exception '0029: parameter-anker % keer gevonden, verwacht 1.', v_aantal;
  end if;
  v_def := replace(
    v_def,
    v_anker,
    '      v_sla_maanden := coalesce((r_co.parameters->>''sla_maanden'')::int, 3);' || E'\n' ||
    '      v_jaarafsluiting_basis := coalesce(r_co.parameters->>''basis'', ''boekjaar'');' || E'\n' ||
    '      v_maanden_voor_av := coalesce((r_co.parameters->>''maanden_voor_av'')::int, 1);' || E'\n' ||
    '      v_av_parameters := null;' || E'\n' ||
    '      if v_jaarafsluiting_basis = ''voor_av'' then' || E'\n' ||
    '        select co.parameters into v_av_parameters' || E'\n' ||
    '        from public.client_obligations co' || E'\n' ||
    '        join public.obligation_types ot on ot.id = co.obligation_type_id' || E'\n' ||
    '        where co.client_id = r_co.client_id' || E'\n' ||
    '          and ot.code = ''algemene_vergadering''' || E'\n' ||
    '          and co.actief' || E'\n' ||
    '        order by co.created_at desc' || E'\n' ||
    '        limit 1;' || E'\n' ||
    '      end if;' || E'\n'
  );

  -- 2c. De berekening zelf.
  v_anker := '        v_due_raw := (v_be + (v_sla_maanden || '' months'')::interval)::date;' || E'\n';
  v_aantal := (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker);
  if v_aantal <> 1 then
    raise exception '0029: berekening-anker % keer gevonden, verwacht 1.', v_aantal;
  end if;
  v_def := replace(
    v_def,
    v_anker,
    '        if v_jaarafsluiting_basis = ''voor_av'' then' || E'\n' ||
    '          v_av_due := coalesce(public.av_datum(v_be, v_av_parameters),' || E'\n' ||
    '                               (v_be + interval ''6 months'')::date);' || E'\n' ||
    '          v_due_raw := (v_av_due - (v_maanden_voor_av || '' months'')::interval)::date;' || E'\n' ||
    '          if v_due_raw < v_be then' || E'\n' ||
    '            v_due_raw := v_be;' || E'\n' ||
    '          end if;' || E'\n' ||
    '        else' || E'\n' ||
    '          v_due_raw := (v_be + (v_sla_maanden || '' months'')::interval)::date;' || E'\n' ||
    '        end if;' || E'\n'
  );

  execute v_def;

  if position('v_jaarafsluiting_basis' in (
    select pg_get_functiondef(oid) from pg_proc where proname = 'generate_task_instances_intern'
  )) = 0 then
    raise exception '0029: de tak staat na het patchen niet in de functie.';
  end if;
end;
$patch$;

revoke execute on function public.generate_task_instances_intern(uuid, integer, integer, uuid)
  from public, anon, authenticated;
