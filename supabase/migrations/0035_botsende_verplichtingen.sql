-- ============================================================
-- 0035 — Verplichtingen die niet samen kunnen
--
-- Twee correcties van het kantoor op 0034.
--
-- 1. De rechtsvorm zegt niets. Een VZW kan evengoed onderworpen zijn aan de
--    vennootschapsbelasting; welke aangifte geldt, hangt af van wat de
--    vereniging doet, niet van wat er in de statuten staat. De teksten die
--    "voor VZW's" zeiden zijn daarom aangepast. Het slot zelf blijft: een
--    dossier valt onder de ene aangifte óf onder de andere, nooit onder
--    allebei tegelijk.
--
-- 2. "Als je RPB aanduidt is het beter om geen VA's aan te bieden."
--    De voorafbetalingen VA1-VA4 horen bij de vennootschapsbelasting. Staat
--    een dossier in de rechtspersonenbelasting, dan hoort daar geen
--    voorafbetaling bij, en dus ook geen taak die er elk kwartaal aan komt
--    herinneren.
--
-- Daarom één controle voor alle botsende paren in plaats van een aparte per
-- geval: komt er later nog een combinatie bij, dan staat ze op één plek en
-- niet verspreid over drie triggers die elkaar niet kennen.
-- ============================================================

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
begin
  select code, naam into v_code, v_deze_naam
  from public.obligation_types where id = new.obligation_type_id;

  -- De paren die niet samen kunnen. Beide richtingen staan er expliciet in:
  -- welke van de twee je aanvinkt, de botsing is dezelfde.
  v_botst := case v_code
    when 'aangifte_venb_pb' then array['aangifte_rpb']
    when 'aangifte_rpb'     then array['aangifte_venb_pb', 'va_venb']
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
    else 'Een dossier valt onder de vennootschapsbelasting óf onder de rechtspersonenbelasting, niet onder allebei.'
  end;

  raise exception '"%" gaat niet samen met "%", en die loopt al voor deze klant. % Vink de andere eerst af.',
    v_deze_naam, v_andere_naam, v_reden
    using errcode = 'check_violation';
end;
$$;

revoke execute on function public.enforce_botsende_verplichtingen()
  from public, anon, authenticated;

-- De oude, smallere controle uit 0034 gaat weg: ze zit nu in bovenstaande.
drop trigger if exists trg_client_obligations_een_aangifte on public.client_obligations;
drop function if exists public.enforce_een_aangifte_per_klant();

drop trigger if exists trg_client_obligations_botsende_verplichtingen on public.client_obligations;
create trigger trg_client_obligations_botsende_verplichtingen
  before insert or update on public.client_obligations
  for each row execute function public.enforce_botsende_verplichtingen();
