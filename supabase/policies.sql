-- =========================================================
-- Lakouwon POS — Row Level Security
-- À exécuter après schema.sql
-- =========================================================
-- Principe : chaque employé authentifié (auth.uid()) est lié à
-- une ligne `employes.auth_user_id`. Les droits d'écriture sont
-- dérivés de `employes.permissions` (le même référentiel de clés
-- de modules que l'application), et non plus vérifiés seulement
-- côté client.
-- =========================================================

-- ---------------------------------------------------------
-- Fonctions utilitaires (security definer : lisent `employes`
-- même si l'appelant n'a pas directement les droits de SELECT
-- dessus, pour éviter les dépendances circulaires de policies)
-- ---------------------------------------------------------
create or replace function current_employe_row()
returns employes
language sql stable security definer set search_path = public as $$
  select * from employes where auth_user_id = auth.uid() and actif = true limit 1;
$$;

create or replace function is_active_employe()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from employes where auth_user_id = auth.uid() and actif = true);
$$;

create or replace function is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from employes
    where auth_user_id = auth.uid() and actif = true and role = 'Admin'
  );
$$;

create or replace function has_perm(perm text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from employes
    where auth_user_id = auth.uid() and actif = true
      and (role = 'Admin' or perm = any(permissions))
  );
$$;

-- ---------------------------------------------------------
-- SETTINGS
-- ---------------------------------------------------------
alter table settings enable row level security;
create policy settings_select on settings for select using (is_active_employe());
create policy settings_update on settings for update using (has_perm('parametres')) with check (has_perm('parametres'));

-- ---------------------------------------------------------
-- MAGASINS
-- ---------------------------------------------------------
alter table magasins enable row level security;
create policy magasins_select on magasins for select using (is_active_employe());
create policy magasins_insert on magasins for insert with check (has_perm('parametres'));
create policy magasins_update on magasins for update using (has_perm('parametres')) with check (has_perm('parametres'));
create policy magasins_delete on magasins for delete using (has_perm('parametres'));

-- ---------------------------------------------------------
-- EMPLOYES
-- Tout employé actif peut lire la liste (nécessaire pour
-- afficher les noms partout dans l'app). Seule la gestion
-- (créer/modifier/désactiver) requiert la permission 'employes'.
-- La création des comptes d'authentification (mot de passe) se
-- fait via l'Edge Function admin-employee, jamais via une
-- policy RLS directe.
-- ---------------------------------------------------------
alter table employes enable row level security;
create policy employes_select on employes for select using (is_active_employe());
create policy employes_insert on employes for insert with check (has_perm('employes'));
create policy employes_update on employes for update using (has_perm('employes')) with check (has_perm('employes'));
create policy employes_delete on employes for delete using (has_perm('employes'));

-- Seul un Admin peut promouvoir un employé au rôle Admin, même
-- si l'appelant a la permission générique 'employes' (ex: Gérant).
create or replace function enforce_admin_role_promotion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'Admin' and (tg_op = 'INSERT' or old.role is distinct from 'Admin') and not is_admin() then
    raise exception 'Seul un administrateur peut attribuer le rôle Admin';
  end if;
  return new;
end;
$$;
create trigger trg_employes_admin_promotion
  before insert or update on employes
  for each row execute function enforce_admin_role_promotion();

-- ---------------------------------------------------------
-- PRODUITS
-- ---------------------------------------------------------
alter table produits enable row level security;
create policy produits_select on produits for select using (is_active_employe());
create policy produits_insert on produits for insert with check (has_perm('produits'));
create policy produits_update on produits for update using (has_perm('produits')) with check (has_perm('produits'));
create policy produits_delete on produits for delete using (has_perm('produits'));

-- ---------------------------------------------------------
-- CLIENTS
-- ---------------------------------------------------------
alter table clients enable row level security;
create policy clients_select on clients for select using (is_active_employe());
create policy clients_insert on clients for insert with check (has_perm('clients') or has_perm('vente'));
create policy clients_update on clients for update using (has_perm('clients')) with check (has_perm('clients'));
create policy clients_delete on clients for delete using (has_perm('clients'));

-- ---------------------------------------------------------
-- VENTES
-- L'insertion normale passe par rpc_finalize_sale() (voir
-- functions.sql) qui vérifie les stocks de façon atomique ;
-- la policy d'insertion directe reste présente en secours mais
-- l'app n'insère jamais directement dans `ventes`.
-- La modification complète (montant, articles...) d'une vente
-- est réservée à l'Admin (trigger ci-dessous) ; l'enregistrement
-- d'un paiement partiel (reste/montant_paye/paiements) reste
-- ouvert à qui peut naviguer vers les fiches/clients/caisse.
-- La suppression est réservée à l'Admin.
-- ---------------------------------------------------------
alter table ventes enable row level security;
create policy ventes_select on ventes for select using (is_active_employe());
create policy ventes_insert on ventes for insert with check (has_perm('vente'));
create policy ventes_update on ventes for update
  using (has_perm('vente') or has_perm('fiches') or has_perm('clients') or has_perm('caisse'))
  with check (has_perm('vente') or has_perm('fiches') or has_perm('clients') or has_perm('caisse'));
create policy ventes_delete on ventes for delete using (is_admin());

create or replace function enforce_vente_update_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    if new.items is distinct from old.items
       or new.total_brut is distinct from old.total_brut
       or new.remise is distinct from old.remise
       or new.total is distinct from old.total
       or new.cout_total is distinct from old.cout_total
       or new.mode_paiement is distinct from old.mode_paiement
       or new.montant_recu is distinct from old.montant_recu
       or new.monnaie_rendue is distinct from old.monnaie_rendue
       or new.client_id is distinct from old.client_id
       or new.magasin_id is distinct from old.magasin_id
       or new.numero is distinct from old.numero
    then
      raise exception 'Seul un administrateur peut modifier le contenu d''une vente';
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_ventes_update_admin_only
  before update on ventes
  for each row execute function enforce_vente_update_admin_only();

-- ---------------------------------------------------------
-- PROFORMAS
-- Lecture large (recherche rapide du tableau de bord), écriture
-- réservée à 'proforma'.
-- ---------------------------------------------------------
alter table proformas enable row level security;
create policy proformas_select on proformas for select using (is_active_employe());
create policy proformas_insert on proformas for insert with check (has_perm('proforma'));
create policy proformas_update on proformas for update using (has_perm('proforma')) with check (has_perm('proforma'));
create policy proformas_delete on proformas for delete using (has_perm('proforma'));

-- ---------------------------------------------------------
-- TRANSFERTS
-- Passe par rpc_execute_transfert(); pas d'update/delete côté app.
-- ---------------------------------------------------------
alter table transferts enable row level security;
create policy transferts_select on transferts for select using (has_perm('transferts'));
create policy transferts_insert on transferts for insert with check (has_perm('transferts'));

-- ---------------------------------------------------------
-- ACHATS
-- ---------------------------------------------------------
alter table achats enable row level security;
create policy achats_select on achats for select using (has_perm('achats'));
create policy achats_insert on achats for insert with check (has_perm('achats'));
create policy achats_delete on achats for delete using (has_perm('achats'));

-- ---------------------------------------------------------
-- CAISSE MOVEMENTS
-- Lecture large (le tableau de bord affiche le solde de caisse
-- à tous les rôles). Écriture : mouvements manuels via 'caisse';
-- les mouvements liés aux ventes/paiements/paie sont insérés par
-- les fonctions RPC elles-mêmes (security definer).
-- ---------------------------------------------------------
alter table caisse_movements enable row level security;
create policy caisse_select on caisse_movements for select using (is_active_employe());
create policy caisse_insert on caisse_movements for insert with check (has_perm('caisse'));

-- ---------------------------------------------------------
-- PAYROLL PAIEMENTS
-- ---------------------------------------------------------
alter table payroll_paiements enable row level security;
create policy payroll_select on payroll_paiements for select using (has_perm('employes'));
create policy payroll_insert on payroll_paiements for insert with check (has_perm('employes'));

-- ---------------------------------------------------------
-- JOURNAL
-- Tout employé actif peut écrire une entrée de journal (les
-- actions de tous les rôles doivent être tracées) ; seule la
-- consultation du journal complet requiert la permission dédiée.
-- ---------------------------------------------------------
alter table journal enable row level security;
create policy journal_select on journal for select using (has_perm('journal'));
create policy journal_insert on journal for insert with check (is_active_employe());

-- ---------------------------------------------------------
-- ACCÈS PRÉ-CONNEXION (anon)
-- Toutes les policies ci-dessus exigent un employé actif
-- authentifié : un visiteur anonyme ne peut donc rien lire dans
-- `employes` ou `settings`. L'app a pourtant besoin, avant toute
-- connexion, de savoir (a) si un premier compte Admin doit être
-- créé et (b) le nom/logo du commerce à afficher sur l'écran de
-- connexion. Ces deux fonctions exposent volontairement le strict
-- minimum, jamais les tables elles-mêmes, à `anon`.
-- ---------------------------------------------------------
create or replace function rpc_needs_bootstrap()
returns boolean
language sql stable security definer set search_path = public as $$
  select not exists(select 1 from employes);
$$;
grant execute on function rpc_needs_bootstrap() to anon, authenticated;

create or replace function rpc_public_branding()
returns table(nom_commerce text, logo_url text, couleur_primaire text, couleur_accent text)
language sql stable security definer set search_path = public as $$
  select nom_commerce, logo_url, couleur_primaire, couleur_accent from settings where id = 1;
$$;
grant execute on function rpc_public_branding() to anon, authenticated;
