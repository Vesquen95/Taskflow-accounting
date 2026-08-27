-- Taskflow v1 -- werkstromen: taken groeperen zoals het kantoor ze afwerkt.
--
-- Aanleiding: het kantoor. "Nu staan alle taken bij elkaar. Dit maakt het
-- onoverzichtelijk als ik één taak zou willen aanpakken, bv ik wil alle btw
-- aangiftes afwerken deze week." Het kantoor werkt per takenblok, niet per
-- klant -- bij ~100 dossiers levert één lijst met alles honderd regels op waar
-- je doorheen moet om bij het werk van vandaag te komen.
--
-- De indeling hoort in de catalogus, niet in de schermcode: één plek, en een
-- nieuw verplichtingstype valt vanzelf ergens in plaats van stilzwijgend
-- nergens. Zie docs/PLAN.md §10.
--
--   Btw                      btw_aangifte, btw_klantenlisting
--   Afsluiting               jaarafsluiting, algemene_vergadering,
--                            neerlegging_jaarrekening
--   Vennootschapsbelasting   va_venb, aangifte_venb_pb
--   Rapportering             rapportering
--
-- Rapportering staat bewust apart en niet bij Afsluiting: het is het enige type
-- met categorie `service`, zonder wettelijke deadline en zonder
-- goedkeuringsstap. Samenvoegen zou de emmer vervuilen waar het kantoor juist
-- op wil kunnen vertrouwen -- "deze week doe ik de afsluitingen" gaat niet over
-- kwartaalrapporteringen.
--
-- Ad-hoc taken hebben geen verplichtingstype en dus geen werkstroom; die vormen
-- in de app een vijfde ingang op basis van obligation_type_id is null. Een
-- enumwaarde die nooit voorkomt zou misleidend zijn.
--
-- obligation_types heeft alleen een SELECT-policy (geen INSERT/UPDATE), dus
-- deze kolom is voor iedereen alleen-lezen. Er komt geen beveiligingsvraag bij.
--
-- Additief: 0003-0021 zijn al toegepast en worden NIET gewijzigd.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'werkstroom') then
    create type public.werkstroom as enum (
      'btw', 'afsluiting', 'vennootschapsbelasting', 'rapportering'
    );
  end if;
end $$;

alter table public.obligation_types
  add column if not exists werkstroom public.werkstroom;

update public.obligation_types set werkstroom = 'btw'
  where code in ('btw_aangifte', 'btw_klantenlisting') and werkstroom is null;
update public.obligation_types set werkstroom = 'afsluiting'
  where code in ('jaarafsluiting', 'algemene_vergadering', 'neerlegging_jaarrekening')
    and werkstroom is null;
update public.obligation_types set werkstroom = 'vennootschapsbelasting'
  where code in ('va_venb', 'aangifte_venb_pb') and werkstroom is null;
update public.obligation_types set werkstroom = 'rapportering'
  where code = 'rapportering' and werkstroom is null;

-- Vanaf nu moet elk verplichtingstype een werkstroom hebben: een type zonder
-- stroom zou uit alle ingangen verdwijnen en dus onzichtbaar worden -- precies
-- het soort stille gat waar dit systeem niet tegen kan.
do $$
declare
  v_zonder int;
begin
  select count(*) into v_zonder from public.obligation_types where werkstroom is null;
  if v_zonder > 0 then
    raise exception
      '% verplichtingstype(s) zonder werkstroom; die zouden uit elke ingang verdwijnen.', v_zonder;
  end if;
end $$;

alter table public.obligation_types
  alter column werkstroom set not null;

comment on column public.obligation_types.werkstroom is
  'De werkstroom waarin het kantoor dit type afwerkt (docs/PLAN.md §10). Bepaalt in welke ingang de taken verschijnen. Ad-hoc taken hebben geen verplichtingstype en vormen een aparte ingang.';
