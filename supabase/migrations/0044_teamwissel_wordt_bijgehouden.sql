-- ============================================================
-- 0044 — Een teamwissel is een zichtbaarheidsbeslissing, en hoort dus in de
--        historiek van het dossier
--
-- Gevonden bij de review van de teammuur (0039) op 04/09/2026, met een echt
-- account uit team ANT dat geen enkele taak op zijn naam had.
--
-- De muur zelf hield overal stand. Elke aanval van buitenaf werd geweigerd:
-- taken van een ander team, hun verplichtingen, hun statushistoriek en hun
-- wijzigingslog gaven nul rijen; een taak aanmaken op een onzichtbaar dossier
-- werd door RLS geweigerd (terwijl dezelfde insert op een eigen dossier wél
-- lukt, dus de weigering zegt iets); een bestaande taak naar jezelf
-- herverdelen raakte nul rijen; jezelf kantoorbeheerder maken of jezelf bij
-- een ander team voegen: geweigerd; en de twee functies achter de maandagmail
-- zijn niet aanroepbaar door een medewerker.
--
-- Eén ding lukte wél. Een gewone medewerker -- geen beheerder, geen
-- goedkeuringsrecht -- kon van een dossier dat hij mag zien het team
-- wegnemen. Eén UPDATE, één rij geraakt, en het dossier is meteen zichtbaar
-- voor het hele kantoor.
--
-- ------------------------------------------------------------
-- Waarom dat opvalt
--
-- De databank had deze afweging al gemaakt, voor een ander veld. Wie
-- `vertrouwelijk` wil wijzigen, moet kantoorbeheerder zijn én de wijziging
-- wordt weggeschreven in client_change_log. Dat is geen willekeur: dat veld
-- bepaalt wie het dossier mag zien.
--
-- `team_id` doet sinds 0039 exact hetzelfde werk. Het is er alleen ná die
-- afweging bij gekomen, en is door beide zeven gevallen: geen rolcontrole,
-- geen spoor.
--
-- ------------------------------------------------------------
-- Wat deze migratie wel en niet doet
--
-- WEL: de teamwissel komt in de audit, in de categorie die de trigger zelf al
-- kent als "geen extra rolcontrole, wel altijd bijhouden" (de F-7-lijst, waar
-- ook het boekjaareinde en het btw-regime in zitten). Vanaf nu staat er bij
-- elke verhuis wie ze deed en wanneer.
--
-- NIET: de wissel voorbehouden aan een kantoorbeheerder. Dat is een keuze over
-- hoe het kantoor werkt, niet over hoe de databank hoort te sluiten -- een
-- dossier verhuist van team wanneer een klant van beheerder verandert, en dat
-- is dagelijks werk. Die vraag ligt bij het kantoor. Zolang ze niet beslist
-- is, is een spoor beter dan een slot: je kunt terugvinden wat er gebeurd is.
-- ============================================================

do $patch$
declare
  def text := pg_get_functiondef('public.block_unaudited_confidentiality_change()'::regprocedure);
  anker constant text := $a$    'btw_aangifte_frequentie', 'actief'
  ];$a$;
  vervanging constant text := $a$    'btw_aangifte_frequentie', 'actief',
    -- 0044: het team bepaalt sinds 0039 wie het dossier mag zien. Een wissel
    -- is dus een zichtbaarheidsbeslissing en hoort in de historiek, net als
    -- het btw-regime dat de deadlines bepaalt.
    'team_id'
  ];$a$;
begin
  if (length(def) - length(replace(def, anker, ''))) / length(anker) <> 1 then
    raise exception '0044: het ankerpunt komt % keer voor in plaats van 1 keer',
      (length(def) - length(replace(def, anker, ''))) / length(anker);
  end if;
  execute replace(def, anker, vervanging);
end
$patch$;

comment on function public.block_unaudited_confidentiality_change() is
  'Bewaakt de velden van een klantdossier die iets bepalen wat niet stil mag veranderen. Twee categorieen: vertrouwelijk en de standaard verantwoordelijke mogen enkel door een kantoorbeheerder en worden gelogd; het boekjaareinde, het btw-regime, actief en (sinds 0044) het team mogen door iedereen maar worden altijd gelogd.';
