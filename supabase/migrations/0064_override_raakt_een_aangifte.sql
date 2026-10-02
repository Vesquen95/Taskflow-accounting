-- 0064 — Een override in de wettelijke kalender raakt één aangifte, niet twee
--
-- Gevonden op 02/10/2026, via een omweg: de testharnas met een verschoven klok
-- liet op 15/06/2028 een onderhoudsronde een taak opnieuw aanmaken die de
-- vorige ronde had gesnoeid. Die taak bleek een wettelijke datum te dragen die
-- een jaar te laat lag -- door een override die over een ánder boekjaar ging.
--
-- De oorzaak: twee stukken code lezen de kolom `jaar` van legal_calendar
-- verschillend.
--
--   de motor     zoekt `jaar = v_year`: het jaar waarin het boekjaar
--                afsluit (generate_task_instances_intern, sinds 0019);
--   deze trigger zocht `jaar = jaar(periode_eind) OR jaar = jaar(wettelijke
--                datum)`.
--
-- Die OR raakt twee aangiften tegelijk: die over boekjaar J (de periode
-- eindigt in J), en die over boekjaar J-1 (haar deadline valt in J). Een
-- campagnedatum van 15/10/2027 voor boekjaar 2026 verzette zo ook de aangifte
-- over 2025 -- wettelijk 30/09/2026 -- naar 15/10/2027. Een jaar te laat, en
-- een deadline die het kantoor dan gewoon zou missen. Test 27.3 keek alleen
-- naar het boekjaar dat ze bedoelde en zag de tweede treffer nooit.
--
-- Geen enkele lezing van `jaar` maakt het juist om twee aangiften te verzetten.
-- De trigger leest het nu zoals de motor: het jaar waarin het boekjaar
-- afsluit. Dan zijn ze het per definitie eens, en raakt een override precies
-- de taak die de motor er zelf mee zou aanmaken.
--
-- Let op voor wie een FOD-aankondiging intikt: de FOD publiceert per
-- AANSLAGjaar, en dat is het jaar ná het boekjaar. Voor aanslagjaar 2027 vul je
-- 2026 in. Het scherm zegt dat sinds deze migratie ook. Er stonden op
-- 02/10/2026 nog geen rijen in legal_calendar; er is dus niets verkeerd
-- verzet dat hersteld moet worden.

do $patch$
declare
  v_def text;
  v_anker text :=
    '      and (' || E'\n' ||
    '        extract(year from ti.periode_eind) = new.jaar' || E'\n' ||
    '        or extract(year from ti.due_date_wettelijk) = new.jaar' || E'\n' ||
    '      )' || E'\n';
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'recalc_due_dates_on_legal_calendar_override';

  if v_def is null then
    raise exception '0064: recalc_due_dates_on_legal_calendar_override() bestaat niet.';
  end if;
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0064: het anker van de jaarvoorwaarde past niet exact één keer.';
  end if;

  execute replace(v_def, v_anker,
    '      -- 0064: hetzelfde jaar als de motor -- het jaar waarin het boekjaar' || E'\n' ||
    '      -- afsluit. De OR met het jaar van de wettelijke datum raakte ook de' || E'\n' ||
    '      -- aangifte over het boekjaar ervoor.' || E'\n' ||
    '      and extract(year from ti.periode_eind) = new.jaar' || E'\n');
end $patch$;
