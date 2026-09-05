-- ============================================================
-- 0055 — can_view_client() gaat dicht voor de API
--
-- Al een tijd gemeld door de Supabase-advisor, en bij het nakijken bleek het
-- meer dan een vinkje op een lijstje.
--
-- ------------------------------------------------------------
-- Wat er lekte
--
-- De handtekening is `can_view_client(p_client_id, p_employee_id)`. Die tweede
-- parameter is het probleem: je vult er een WILLEKEURIGE medewerker in, niet
-- jezelf. En omdat de functie `security definer` is en `authenticated` er
-- EXECUTE op had, was ze aanroepbaar via /rest/v1/rpc/can_view_client.
--
-- Live nagegaan op de productiedatabank, als een gewone medewerker die het
-- dossier "Familie Van Hulle Holding" (vertrouwelijk) niet mag zien:
--
--   select * from clients where id = <dossier>          -> 0 rijen
--   can_view_client(<dossier>, <zichzelf>)              -> false
--   can_view_client(<dossier>, <een collega>)           -> TRUE
--   can_view_client(<onbestaand dossier>, <zichzelf>)   -> null
--
-- Drie dingen dus. Hij kan het dossier zelf niet zien, maar leert wél dat een
-- welbepaalde collega er toegang toe heeft — precies wat de vertrouwelijkheid
-- moest afschermen. En omdat een onbestaand dossier `null` geeft en een
-- bestaand `false`, is het meteen een bestaan-orakel over de hele databank.
--
-- Met de medewerkerslijst ernaast — die het scherm gewoon toont — is dat de
-- volledige toegangskaart van elk vertrouwelijk dossier, één vraag per
-- combinatie.
--
-- ------------------------------------------------------------
-- Waarom intrekken volstaat
--
-- Nagekeken vóór het intrekken, want een grant weghalen die iets nodig heeft,
-- breekt stil:
--
--   - geen enkele RLS-policy roept can_view_client() aan;
--   - de app roept ze nergens aan (geen enkele treffer in src/);
--   - de drie functies die haar wél gebruiken -- can_access_client(),
--     enforce_task_instance_transition() en
--     enforce_obligation_assignment_access() -- zijn alle drie zelf
--     `security definer` en draaien dus als de eigenaar. Die hebben de grant
--     van `authenticated` niet nodig.
--
-- De functie blijft dus gewoon bestaan en werken; ze is alleen niet langer
-- van buitenaf op te roepen.
--
-- ------------------------------------------------------------
-- Wat hier NIET mee opgelost is: mag_klant_zien()
--
-- Die heeft dezelfde vorm -- een vrij in te vullen p_employee_id -- en is óók
-- door `authenticated` uitvoerbaar. Ze kan niet zomaar dicht: de policies
-- `clients_select` en `clients_update` roepen haar rechtstreeks aan, en een
-- policy-expressie draait met de rechten van wie de query stelt. De grant
-- weghalen sluit de klantentabel voor iedereen.
--
-- Het lek is er ook smaller: je geeft de kenmerken van de klant
-- (vertrouwelijk, team) zélf mee, dus je krijgt vooral terug wat je al
-- invulde. Wat er wél uit te halen valt, is of een medewerker lopend werk
-- heeft op een dossier-id dat je al kent.
--
-- Dichtzetten vraagt een echte ingreep -- de p_employee_id vastpinnen op de
-- oproeper -- en dat botst met de interne oproepers, die juist over een ANDERE
-- medewerker vragen (0015 kijkt of de toegewezen medewerker het dossier mag
-- zien). Dat is een aparte beslissing en geen bijzaak van deze migratie.
-- ============================================================

revoke execute on function public.can_view_client(uuid, uuid) from authenticated;

comment on function public.can_view_client(uuid, uuid) is
  'Mag deze medewerker dit dossier zien? Uitsluitend voor intern gebruik door andere '
  'security definer-functies: de tweede parameter is een willekeurige medewerker, dus van '
  'buitenaf aanroepbaar zou ze de toegangskaart van elk vertrouwelijk dossier verklappen '
  '(migratie 0055). Geef `authenticated` hier nooit opnieuw EXECUTE op.';
