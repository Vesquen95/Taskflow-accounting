-- ============================================================
-- 0053 — Een verplichting die op een afgesproken datum stopt
--
-- Aanleiding: het kantoor, over afwijkende boekjaren. "Ik moet niet per se
-- weten hoelang die duurt, maar welke taken er blijven bestaan." Het
-- schoolvoorbeeld is een vereffening: de vennootschap blijft na de ontbinding
-- bestaan vóór haar vereffening (art. 2:76 WVV), dus de aangifte, de
-- neerlegging en de UBO-bevestiging lopen gewoon door -- tot de sluiting van
-- de vereffening, en dan houdt alles op.
--
-- ------------------------------------------------------------
-- Wat er misging
--
-- `client_obligations.geldig_tot` bestaat al en het scherm toont hem, maar de
-- MOTOR kijkt er niet naar. De kolom doet vandaag maar één ding: in de
-- selectie staat `geldig_tot is null or geldig_tot >= current_date`, dus een
-- verplichting valt weg zodra haar einddatum voorbij is. Zolang die datum in
-- de toekomst ligt, verandert er niets -- en de bovengrens van elke lus is
-- alleen `v_window_end`, de horizon.
--
-- Nagespeeld op een lokale kopie, verplichting "aangifte VenB" met
-- `geldig_tot = 31/12/2026`:
--
--   2025   boekjaar tot 31/12/2025   aangifte 30/09/2026
--   2026   boekjaar tot 31/12/2026   aangifte 30/09/2027
--   2027   boekjaar tot 31/12/2027   aangifte 02/10/2028   <- hoort er niet
--
-- Het kantoor kon dus wél opschrijven dat een verplichting stopt, maar
-- Taskflow bleef er taken voor maken. Precies het omgekeerde van wat je van
-- een deadlinesysteem verwacht.
--
-- ------------------------------------------------------------
-- De grens ligt op de PERIODE, niet op de deadline
--
-- Dit is het hele punt en het is makkelijk mis te hebben. Sluit de vereffening
-- op 31/12/2026, dan moet de aangifte over boekjaar 2026 er nog steeds staan
-- -- die wordt pas op 30/09/2027 ingediend, ruim ná de einddatum. Wat wegvalt
-- is het boekjaar 2027, niet het papierwerk over 2026.
--
-- Dus: een taak wordt gemaakt zolang haar PERIODE eindigt op of vóór
-- `geldig_tot`. Wanneer ze moet ingediend worden, doet er niet toe.
--
-- ------------------------------------------------------------
-- Waarom in upsert_generated_task en niet in elke tak
--
-- De motor heeft achttien takken en elke tak noemt zijn periode anders
-- (`v_period_eind`, `v_be`, `v_year`). Achttien keer dezelfde controle
-- inbouwen is achttien plaatsen waar ze uit elkaar kunnen lopen. Ze staan
-- allemaal wél op dezelfde uitgang: `upsert_generated_task`, en die krijgt de
-- periode én de verplichting al binnen. Eén plek, alle takken.
--
-- De neerleggingstaak volgt daar vanzelf uit: die wordt alleen aangemaakt
-- wanneer er een AV-taak voor diezelfde periode bestaat. Valt de AV weg, dan
-- valt de neerlegging mee weg.
--
-- ------------------------------------------------------------
-- Geen goedkeuring nodig, anders dan bij 0052
--
-- Een boekjaareinde verzetten is vaak een typfout, en daarom vraagt 0052
-- eerst of het mag. Een einddatum op een verplichting zetten is het
-- tegenovergestelde: dat is een uitdrukkelijke handeling met precies dit als
-- bedoeling. Er nog eens over beginnen zou de gebruiker vragen of hij meent
-- wat hij net getypt heeft.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De motor maakt niets meer voor een periode na de einddatum
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'upsert_generated_task';

  if v_def is null then
    raise exception '0053: upsert_generated_task() bestaat niet.';
  end if;
  if position('0053' in v_def) > 0 then
    raise notice '0053: de grens staat er al, functie ongewijzigd gelaten.';
    return;
  end if;

  -- (a) een plek voor de einddatum
  v_anker := '  v_voorloper_status public.task_status;';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0053: het anker van het declaratieblok past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker,
    v_anker || E'\n' ||
    '  v_geldig_tot date;');

  -- (b) de grens zelf, vóór alles wat schrijft
  v_anker := '  perform set_config(''taskflow.generating'', ''on'', true);';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0053: het anker van de generatievlag past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker,
    '  -- 0053: loopt deze verplichting tot een afgesproken datum, dan houdt ze' || E'\n' ||
    '  -- op na de laatste periode die op of vóór die datum eindigt. De grens' || E'\n' ||
    '  -- ligt op de PERIODE en niet op de deadline: de aangifte over het' || E'\n' ||
    '  -- laatste boekjaar wordt pas maanden ná de einddatum ingediend en moet' || E'\n' ||
    '  -- er dus wél zijn.' || E'\n' ||
    '  if p_client_obligation_id is not null then' || E'\n' ||
    '    select geldig_tot into v_geldig_tot' || E'\n' ||
    '    from public.client_obligations where id = p_client_obligation_id;' || E'\n' ||
    '    if v_geldig_tot is not null and p_periode_eind > v_geldig_tot then' || E'\n' ||
    '      return null;' || E'\n' ||
    '    end if;' || E'\n' ||
    '  end if;' || E'\n' ||
    '' || E'\n' ||
    v_anker);

  execute v_def;
end
$patch$;

-- ------------------------------------------------------------
-- 2. En ruimt op wat er al stond
--
-- Zonder dit geldt de einddatum alleen voor wat nog gegenereerd moet worden,
-- en met een horizon van 36 maanden is dat bijna niets. Deze lus staat vóór
-- de bestaande opruiming: annuleert die de algemene vergadering, dan ziet de
-- bestaande lus daarna dat de neerlegging haar voorloper kwijt is en neemt
-- ze mee. Andersom zou dat een extra ronde kosten.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'sync_client_tasks';

  if v_def is null then
    raise exception '0053: sync_client_tasks() bestaat niet.';
  end if;
  if position('0053' in v_def) > 0 then
    raise notice '0053: de opruiming staat er al, functie ongewijzigd gelaten.';
    return;
  end if;

  v_anker := '  -- Eerst opruimen: open, toekomstige taken van verplichtingen die niet langer';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0053: het anker van de opruiming past niet exact één keer.';
  end if;

  v_def := replace(v_def, v_anker,
    '  -- 0053: taken van een verplichting die op een afgesproken datum stopt en' || E'\n' ||
    '  -- die over een periode NA die datum gaan. Zelfde grens als in de motor:' || E'\n' ||
    '  -- de periode telt, niet de deadline.' || E'\n' ||
    '  for r in' || E'\n' ||
    '    select ti.id' || E'\n' ||
    '    from public.task_instances ti' || E'\n' ||
    '    join public.client_obligations co on co.id = ti.client_obligation_id' || E'\n' ||
    '    where ti.client_id = p_client_id' || E'\n' ||
    '      and ti.bron_type = ''automatisch_gegenereerd''' || E'\n' ||
    '      and ti.status = ''open''' || E'\n' ||
    '      and ti.due_date >= current_date' || E'\n' ||
    '      and co.geldig_tot is not null' || E'\n' ||
    '      and ti.periode_eind > co.geldig_tot' || E'\n' ||
    '  loop' || E'\n' ||
    '    update public.task_instances set status = ''geannuleerd'' where id = r.id;' || E'\n' ||
    '' || E'\n' ||
    '    insert into public.task_status_log (' || E'\n' ||
    '      task_instance_id, event_type, actor_employee_id, trigger_bron, notitie' || E'\n' ||
    '    ) values (' || E'\n' ||
    '      r.id, ''taak_inhoud_gewijzigd'', v_actor, ''medewerker_actie'',' || E'\n' ||
    '      ''Deze verplichting loopt tot een afgesproken einddatum, en deze taak gaat over een periode daarna. ''' || E'\n' ||
    '      ''Zolang die einddatum blijft staan, maakt de taakgeneratie ze niet opnieuw aan.''' || E'\n' ||
    '    );' || E'\n' ||
    '  end loop;' || E'\n' ||
    '' || E'\n' ||
    v_anker);

  execute v_def;
end
$patch$;
