-- ============================================================
-- 0041 — Natuurlijke personen en de aangifte personenbelasting
--
-- "Aangifte VenB / PB" werd in 0028 herleid tot enkel VenB, met de belofte dat
-- de personenbelasting een eigen type zou krijgen. Dit is dat type -- en het
-- kan pas bestaan zodra een natuurlijke persoon een eigen dossier kan zijn.
--
-- ------------------------------------------------------------
-- Waarom een natuurlijke persoon een eigen dossier is
--
-- De verleiding is om de PB-aangifte van de zaakvoerder aan het dossier van
-- zijn vennootschap te hangen. Dat breekt meteen: een BV met twee zaakvoerders
-- heeft twee aangiftes, elk met een eigen deadline, een eigen verantwoordelijke
-- en een eigen ereloon. En een particuliere klant zonder vennootschap zou dan
-- helemaal niet kunnen bestaan.
--
-- De breuklijn ligt trouwens niet waar je ze verwacht. Een EENMANSZAAK ís al
-- een natuurlijke persoon: die heeft btw, een ondernemingsnummer en fiches,
-- maar geen algemene vergadering en geen vennootschapsbelasting. Het
-- onderscheid is dus natuurlijk persoon versus rechtspersoon, niet "privé
-- versus zaak".
--
-- ------------------------------------------------------------
-- De termijn
--
-- Sinds de hervorming van 2023 bestaat het aparte uitstel voor mandatarissen
-- niet meer. De termijn hangt af van de AANGIFTE zelf:
--
--   complex    winsten of baten, bedrijfsleidersbezoldiging, bezoldiging van
--              de meewerkende echtgenoot, of buitenlands beroepsinkomen
--              -> 16 oktober, wettelijk verankerd
--   eenvoudig  -> 15 juli (Tax-on-web); op papier 30 juni, maar een
--              boekhoudkantoor dient niet op papier in
--
-- Bij een boekhoudkantoor is vrijwel elk PB-dossier complex, dus dat is de
-- standaard. "Eenvoudig" is de bewuste afwijking per dossier.
--
-- De wettelijke kalender blijft een OVERRIDE en geen voorwaarde: wijkt de FOD
-- voor een aanslagjaar af, dan wint die datum; staat er niets, dan rekent de
-- motor zelf en verdwijnt er geen taak. Dat is dezelfde keuze als bij de VenB
-- (0019), en om dezelfde reden: een lege tabel mag geen deadlines opeten.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Soort dossier
--
-- Nullable noch vrij: twee waarden, en bestaande dossiers zijn per definitie
-- rechtspersonen -- er was tot nu niets anders mogelijk.
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'klantsoort') then
    create type public.klantsoort as enum ('rechtspersoon', 'natuurlijk_persoon');
  end if;
end $$;

alter table public.clients
  add column if not exists klantsoort public.klantsoort not null default 'rechtspersoon';

comment on column public.clients.klantsoort is
  'Rechtspersoon (vennootschap, vzw, stichting) of natuurlijke persoon (eenmanszaak, vrij beroep, bedrijfsleider, particulier). Bepaalt welke verplichtingen het scherm aanbiedt: een natuurlijke persoon heeft geen algemene vergadering en geen neerlegging, maar wel een aangifte personenbelasting. Btw blijft bij allebei mogelijk -- een eenmanszaak is een natuurlijke persoon mét btw.';

create index if not exists clients_klantsoort_idx on public.clients (klantsoort);

-- ------------------------------------------------------------
-- 2. Het verplichtingstype
--
-- 'jaarlijkse_kalender' en niet 'formule': de datum staat in de wet en de FOD
-- kan er per aanslagjaar van afwijken. Dat is precies wat legal_calendar is.
-- ------------------------------------------------------------
insert into public.obligation_types
  (code, naam, categorie, deadline_mechanisme, standaard_periodiciteit, werkstroom)
values
  ('aangifte_pb', 'Aangifte personenbelasting', 'wettelijk', 'jaarlijkse_kalender', 'jaarlijks', 'vennootschapsbelasting')
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 3. De motor
--
-- Zelfde aanpak als 0028/0029/0036: de functie lezen zoals ze in de databank
-- staat en er letterlijk in patchen. Ze overtypen zou een eerdere correctie
-- kunnen terugdraaien.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_nieuw text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if v_def is null then
    raise exception '0041: generate_task_instances_intern() bestaat niet.';
  end if;

  if position('aangifte_pb' in v_def) > 0 then
    raise notice '0041: de PB-tak staat er al, generator ongewijzigd gelaten.';
    return;
  end if;

  v_anker := '    elsif r_co.code in (''fiche_281_20'', ''fiche_281_45'', ''fiche_281_50'') then';

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0041: het anker van de fiche-tak past niet exact één keer.';
  end if;

  v_nieuw :=
    '    elsif r_co.code = ''aangifte_pb'' then' || E'\n' ||
    '      -- Per inkomstenjaar (kalenderjaar): de personenbelasting kent geen' || E'\n' ||
    '      -- boekjaar. Complexe aangifte (winsten of baten,' || E'\n' ||
    '      -- bedrijfsleidersbezoldiging, buitenlands beroepsinkomen) -> 16' || E'\n' ||
    '      -- oktober; eenvoudige aangifte -> 15 juli. Sinds 2023 is er geen' || E'\n' ||
    '      -- apart uitstel meer voor mandatarissen.' || E'\n' ||
    '      for v_year in' || E'\n' ||
    '        extract(year from v_gen_from)::int .. extract(year from v_window_end)::int' || E'\n' ||
    '      loop' || E'\n' ||
    '        if coalesce(r_co.parameters->>''aangifte_vorm'', ''complex'') = ''eenvoudig'' then' || E'\n' ||
    '          v_due_raw := make_date(v_year + 1, 7, 15);' || E'\n' ||
    '        else' || E'\n' ||
    '          v_due_raw := make_date(v_year + 1, 10, 16);' || E'\n' ||
    '        end if;' || E'\n' ||
    '' || E'\n' ||
    '        -- Override, geen voorwaarde: staat er niets in de wettelijke' || E'\n' ||
    '        -- kalender, dan blijft de eigen berekening staan.' || E'\n' ||
    '        select deadline_datum into v_lc_date' || E'\n' ||
    '        from public.legal_calendar' || E'\n' ||
    '        where obligation_type_id = r_co.obligation_type_id' || E'\n' ||
    '          and jaar = v_year' || E'\n' ||
    '          and (scope = ''vorm_'' || coalesce(r_co.parameters->>''aangifte_vorm'', ''complex'') or scope is null)' || E'\n' ||
    '        order by is_override desc, updated_at desc' || E'\n' ||
    '        limit 1;' || E'\n' ||
    '        if v_lc_date is not null then' || E'\n' ||
    '          v_due_raw := v_lc_date;' || E'\n' ||
    '        end if;' || E'\n' ||
    '' || E'\n' ||
    '        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;' || E'\n' ||
    '        v_new_id := public.upsert_generated_task(' || E'\n' ||
    '          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,' || E'\n' ||
    '          v_year::text, make_date(v_year, 1, 1), make_date(v_year, 12, 31),' || E'\n' ||
    '          v_due_raw, v_default_employee, r_co.categorie' || E'\n' ||
    '        );' || E'\n' ||
    '      end loop;' || E'\n' ||
    '' || E'\n' ||
    v_anker;

  v_def := replace(v_def, v_anker, v_nieuw);
  execute v_def;
end $patch$;

-- ------------------------------------------------------------
-- 4. De wettelijke kalender moet de PB-taken wél kunnen bereiken
--
-- Dit stond er bijna stil naast. `legal_calendar.scope` heeft twee betekenissen
-- naast elkaar: 'boekjaar_<maand>' duidt een COHORT klanten aan, en elke andere
-- waarde werd als een fragment van het periodelabel behandeld. Mijn PB-taken
-- dragen '2026' als label, dus een campagnedatum met scope 'complex' raakte
-- ze nooit -- geen fout, geen melding, gewoon een override die niets deed.
-- (Exact dezelfde val als in 0025, waar 'boekjaar_12' om die reden nooit
-- matchte; het commentaar in de functie waarschuwt er zelfs voor.)
--
-- Daarom een derde vorm die net als 'boekjaar_<maand>' een cohort aanduidt:
-- 'vorm_complex' en 'vorm_eenvoudig', getoetst aan de parameter van de
-- verplichting zelf.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_nieuw text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'recalc_due_dates_on_legal_calendar_override';

  if v_def is null then
    raise exception '0041: recalc_due_dates_on_legal_calendar_override() bestaat niet.';
  end if;

  if position('vorm_' in v_def) > 0 then
    raise notice '0041: de vorm-scope staat er al.';
    return;
  end if;

  v_anker :=
    '        or (new.scope !~ ''^boekjaar_[0-9]+$''' || E'\n' ||
    '            and ti.periode_label ilike ''%'' || new.scope || ''%'')';

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0041: het anker van de scope-vergelijking past niet exact één keer.';
  end if;

  v_nieuw :=
    '        -- ''vorm_<complex|eenvoudig>'' duidt, net als ''boekjaar_<maand>'',' || E'\n' ||
    '        -- een cohort dossiers aan en geen stuk periodelabel: het staat in' || E'\n' ||
    '        -- de parameters van de verplichting.' || E'\n' ||
    '        or (new.scope ~ ''^vorm_''' || E'\n' ||
    '            and exists (' || E'\n' ||
    '              select 1 from public.client_obligations co' || E'\n' ||
    '              where co.id = ti.client_obligation_id' || E'\n' ||
    '                and ''vorm_'' || coalesce(co.parameters->>''aangifte_vorm'', ''complex'') = new.scope' || E'\n' ||
    '            ))' || E'\n' ||
    '        or (new.scope !~ ''^boekjaar_[0-9]+$'' and new.scope !~ ''^vorm_''' || E'\n' ||
    '            and ti.periode_label ilike ''%'' || new.scope || ''%'')';

  v_def := replace(v_def, v_anker, v_nieuw);
  execute v_def;
end $patch$;

-- ------------------------------------------------------------
-- 5. Wat niet samen kan
--
-- Een dossier valt onder de vennootschapsbelasting, de rechtspersonenbelasting
-- óf de personenbelasting. Nooit onder twee.
-- ------------------------------------------------------------
create or replace function public.enforce_botsende_verplichtingen()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_code text;
  v_botst text[];
  v_andere_code text;
  v_andere_naam text;
  v_deze_naam text;
  v_reden text;
  v_regime public.btw_regime;
begin
  select code, naam into v_code, v_deze_naam
  from public.obligation_types where id = new.obligation_type_id;

  -- De bijzondere btw-aangifte bestaat juist voor wie GEEN periodieke aangifte
  -- indient (0036). Dat is geen botsing tussen twee verplichtingen maar een
  -- voorwaarde op het btw-regime, dus staat ze apart.
  if v_code = 'btw_bijzondere_aangifte' and new.actief then
    select btw_regime into v_regime from public.clients where id = new.client_id;
    if v_regime = 'periodieke_aangever' then
      raise exception
        'De bijzondere btw-aangifte bestaat voor wie géén periodieke btw-aangifte indient. Deze klant is periodieke aangever.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- De paren die niet samen kunnen. Beide richtingen staan er expliciet in:
  -- welke van de twee je aanvinkt, de botsing is dezelfde.
  v_botst := case v_code
    when 'aangifte_venb_pb' then array['aangifte_rpb', 'aangifte_pb']
    when 'aangifte_rpb'     then array['aangifte_venb_pb', 'aangifte_pb', 'va_venb']
    when 'aangifte_pb'      then array['aangifte_venb_pb', 'aangifte_rpb']
    when 'va_venb'          then array['aangifte_rpb']
    else null
  end;
  if v_botst is null then
    return new;
  end if;

  -- Een verplichting die stopgezet wordt of nog niet loopt, botst met niets.
  if not new.actief
     or new.geldig_vanaf > current_date
     or (new.geldig_tot is not null and new.geldig_tot < current_date) then
    return new;
  end if;

  select ot.code, ot.naam into v_andere_code, v_andere_naam
  from public.client_obligations co
  join public.obligation_types ot on ot.id = co.obligation_type_id
  where co.client_id = new.client_id
    and ot.code = any(v_botst)
    and co.actief
    and co.geldig_vanaf <= current_date
    and (co.geldig_tot is null or co.geldig_tot >= current_date)
    and co.id is distinct from new.id
  limit 1;

  if v_andere_naam is null then
    return new;
  end if;

  v_reden := case
    when 'va_venb' in (v_code, v_andere_code)
      then 'Voorafbetalingen horen bij de vennootschapsbelasting; in de rechtspersonenbelasting bestaan ze niet.'
    when 'aangifte_pb' in (v_code, v_andere_code)
      then 'De personenbelasting geldt voor een natuurlijke persoon; een rechtspersoon valt onder de vennootschaps- of de rechtspersonenbelasting.'
    else 'Een dossier valt onder de vennootschapsbelasting óf onder de rechtspersonenbelasting, niet onder allebei.'
  end;

  raise exception '"%" gaat niet samen met "%", en die loopt al voor deze klant. % Vink de andere eerst af.',
    v_deze_naam, v_andere_naam, v_reden
    using errcode = 'check_violation';
end;
$$;

revoke execute on function public.enforce_botsende_verplichtingen() from public, anon, authenticated;
