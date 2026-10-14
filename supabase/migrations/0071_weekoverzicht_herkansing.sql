-- 0071 — De maandagmail krijgt herkansingen
--
-- Tot nu werd het weekoverzicht één keer geprobeerd: maandag 05:00 UTC. Lukte
-- dat niet (Gmail even onbereikbaar, een app-wachtwoord dat net vervangen
-- werd), dan kwam er die week geen maandagmail.
--
-- Nu elk uur van 05:00 tot 10:00 UTC (07:00-12:00 in de zomer, 06:00-11:00 in
-- de winter). Dubbel versturen kan niet: de Edge Function slaat iedereen over
-- die vandaag al een weekoverzicht kreeg (mail_verzonden, soort
-- 'weekoverzicht', sleutel = de datum). Na een geslaagde eerste ronde doen de
-- volgende rondes dus niets.

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('taskflow-weekoverzicht', '0 5-10 * * 1',
      $job$ select public.mail_wekker('weekoverzicht') $job$);
    raise notice '0071: weekoverzicht elke maandag elk uur van 05:00 tot 10:00 UTC';
  else
    raise notice '0071: pg_cron niet actief; niets ingepland.';
  end if;
end $cron$;
