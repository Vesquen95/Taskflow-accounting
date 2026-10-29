-- 0075 — Een nieuwe kalenderdatum verzet ook de taken die al lopen
--
-- Gevraagd (29/10/2026), na het uitstel tot 16 november (0074): "ja schuif
-- de taken door". Tot nu toe verzette een correctie in de wettelijke
-- kalender (§3 punt 4) -- een override of een feestdag -- alleen taken met
-- status 'open'. Een taak die al in uitvoering was, bij de klant wachtte of
-- op goedkeuring stond, bleef op de oude datum staan. Bij een uitstel klopt
-- dat niet: de wettelijke datum is gewoon een andere, en wie aan de taak
-- werkt, hoort dat te zien. 0074 moest de taak van Febe Dedoncker daarom met
-- de hand rechtzetten.
--
-- De regel wordt: elke taak die nog niet afgesloten is (niet ingediend of
-- afgerond, niet geannuleerd). Wat niet verandert:
--   - een met de hand afgesproken deadline blijft staan, met een signaal
--     (M-1), zoals voorheen;
--   - elke verschuiving komt in de historiek van de taak.
--
-- Op hun plaats bijgewerkt, zoals in 0073: elk anker moet exact één keer
-- staan, anders weigert de migratie.

do $patch$
declare
  v_def text;
  v_functie text;
  v_anker constant text := 'ti.status = ''open''';
  v_nieuw constant text :=
    'ti.status not in (''ingediend_afgerond'', ''geannuleerd'') -- 0075: ook lopende taken';
begin
  foreach v_functie in array array['recalc_due_dates_on_legal_calendar_override', 'recalc_due_dates_after_holiday_change'] loop
    select pg_get_functiondef(oid) into v_def from pg_proc
    where proname = v_functie and pronamespace = 'public'::regnamespace;
    if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
      raise exception '0075: het anker past niet exact één keer in %().', v_functie;
    end if;
    execute replace(v_def, v_anker, v_nieuw);
  end loop;
end
$patch$;
