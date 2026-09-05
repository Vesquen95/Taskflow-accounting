-- ============================================================
-- 0054 — In vereffening, en vereffend: twee dingen, niet één
--
-- Het kantoor: "In vereffening en vereffend is nog iets anders. Een dossier
-- kan in vereffening staan voor meerdere jaren, maar een vereffening is
-- gedaan."
--
-- Dat is precies wat de wet ook zegt. Een vennootschap wordt na ontbinding
-- geacht voort te bestaan vóór haar vereffening (art. 2:76 WVV); de
-- rechtspersoonlijkheid verdwijnt pas bij de SLUITING van de vereffening. De
-- vereffenaar dient intussen gewoon elk jaar de aangifte in (art. 305, derde
-- lid in fine WIB 92) en legt elk jaar een jaarrekening neer bij de NBB, ten
-- laatste zeven maanden na het boekjaareinde (art. 2:99 WVV).
--
-- Vandaar twee datums en geen statusvlag:
--
--   ontbonden_op   de ontbinding. Vanaf hier staat het dossier IN VEREFFENING.
--                  Er verandert niets aan de taken -- alles loopt door. Hoe
--                  lang het duurt, weet niemand op dat moment, en dat hoeft
--                  ook niet: er hangt geen berekening aan.
--
--   vereffend_op   de sluiting. Vanaf hier bestaat de rechtspersoon niet meer
--                  en houdt alles op.
--
-- Een datum is hier beter dan een status, om twee redenen. Ze zegt wanneer,
-- en de status volgt er vanzelf uit; en ze kan niet uit de pas lopen met de
-- einddatum die de verplichtingen krijgen.
--
-- ------------------------------------------------------------
-- Waarom "vereffend" niet hetzelfde is als "gearchiveerd"
--
-- Archiveren betekent: we doen dit dossier niet meer, annuleer alles wat nog
-- openstaat (0026). Dat is hier fout. Bij de sluiting van de vereffening moet
-- de aangifte over het laatste boekjaar er nog staan -- die wordt maanden
-- later ingediend. Archiveren zou ze wegvegen.
--
-- Vereffend zetten doet daarom iets anders: het legt de einddatum van 0053 op
-- alle lopende verplichtingen. Wat over een periode tot en met de sluiting
-- gaat, blijft staan, inclusief het papierwerk dat later volgt. Wat over een
-- periode daarna gaat, verdwijnt. Archiveren kan daarna nog altijd, wanneer
-- het dossier echt afgewerkt is.
--
-- ------------------------------------------------------------
-- Wat hier NIET automatisch gebeurt: de aangifte speciaal
--
-- De ontbinding sluit het boekjaar (art. 2:70, tweede lid WVV). Valt ze niet
-- samen met de statutaire afsluitdatum, dan ontstaat er een verkort boekjaar
-- met een eigen jaarrekening en een aangifte "speciaal". Diezelfde
-- constructie herhaalt zich bij de sluiting.
--
-- Die aangiftes worden hier bewust niet gegenereerd, en dat is geen
-- nalatigheid: hun termijn is géén formule. Art. 310, tweede lid WIB 92 zegt
-- dat hij niet korter mag zijn dan één maand vanaf de goedkeuring van de
-- resultaten van de vereffening, en niet langer dan zes maanden vanaf de
-- laatste dag van het tijdperk. Het anker is dus een goedkeuringsdatum die
-- Taskflow niet kent en niet kán kennen. Een gegokte datum is hier erger dan
-- geen datum: het scherm zou een deadline tonen die nergens op slaat.
--
-- Het scherm zegt daarom bij het vereffend zetten met zoveel woorden dat die
-- aangifte er nog aan komt en met de hand toegevoegd moet worden.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De twee datums
-- ------------------------------------------------------------
alter table public.clients
  add column if not exists ontbonden_op date,
  add column if not exists vereffend_op date;

comment on column public.clients.ontbonden_op is
  'Datum van de ontbinding. Vanaf hier staat het dossier in vereffening; de verplichtingen '
  'lopen gewoon door (art. 2:76 WVV). Migratie 0054.';
comment on column public.clients.vereffend_op is
  'Datum van de sluiting van de vereffening. Vanaf hier bestaat de rechtspersoon niet meer '
  'en krijgen de lopende verplichtingen deze datum als einddatum (0053). Migratie 0054.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_vereffend_na_ontbinding'
  ) then
    alter table public.clients
      add constraint clients_vereffend_na_ontbinding check (
        -- Gesloten zonder ontbinding bestaat niet, en sluiten vóór de
        -- ontbinding evenmin. Allebei wijzen op een typfout, en een typfout in
        -- deze twee datums haalt de verplichtingen van het dossier onderuit.
        vereffend_op is null
        or (ontbonden_op is not null and vereffend_op >= ontbonden_op)
      );
  end if;
end $$;

-- Een ontbinding is een feit over het dossier en hoort in de historiek, net
-- als het btw-regime en het team. Zonder dit staat er over jaren niemand meer
-- die weet wanneer het begonnen is.
do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'block_unaudited_confidentiality_change';

  if v_def is null then
    raise exception '0054: block_unaudited_confidentiality_change() bestaat niet.';
  end if;
  if position('ontbonden_op' in v_def) > 0 then
    raise notice '0054: de vereffeningsdatums staan al in de audit.';
    return;
  end if;

  v_anker := '    ''team_id''' || E'\n' || '  ];';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0054: het anker van de auditlijst past niet exact één keer.';
  end if;

  v_def := replace(v_def, v_anker,
    '    ''team_id'',' || E'\n' ||
    '    -- 0054: wanneer een dossier ontbonden en wanneer het vereffend is,' || E'\n' ||
    '    -- bepaalt welke taken er nog bestaan. Dat hoort in de historiek.' || E'\n' ||
    '    ''ontbonden_op'', ''vereffend_op''' || E'\n' ||
    '  ];');

  execute v_def;
end
$patch$;

-- ------------------------------------------------------------
-- 2. De vereffening sluiten
--
-- Eén handeling, want het is één beslissing: de datum op het dossier én de
-- einddatum op elke lopende verplichting. Los van elkaar zetten zou een
-- dossier opleveren dat "vereffend" zegt en intussen taken blijft maken.
-- ------------------------------------------------------------
create or replace function public.klant_vereffend(p_client_id uuid, p_datum date)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_ontbonden date;
  v_aantal int;
begin
  if v_actor is null then
    raise exception 'Deze bewerking vereist een ingelogde, gekoppelde medewerker'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.can_access_client(p_client_id) then
    raise exception 'Geen toegang tot dit dossier'
      using errcode = 'insufficient_privilege';
  end if;

  select ontbonden_op into v_ontbonden from public.clients where id = p_client_id;
  if not found then
    raise exception 'Klant niet gevonden';
  end if;

  if p_datum is null then
    -- Terugdraaien: het dossier staat weer gewoon in vereffening en de
    -- verplichtingen lopen door. Alleen de einddatums die exact deze sluiting
    -- gezet heeft, gaan weg -- een einddatum die iemand zelf op een
    -- verplichting zette, is een aparte afspraak en blijft staan.
    update public.client_obligations co
    set geldig_tot = null
    where co.client_id = p_client_id
      and co.geldig_tot = (select vereffend_op from public.clients where id = p_client_id);

    update public.clients set vereffend_op = null where id = p_client_id;
    perform public.sync_client_tasks(p_client_id);
    return 0;
  end if;

  if v_ontbonden is null then
    raise exception
      'Dit dossier staat niet in vereffening. Zet eerst de datum van de ontbinding; een vereffening kan niet gesloten worden voor ze begonnen is.'
      using errcode = 'check_violation';
  end if;

  update public.clients set vereffend_op = p_datum where id = p_client_id;

  -- Alleen naar beneden: loopt een verplichting al tot een vroegere datum,
  -- dan is dat een aparte afspraak en die blijft gelden.
  update public.client_obligations co
  set geldig_tot = p_datum
  where co.client_id = p_client_id
    and co.actief
    and (co.geldig_tot is null or co.geldig_tot > p_datum);
  get diagnostics v_aantal = row_count;

  perform public.sync_client_tasks(p_client_id);
  return v_aantal;
end;
$$;

comment on function public.klant_vereffend(uuid, date) is
  'Sluit de vereffening: zet de sluitingsdatum op het dossier en legt die als einddatum op elke '
  'lopende verplichting (0053), zodat het papierwerk over de laatste periodes blijft staan en er '
  'niets meer bijkomt. Met null als datum wordt de sluiting teruggedraaid. Migratie 0054.';

revoke execute on function public.klant_vereffend(uuid, date) from public, anon;
grant execute on function public.klant_vereffend(uuid, date) to authenticated;
