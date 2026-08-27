-- Taskflow v1 -- de feestdagenkalender loopt niet meer achter op de horizon.
--
-- Aanleiding: nadat de generatiehorizon op 36 maanden kwam te staan, rekende de
-- motor tot 2029 terwijl public_holidays in 2027 ophield. Voorbij dat jaar
-- corrigeerde de verschuiving alleen nog op weekends, niet meer op feestdagen.
-- Zwart op wit in productie:
--
--   AV, boekjaareinde 30/06/2028:  wettelijk 30/12/2028 (zaterdag)
--                                  verschoven naar 01/01/2029  <- Nieuwjaar
--
-- Niets in het systeem merkte dat op. Dat is het echte probleem: niet dat er
-- jaren ontbraken, maar dat het ontbreken geruisloos was.
--
-- Deze migratie doet drie dingen:
--
--   1. pasen() en belgische_feestdagen() -- de tien wettelijke feestdagen
--      rekenkundig, in plaats van jaar per jaar overgetypt. Vier van de tien
--      hangen van Pasen af, en dat is precies waar overtypen misgaat.
--   2. laad_feestdagen() -- een kantoorbeheerder schuift de kalender vooruit
--      zonder dat er een migratie voor nodig is.
--   3. feestdagen_dekking() -- tot welk jaar de kalender loopt, zodat het
--      scherm kan waarschuwen voor de horizon eroverheen groeit.
--
-- Bewust GEEN harde blokkade op de generatie: die zou terecht zijn maar breekt
-- elke bestaande installatie waar de kalender toevallig kort is, midden in het
-- werk. De waarschuwing hoort op het beheerscherm, voor het misgaat.
--
-- public_holidays blijft append-only (0009/0011): deze functies voegen alleen
-- ontbrekende jaren toe en raken bestaande rijen niet aan. Wie een verkeerde
-- datum wil rechtzetten trekt ze in, zoals voorheen.
--
-- Additief: 0003-0022 zijn al toegepast en worden NIET gewijzigd.

-- ============================================================
-- 1. Pasen (anonieme gregoriaanse computus)
-- ============================================================
-- De vier bewegelijke Belgische feestdagen hangen alle van Pasen af. Dit
-- rekenen we uit in plaats van het over te typen: een tikfout in een lijst van
-- tien jaar is onzichtbaar tot er een deadline op de verkeerde dag valt.
create or replace function public.pasen(p_jaar int)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  a int; b int; c int; d int; e int; f int; g int;
  h int; i int; k int; l int; m int;
  v_maand int; v_dag int;
begin
  if p_jaar < 1583 or p_jaar > 4099 then
    raise exception 'pasen(): jaar % valt buiten het bereik van de gregoriaanse computus', p_jaar;
  end if;
  a := p_jaar % 19;
  b := p_jaar / 100;
  c := p_jaar % 100;
  d := b / 4;
  e := b % 4;
  f := (b + 8) / 25;
  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  i := c / 4;
  k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  v_maand := (h + l - 7 * m + 114) / 31;
  v_dag := ((h + l - 7 * m + 114) % 31) + 1;
  return make_date(p_jaar, v_maand, v_dag);
end $$;

comment on function public.pasen(int) is
  'Paaszondag volgens de anonieme gregoriaanse computus. Basis voor de vier bewegelijke Belgische feestdagen.';

-- ============================================================
-- 2. De tien wettelijke Belgische feestdagen van een jaar
-- ============================================================
-- Feestdagenwet van 4 januari 1974. Belgie verschuift een feestdag die op een
-- zondag valt NIET naar een vervangdag met wettelijke gevolgen voor termijnen:
-- de vervangdag is een zaak tussen werkgever en werknemer. Voor deadlines telt
-- de feestdag zelf, dus die geven we terug zoals hij valt.
create or replace function public.belgische_feestdagen(p_jaar int)
returns table (datum date, omschrijving text)
language sql
immutable
set search_path = public
as $$
  select d, o from (values
    (make_date(p_jaar, 1, 1),                     'Nieuwjaar'),
    (public.pasen(p_jaar) + 1,                    'Paasmaandag'),
    (make_date(p_jaar, 5, 1),                     'Dag van de Arbeid'),
    (public.pasen(p_jaar) + 39,                   'O.-L.-H. Hemelvaart'),
    (public.pasen(p_jaar) + 50,                   'Pinkstermaandag'),
    (make_date(p_jaar, 7, 21),                    'Nationale feestdag'),
    (make_date(p_jaar, 8, 15),                    'O.-L.-V. Hemelvaart'),
    (make_date(p_jaar, 11, 1),                    'Allerheiligen'),
    (make_date(p_jaar, 11, 11),                   'Wapenstilstand'),
    (make_date(p_jaar, 12, 25),                   'Kerstmis')
  ) as t(d, o)
  order by d;
$$;

comment on function public.belgische_feestdagen(int) is
  'De tien wettelijke feestdagen (wet van 4 januari 1974) voor een jaar, met de vier bewegelijke uit pasen().';

-- ============================================================
-- 3. Tot welk jaar loopt de kalender?
-- ============================================================
-- Een jaar telt pas als gedekt wanneer het volledig is: een enkele losse
-- feestdag in 2030 mag niet doorgaan voor "2030 is in orde".
create or replace function public.feestdagen_dekking()
returns int
language sql
stable
security definer set search_path = public
as $$
  select coalesce(max(jaar), 0) from (
    select jaar from public.public_holidays
     where not ingetrokken
     group by jaar
    having count(*) >= 10
  ) volledig;
$$;

comment on function public.feestdagen_dekking() is
  'Het laatste jaar waarvoor de feestdagenkalender volledig is. Onder de generatiehorizon verschuift de motor alleen nog op weekends.';

grant execute on function public.feestdagen_dekking() to authenticated;

-- ============================================================
-- 4. De kalender vooruitschuiven
-- ============================================================
-- Voorbehouden aan de kantoorbeheerder: dit verschuift deadlines van het hele
-- kantoor (de trigger uit 0004 herberekent bij elke insert), en dat is geen
-- dagelijks werk.
create or replace function public.laad_feestdagen(p_van int, p_tot int)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid;
  v_jaar int;
  v_toegevoegd int := 0;
  v_n int;
begin
  select e.id into v_actor
    from public.employees e
   where e.auth_user_id = auth.uid() and e.actief and e.rol = 'kantoorbeheerder';
  if v_actor is null then
    raise exception 'Alleen een kantoorbeheerder kan de feestdagenkalender vooruitschuiven.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_van > p_tot then
    raise exception 'laad_feestdagen(): % ligt na %', p_van, p_tot;
  end if;
  -- Een ruime maar eindige greep: zonder grens zou een tikfout duizenden
  -- rijen invoegen en evenveel keer de deadlineherberekening starten.
  if p_tot - p_van > 25 then
    raise exception 'laad_feestdagen(): % jaar in een keer is te veel (hoogstens 25).', p_tot - p_van + 1;
  end if;

  for v_jaar in p_van .. p_tot loop
    insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
    select v_jaar, f.datum, f.omschrijving, v_actor, v_actor
      from public.belgische_feestdagen(v_jaar) f
     where not exists (
       select 1 from public.public_holidays h where h.datum = f.datum
     );
    get diagnostics v_n = row_count;
    v_toegevoegd := v_toegevoegd + v_n;
  end loop;

  return v_toegevoegd;
end $$;

comment on function public.laad_feestdagen(int, int) is
  'Vult de ontbrekende feestdagen van de opgegeven jaren aan. Bestaande rijen blijven ongemoeid (append-only).';

revoke all on function public.laad_feestdagen(int, int) from public, anon;
grant execute on function public.laad_feestdagen(int, int) to authenticated;

-- ============================================================
-- 5. Nieuwe installaties beginnen met een ruime kalender
-- ============================================================
-- De oude versie had drie jaar overgetypt staan. Met een horizon van 36
-- maanden is dat vanaf dag een te kort.
create or replace function public.seed_default_public_holidays(p_actor uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_jaar int;
  v_start int := least(2025, extract(year from current_date)::int);
begin
  for v_jaar in v_start .. extract(year from current_date)::int + 6 loop
    insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
    select v_jaar, f.datum, f.omschrijving, p_actor, p_actor
      from public.belgische_feestdagen(v_jaar) f
     where not exists (
       select 1 from public.public_holidays h where h.datum = f.datum
     );
  end loop;
end $$;
