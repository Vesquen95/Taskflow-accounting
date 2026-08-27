-- Taskflow v1 -- dode code opruimen.
--
-- Aanleiding: het kantoor. "Kijk in alle codes of alles nog nuttig is en niet
-- overbodig. Verwijder alle niet gebruikte codes."
--
-- Wat hier weggaat is nagekeken op afhankelijkheden, niet op naam: elk object
-- is getoetst tegen de triggers, de RLS-policies, de bodies van alle andere
-- functies en de rpc-aanroepen in de app.
--
-- ============================================================
-- 1. De kanbantabellen van het eerste prototype
-- ============================================================
-- boards/columns/labels/tasks/task_labels komen uit de allereerste opzet, van
-- voor de beslissing dat een kanbanbord niet het hoofdscherm wordt (PLAN §4).
-- Sinds 0014 zijn ze ingetrokken voor anon en authenticated, maar ze stonden er
-- nog: vijf lege tabellen met samen negentien RLS-policies en een trigger.
--
-- Dat is niet alleen rommel maar ook een risico. Negentien policies die niemand
-- meer leest zijn negentien plaatsen waar een latere `grant` stilzwijgend een
-- deur openzet, en elke security-ronde moest ze opnieuw uitsluiten. Ze zijn
-- alle vijf leeg (0 rijen) en alle vreemde sleutels lopen binnen de groep, dus
-- er gaat geen gegeven verloren.
--
-- Volgorde: eerst de tabellen die naar de andere verwijzen.
drop table if exists public.task_labels;
drop table if exists public.tasks;
drop table if exists public.labels;
drop table if exists public.columns;
drop table if exists public.boards;

-- ============================================================
-- 2. recalc_due_dates_on_new_holiday() -- vervangen in 0011
-- ============================================================
-- 0011 verving deze door recalc_due_dates_after_holiday_change(), die zowel op
-- toevoegen als op intrekken van een feestdag reageert. De oude functie bleef
-- achter zonder trigger: ze draaide nergens meer, maar zag er in de
-- functielijst uit alsof de herberekening dubbel liep.
drop function if exists public.recalc_due_dates_on_new_holiday();

-- ============================================================
-- 3. feestdagen_dekking() -- toegevoegd in 0023, nooit gebruikt
-- ============================================================
-- Bedoeld om het beheerscherm te laten waarschuwen wanneer de kalender
-- achterloopt op de generatiehorizon. Dat scherm heeft de feestdagen echter al
-- in het geheugen en rekent de dekking zelf uit (src/lib/feestdagen.ts), dus
-- de functie werd nooit aangeroepen -- alleen nog getest.
--
-- Twee plaatsen die hetzelfde uitrekenen is een plaats te veel: bij een
-- wijziging van de regel loopt de ene onvermijdelijk achter op de andere. De
-- kant die draait blijft staan.
drop function if exists public.feestdagen_dekking();
