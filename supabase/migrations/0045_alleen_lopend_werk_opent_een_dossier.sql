-- ============================================================
-- 0045 — Alleen lopend werk opent een dossier, en het team weghalen is een
--        beheerdersbeslissing
--
-- Twee besluiten van het kantoor na de review van de teammuur (0039).
--
-- ------------------------------------------------------------
-- 1. Afgewerkt werk geeft geen toegang meer
--
-- De muur kent een uitzondering: je ziet een dossier van een ander team --
-- en een vertrouwelijk dossier -- zodra er een taak van jou op staat. Die
-- uitzondering keek naar `status <> 'geannuleerd'`, en telde dus ook werk dat
-- al ingediend en afgerond was. Een taak van drie jaar geleden hield een
-- dossier dus voorgoed open.
--
-- Dat was geen theorie. Op de testomgeving zag één medewerker 31 dossiers,
-- waarvan er 13 alleen nog openstonden door werk dat al af was -- en één
-- daarvan was als vertrouwelijk gemarkeerd.
--
-- Vanaf nu telt alleen lopend werk. De cijfers van diezelfde omgeving:
--
--     Testgebruiker    31 -> 18
--     Karel De Smet    47 -> 38
--     Nathalie Claes   30 -> 21
--     Tom Verhoeven    29 -> 21
--     Leen Maes        41 -> 35
--
-- Dat is de bedoeling, en het is meteen de prijs: wie zijn laatste taak op
-- een dossier van een ander team afwerkt, ziet dat dossier daarna niet meer.
-- Bij vaste dossierverdeling gebeurt dat zelden -- het team dekt je eigen
-- dossiers al -- maar het kán, en dan is de weg terug: het team van het
-- dossier, of een nieuwe taak.
--
-- ------------------------------------------------------------
-- Wat NIET verandert: je eigen taak blijft van jou
--
-- `can_access_task_row` houdt zijn eigen, ruimere uitzondering: een taak die
-- op jouw naam staat, blijf je zien, ook als ze af is. Dat is geen
-- vergetelheid maar de tegenhanger van de regel hierboven: het dossier gaat
-- dicht, je eigen werk blijft van jou. Het is bovendien wat je in staat stelt
-- om je laatste taak op zo'n dossier nog af te werken -- de handeling die je
-- toegang tot het dossier zelf beëindigt.
--
-- ------------------------------------------------------------
-- 2. Het team weghalen mag alleen een kantoorbeheerder
--
-- Verhuizen van team A naar team B blijft dagelijks werk: een klant verandert
-- van beheerder, en dan verhuist het dossier mee. Maar het team helemaal
-- weghalen is iets anders -- dan ziet het hele kantoor het dossier. Dat is
-- dezelfde soort beslissing als de vertrouwelijkheidsvlag, en die was al
-- voorbehouden.
--
-- Bij het schrijven hiervan bleek de omheining al steviger dan gedacht: een
-- medewerker kan een dossier sowieso niet naar een team duwen waar hij zelf
-- niet in zit. Niet door een aparte controle, maar door de policy zelf -- het
-- gewijzigde dossier zou buiten zijn eigen bereik vallen, en dat weigert RLS.
-- Verhuizen kan dus alleen tussen teams waar je zelf lid van bent, en dat is
-- precies de bedoeling. Sectie 49.9 legt dat vast, want het stond nergens
-- opgeschreven en het is dragend.
--
-- Wat overbleef was dus één gat: het team leegmaken. `null` glipt langs de
-- muur omdat een dossier zonder team voor iedereen zichtbaar hoort te zijn.
-- Dat is wat deze migratie sluit.
--
-- Een dossier ZONDER team aanmaken blijft wel toegestaan: dat is een nieuw
-- dossier dat je zelf aanbrengt, geen bestaand dossier dat je openzet.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De muur
-- ------------------------------------------------------------
create or replace function public.mag_klant_zien(
  p_client_id uuid,
  p_vertrouwelijk boolean,
  p_team_id uuid,
  p_employee_id uuid
)
returns boolean
language sql
stable security definer set search_path = public
as $$
  select
    e.actief
    and (
      not p_vertrouwelijk
      or e.rol = 'kantoorbeheerder'
      or exists (
        select 1 from public.task_instances ti
        where ti.client_id = p_client_id
          and ti.toegewezen_medewerker_id = p_employee_id
          -- 0045: afgerond werk telt niet meer mee. Zie de kop.
          and ti.status not in ('geannuleerd', 'ingediend_afgerond')
      )
    )
    and (
      p_team_id is null
      or e.rol = 'kantoorbeheerder'
      or exists (
        select 1 from public.employee_teams et
        where et.employee_id = p_employee_id
          and et.team_id = p_team_id
      )
      or exists (
        select 1 from public.task_instances ti
        where ti.client_id = p_client_id
          and ti.toegewezen_medewerker_id = p_employee_id
          and ti.status not in ('geannuleerd', 'ingediend_afgerond')
      )
    )
  from public.employees e
  where e.id = p_employee_id;
$$;

comment on function public.mag_klant_zien(uuid, boolean, uuid, uuid) is
  'Mag deze medewerker dit dossier zien? Rijgebaseerd, zodat de policy op clients ze kan aanroepen zonder de INSERT ... RETURNING-val van 0010. Een dossier gaat open via het team, via de rol kantoorbeheerder, of via LOPEND werk dat op jouw naam staat (sinds 0045 telt afgerond werk niet meer mee).';

revoke execute on function public.mag_klant_zien(uuid, boolean, uuid, uuid) from public, anon;
grant execute on function public.mag_klant_zien(uuid, boolean, uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. Het team weghalen
-- ------------------------------------------------------------
do $patch$
declare
  def text := pg_get_functiondef('public.block_unaudited_confidentiality_change()'::regprocedure);
  -- Twee regels lang, want de eerste regel alleen komt ook voor in het blok
  -- dat de wijziging wegschrijft.
  anker constant text := $a$  if new.vertrouwelijk is distinct from old.vertrouwelijk
     or new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id then$a$;
  vervanging constant text := $a$  -- 0045: het team weghalen zet het dossier open voor het hele kantoor. Dat
  -- is dezelfde soort beslissing als de vertrouwelijkheidsvlag, en dus even
  -- voorbehouden. Verhuizen naar een ANDER team blijft gewoon werk: dan
  -- verandert alleen wie het dossier volgt, niet hoeveel mensen het zien.
  if old.team_id is not null and new.team_id is null and not public.is_kantoorbeheerder() then
    raise exception
      'Enkel een kantoorbeheerder kan het team van een dossier weghalen. Zonder team is het dossier voor het hele kantoor zichtbaar. Verhuizen naar een ander team mag wel.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.vertrouwelijk is distinct from old.vertrouwelijk
     or new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id then$a$;
begin
  if (length(def) - length(replace(def, anker, ''))) / length(anker) <> 1 then
    raise exception '0045: het ankerpunt komt % keer voor in plaats van 1 keer',
      (length(def) - length(replace(def, anker, ''))) / length(anker);
  end if;
  execute replace(def, anker, vervanging);
end
$patch$;
