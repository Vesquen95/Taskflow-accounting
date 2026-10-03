-- 0066 — Een nieuwe PB-klant krijgt de aangifte van het lopende seizoen
--
-- Gevonden op 03/10/2026, bij het verwerken van het uitstel voor aanslagjaar
-- 2026 (PB met specifieke inkomsten tot 31/10/2026).
--
-- De aangifte personenbelasting over inkomstenjaar J heeft haar deadline in
-- J+1 (15 juli of 16 oktober). De motor liep over de inkomstenjaren vanaf het
-- jaar van `v_gen_from` -- het begin van het venster min zes maanden. Bij het
-- aanmaken van een klant is het terugkijkvenster nul, dus `v_gen_from` ligt
-- zes maanden vóór vandaag. Vanaf 1 juli is dat in het lopende jaar, en dan
-- begint de lus bij het lopende inkomstenjaar: de aangifte van VORIG jaar, die
-- nog tot 16 oktober loopt, werd nooit bekeken.
--
-- Gevolg: een klant natuurlijke persoon die tussen juli en half oktober werd
-- toegevoegd, kreeg geen taak voor de aangifte die op dat moment het
-- dringendst was. Zonder melding, want er was niets mis -- er was gewoon niets.
--
-- De VenB had dit probleem nooit: haar lus begint al één jaar vroeger (0019).
-- Hier hetzelfde. Een jaar te vroeg beginnen maakt niets extra aan: een
-- deadline die al voorbij is, valt onder de ondergrens en wordt overgeslagen.
--
-- De andere jaarlijkse verplichtingen met een deadline in het jaar erna zijn
-- nagekeken en hebben dit gat niet in de praktijk: hun deadline (31 maart,
-- 29 juni) ligt vóór 1 juli, en vóór 1 juli valt `v_gen_from` nog in het
-- vorige jaar.

-- Het anker is bewust de eerste jaarlus NA de PB-tak, niet de tak met zijn
-- commentaar erbij: die commentaar verschilt tussen een verse installatie en
-- productie.
do $patch$
declare
  v_def text;
  v_tak text := 'elsif r_co.code = ''aangifte_pb'' then';
  v_lus text := 'extract(year from v_gen_from)::int .. extract(year from v_window_end)::int';
  v_pos int;
  v_staart text;
  v_lus_pos int;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if (length(v_def) - length(replace(v_def, v_tak, ''))) / length(v_tak) <> 1 then
    raise exception '0066: de PB-tak staat niet exact één keer in generate_task_instances_intern().';
  end if;

  v_pos := position(v_tak in v_def);
  v_staart := substr(v_def, v_pos);
  v_lus_pos := position(v_lus in v_staart);

  -- De lus hoort binnen de PB-tak te staan: vóór de volgende tak.
  if v_lus_pos = 0 or v_lus_pos > position(E'\n    elsif ' in substr(v_staart, 2)) then
    raise exception '0066: de jaarlus van de PB-tak niet gevonden.';
  end if;

  execute substr(v_def, 1, v_pos - 1)
       || substr(v_staart, 1, v_lus_pos - 1)
       || 'extract(year from v_gen_from)::int - 1 .. extract(year from v_window_end)::int'
       || ' -- 0066: een jaar vroeger; de deadline valt in het jaar NA het inkomstenjaar'
       || substr(v_staart, v_lus_pos + length(v_lus));
end $patch$;
