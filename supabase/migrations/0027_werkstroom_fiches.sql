-- ============================================================
-- 0027 — De werkstroom "Fiches"
--
-- De fiches 281.20, 281.45 en 281.50 horen in geen van de vier bestaande
-- stromen thuis. Ze lopen niet op het boekjaar maar op het inkomstenjaar, en
-- het kantoor werkt ze ook zo af: "de fiches doen we in februari". Ze bij
-- Afsluiting zetten zou ze laten meedeinen met een boekjaar waar ze niets mee
-- te maken hebben.
--
-- Deze migratie doet alleen de enumwaarde. Postgres laat een nieuwe waarde
-- niet gebruiken in dezelfde transactie waarin ze toegevoegd wordt, en de
-- verplichtingstypes van 0028 hebben ze meteen nodig.
-- ============================================================

alter type public.werkstroom add value if not exists 'fiches';
