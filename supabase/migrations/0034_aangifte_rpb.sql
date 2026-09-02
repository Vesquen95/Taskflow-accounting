-- ============================================================
-- 0034 — De aangifte in de rechtspersonenbelasting
--
-- Het kantoor: "we moeten nog een extra deadline voorzien die specifiek geldt
-- voor de VZW. Namelijk de aangifte RPB."
--
-- Een VZW, IVZW of stichting valt onder de rechtspersonenbelasting in plaats
-- van de vennootschapsbelasting. Nooit onder allebei. De aangifte loopt over
-- Biztax en volgt exact dezelfde termijn als de VenB -- vandaar dat 0033 die
-- regel eerst in één functie zette: twee aangiftes met elk hun eigen kopie van
-- dezelfde regel lopen na de eerste correctie gegarandeerd uiteen.
--
-- Ook een VZW zonder belastbaar inkomen moet indienen, dus dit is een gewone
-- wettelijke verplichting en geen uitzondering.
--
-- Twee delen: het verplichtingstype met zijn tak in de motor, en een slot dat
-- weigert dat één dossier beide aangiftes draagt. Dat slot is de reden dat dit
-- meer is dan een regel in de catalogus: zonder controle staat er vroeg of
-- laat een dossier met twee aangiftes, en dat ziet er op het scherm volkomen
-- normaal uit.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Het verplichtingstype
--
-- Dezelfde eigenschappen als de VenB-aangifte: wettelijk, jaarlijks, en de
-- wettelijke kalender mag de berekening overschrijven met de campagnedatum
-- van dat jaar. Het staat in dezelfde werkstroom -- op het scherm heet die
-- voortaan "Belastingaangifte", want "Vennootschapsbelasting" klopt niet meer
-- zodra de RPB er ook in zit.
-- ------------------------------------------------------------
insert into public.obligation_types
  (code, naam, categorie, deadline_mechanisme, standaard_periodiciteit, werkstroom)
values
  ('aangifte_rpb', 'Aangifte RPB', 'wettelijk', 'jaarlijkse_kalender', 'jaarlijks', 'vennootschapsbelasting')
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 2. De motor: dezelfde tak, nu voor twee codes
--
-- De tak zoekt de campagnedatum op via r_co.obligation_type_id, dus de RPB
-- krijgt vanzelf haar eigen rijen in de wettelijke kalender. Er verandert
-- niets aan de VenB.
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
    raise exception '0034: generate_task_instances_intern() bestaat niet.';
  end if;

  if position('aangifte_rpb' in v_def) > 0 then
    raise notice '0034: de tak kent de RPB al.';
    return;
  end if;

  v_anker := '    elsif r_co.code = ''aangifte_venb_pb'' then' || E'\n';
  v_aantal := (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker);
  if v_aantal <> 1 then
    raise exception '0034: anker % keer gevonden, verwacht 1.', v_aantal;
  end if;

  v_def := replace(
    v_def,
    v_anker,
    '    elsif r_co.code in (''aangifte_venb_pb'', ''aangifte_rpb'') then' || E'\n'
  );
  execute v_def;

  if position('aangifte_rpb' in (
    select pg_get_functiondef(oid) from pg_proc where proname = 'generate_task_instances_intern'
  )) = 0 then
    raise exception '0034: de RPB staat na het patchen niet in de motor.';
  end if;
end;
$patch$;

revoke execute on function public.generate_task_instances_intern(uuid, integer, integer, uuid)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Het slot: één aangifte per dossier
--
-- Bewust een gewone (niet-uitgestelde) trigger. Het scherm zet eerst de
-- afgevinkte verplichtingen stop en pas daarna de aangevinkte aan
-- (src/lib/clientObligations.ts), zodat omschakelen van VenB naar RPB in één
-- opslagbeurt lukt. Zonder die volgorde zou de nieuwe aangifte aankomen
-- terwijl de oude nog loopt.
-- ------------------------------------------------------------
create or replace function public.enforce_een_aangifte_per_klant()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_code text;
  v_andere_code text;
  v_andere_naam text;
begin
  select code into v_code from public.obligation_types where id = new.obligation_type_id;
  if v_code is null or v_code not in ('aangifte_venb_pb', 'aangifte_rpb') then
    return new;
  end if;

  -- Een verplichting die stopgezet wordt of nog niet loopt, botst met niets.
  if not new.actief
     or new.geldig_vanaf > current_date
     or (new.geldig_tot is not null and new.geldig_tot < current_date) then
    return new;
  end if;

  v_andere_code := case when v_code = 'aangifte_rpb' then 'aangifte_venb_pb' else 'aangifte_rpb' end;

  select ot.naam into v_andere_naam
  from public.client_obligations co
  join public.obligation_types ot on ot.id = co.obligation_type_id
  where co.client_id = new.client_id
    and ot.code = v_andere_code
    and co.actief
    and co.geldig_vanaf <= current_date
    and (co.geldig_tot is null or co.geldig_tot >= current_date)
    and co.id is distinct from new.id
  limit 1;

  if v_andere_naam is not null then
    raise exception
      'Deze klant heeft al "%" lopen. Een dossier valt onder de vennootschapsbelasting óf onder de rechtspersonenbelasting, niet onder allebei. Vink de andere aangifte eerst af.',
      v_andere_naam
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_een_aangifte_per_klant()
  from public, anon, authenticated;

drop trigger if exists trg_client_obligations_een_aangifte on public.client_obligations;
create trigger trg_client_obligations_een_aangifte
  before insert or update on public.client_obligations
  for each row execute function public.enforce_een_aangifte_per_klant();
