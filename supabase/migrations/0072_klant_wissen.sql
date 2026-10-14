-- 0072 — Een klant definitief wissen
--
-- Gevraagd (14/10/2026): "kunnen we klanten wissen vanuit de website?" --
-- aanleiding: zeven testklanten die gearchiveerd stonden.
--
-- Tot nu kon een klant alleen gearchiveerd worden. Dat blijft de gewone weg:
-- archiveren is omkeerbaar, wissen niet. Daarom drie sloten:
--
--   * alleen een kantoorbeheerder;
--   * alleen een klant die al gearchiveerd is -- wie wist, heeft eerst bewust
--     gearchiveerd, en de openstaande taken zijn dan al geannuleerd;
--   * pas wanneer de naam van de klant exact ingetypt wordt. Een knop die
--     een dossier met zijn hele historiek laat verdwijnen, hoort niet met één
--     verkeerde klik af te gaan.
--
-- Wat er weggaat: de klant, zijn taken en alles wat daaraan hangt
-- (verplichtingen, historiek, boekjaarwijzigingen, factuurposten, wachtende
-- mailmeldingen -- die volgen via "on delete cascade"). De taken eerst, want
-- task_instances.client_id laat het wissen van een klant met taken niet toe.
--
-- Wat blijft: één regel in klanten_gewist -- naam, ondernemingsnummer, hoeveel
-- taken, wie en wanneer. Een dossier dat verdwijnt zonder spoor, is later niet
-- uit te leggen.

create table public.klanten_gewist (
  id bigint generated always as identity primary key,
  firm_id uuid not null references public.firms(id) on delete cascade,
  naam text not null,
  ondernemingsnummer text,
  aantal_taken integer not null,
  gewist_door uuid references public.employees(id) on delete set null,
  gewist_op timestamptz not null default now()
);

comment on table public.klanten_gewist is
  'Spoor van definitief gewiste klanten (0072): wie, wat en wanneer. De rest van het dossier is weg.';

alter table public.klanten_gewist enable row level security;

create policy klanten_gewist_select on public.klanten_gewist
  for select using (public.is_kantoorbeheerder() and firm_id = public.current_employee_firm_id());

revoke all on public.klanten_gewist from anon;
revoke insert, update, delete, truncate on public.klanten_gewist from authenticated;
grant select on public.klanten_gewist to authenticated;

create or replace function public.klant_wissen(p_client_id uuid, p_naam text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_mij uuid := public.current_employee_id();
  v_klant record;
  v_taken integer;
begin
  if v_mij is null or not public.is_kantoorbeheerder() then
    raise exception 'Een klant wissen mag alleen een kantoorbeheerder' using errcode = '42501';
  end if;

  select id, firm_id, naam, ondernemingsnummer, actief into v_klant
  from public.clients where id = p_client_id;
  if v_klant.id is null or v_klant.firm_id is distinct from public.current_employee_firm_id() then
    raise exception 'Deze klant bestaat niet of je hebt er geen toegang toe' using errcode = '42501';
  end if;
  if v_klant.actief then
    raise exception 'Archiveer de klant eerst; alleen een gearchiveerde klant kan gewist worden' using errcode = '22023';
  end if;
  if btrim(coalesce(p_naam, '')) <> btrim(v_klant.naam) then
    raise exception 'Typ de naam van de klant exact over om het wissen te bevestigen' using errcode = '22023';
  end if;

  delete from public.task_instances where client_id = p_client_id;
  get diagnostics v_taken = row_count;

  insert into public.klanten_gewist (firm_id, naam, ondernemingsnummer, aantal_taken, gewist_door)
  values (v_klant.firm_id, v_klant.naam, v_klant.ondernemingsnummer, v_taken, v_mij);

  delete from public.clients where id = p_client_id;
  return v_taken;
end;
$$;

revoke execute on function public.klant_wissen(uuid, text) from public, anon;
grant execute on function public.klant_wissen(uuid, text) to authenticated;
