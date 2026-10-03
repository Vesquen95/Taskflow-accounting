-- 0068 — De mailkaart toont ook wat de functie antwoordde
--
-- Gevonden bij het in gebruik nemen van 0067: zolang het Gmail-wachtwoord
-- niet ingesteld is, antwoordt de functie 503 en blijft alles in de wachtrij.
-- Dat is juist -- er gaat niets verloren -- maar het stond nergens. Wie op
-- "Stuur een testmail" klikte, zag alleen "1 bericht wacht", eindeloos.
--
-- pg_net bewaart de antwoorden een paar uur in net._http_response. Het
-- laatste antwoord van de mailfunctie komt nu mee in mail_status(). Via
-- to_regclass en dynamische SQL, zodat dit ook draait waar pg_net ontbreekt.

create or replace function public.mail_status()
returns jsonb
language plpgsql
stable security definer set search_path = public
as $$
declare
  v_antwoord jsonb;
begin
  if not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder ziet de mailinstellingen' using errcode = '42501';
  end if;

  if to_regclass('net._http_response') is not null then
    execute $q$
      select jsonb_build_object('status', r.status_code, 'op', r.created,
                                'inhoud', left(coalesce(r.content::text, r.error_msg, ''), 300))
      from net._http_response r
      order by r.created desc
      limit 1
    $q$ into v_antwoord;
  end if;

  return (
    select jsonb_build_object(
      'omleiden_naar', i.omleiden_naar,
      'meldingen_aan', i.meldingen_aan,
      'weekoverzicht_aan', i.weekoverzicht_aan,
      'ingesteld', i.functie_url is not null,
      'wachtend', (select count(*) from public.mail_meldingen where verzonden_op is null and pogingen < 5)
                + (select count(*) from public.systeemberichten where verzonden_op is null and pogingen < 5),
      'laatst_verzonden', (select max(verzonden_op) from public.mail_verzonden),
      'laatste_fout', (
        select laatste_fout from (
          select laatste_fout, gemaakt_op as op from public.mail_meldingen where laatste_fout is not null
          union all
          select laatste_fout, ontvangen_op from public.systeemberichten where laatste_fout is not null
        ) f order by op desc limit 1
      ),
      'laatste_antwoord', v_antwoord
    )
    from public.mail_instellingen i
  );
end;
$$;

revoke execute on function public.mail_status() from public, anon;
grant execute on function public.mail_status() to authenticated;
