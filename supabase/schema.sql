-- =========================================================
-- Lakouwon POS — Schéma Supabase (Postgres)
-- Migration depuis l'app localStorage vers une base partagée
-- en ligne, avec authentification serveur et RLS par permission.
-- =========================================================
-- À exécuter une fois dans l'éditeur SQL du projet Supabase
-- (ou via `supabase db push`), avant supabase/functions.sql
-- et supabase/policies.sql.
-- =========================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------
-- SETTINGS (un seul enregistrement, id fixe = 1)
-- ---------------------------------------------------------
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  nom_commerce text not null default 'Mon Commerce',
  adresse text not null default '',
  email text not null default '',
  telephone text not null default '',
  devise text not null default 'HTG' check (devise in ('HTG','USD')),
  logo_url text not null default '',
  couleur_primaire text not null default '#132340',
  couleur_accent text not null default '#c8973f',
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------
-- MAGASINS
-- ---------------------------------------------------------
create table if not exists magasins (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  adresse text not null default '',
  telephone text not null default '',
  email text not null default '',
  logo_url text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- EMPLOYES (liés à auth.users — le mot de passe est géré par
-- Supabase Auth, jamais stocké dans cette table)
-- ---------------------------------------------------------
create table if not exists employes (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  nom text not null,
  role text not null default 'Caissier' check (role in ('Admin','Gerant','Caissier','Personnalisé')),
  magasin_id uuid references magasins(id) on delete set null,
  salaire numeric not null default 0,
  telephone text not null default '',
  email text not null default '',
  permissions text[] not null default '{}',
  actif boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_employes_auth_user on employes(auth_user_id);

-- ---------------------------------------------------------
-- PRODUITS
-- ---------------------------------------------------------
create table if not exists produits (
  id uuid primary key default gen_random_uuid(),
  magasin_id uuid not null references magasins(id) on delete cascade,
  nom text not null,
  categorie text not null default '',
  quantite_par_caisse int not null default 1 check (quantite_par_caisse > 0),
  prix_achat numeric not null default 0 check (prix_achat >= 0),
  quantite_caisse int not null default 0 check (quantite_caisse >= 0),
  quantite_detail int not null default 0 check (quantite_detail >= 0),
  prix_vente_detail numeric not null default 0 check (prix_vente_detail >= 0),
  lots jsonb not null default '[]'::jsonb,
  stock_initial int not null default 0,
  stock_minimum int not null default 0,
  archive boolean not null default false,
  date_creation timestamptz not null default now()
);
create index if not exists idx_produits_magasin on produits(magasin_id);
create index if not exists idx_produits_archive on produits(magasin_id, archive);

-- ---------------------------------------------------------
-- CLIENTS
-- ---------------------------------------------------------
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  magasin_id uuid not null references magasins(id) on delete cascade,
  nom text not null,
  telephone text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_clients_magasin on clients(magasin_id);

-- ---------------------------------------------------------
-- VENTES (fiches de vente)
-- ---------------------------------------------------------
create table if not exists ventes (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique,
  magasin_id uuid not null references magasins(id),
  date timestamptz not null default now(),
  items jsonb not null default '[]'::jsonb,
  total_brut numeric not null default 0,
  remise numeric not null default 0,
  total numeric not null default 0,
  cout_total numeric not null default 0,
  mode_paiement text not null check (mode_paiement in ('cash','banque','moncash','credit')),
  montant_recu numeric not null default 0,
  monnaie_rendue numeric not null default 0,
  montant_paye numeric not null default 0,
  reste numeric not null default 0,
  client_id uuid references clients(id) on delete set null,
  employe_id uuid references employes(id) on delete set null,
  paiements jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_ventes_magasin on ventes(magasin_id);
create index if not exists idx_ventes_client on ventes(client_id) where client_id is not null;
create index if not exists idx_ventes_date on ventes(date desc);

-- ---------------------------------------------------------
-- PROFORMAS (devis, sans impact sur le stock)
-- ---------------------------------------------------------
create table if not exists proformas (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique,
  magasin_id uuid not null references magasins(id),
  date timestamptz not null default now(),
  client_id uuid references clients(id) on delete set null,
  client_nom_libre text not null default '',
  items jsonb not null default '[]'::jsonb,
  total numeric not null default 0,
  employe_id uuid references employes(id) on delete set null,
  notes text not null default ''
);
create index if not exists idx_proformas_magasin on proformas(magasin_id);

-- ---------------------------------------------------------
-- TRANSFERTS entre magasins
-- ---------------------------------------------------------
create table if not exists transferts (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique,
  date timestamptz not null default now(),
  magasin_source_id uuid references magasins(id),
  magasin_dest_id uuid references magasins(id),
  items jsonb not null default '[]'::jsonb,
  employe_id uuid references employes(id) on delete set null
);

-- ---------------------------------------------------------
-- ACHATS (réapprovisionnement fournisseur)
-- ---------------------------------------------------------
create table if not exists achats (
  id uuid primary key default gen_random_uuid(),
  magasin_id uuid not null references magasins(id),
  date timestamptz not null default now(),
  produit_id uuid references produits(id) on delete set null,
  nom text not null,
  quantite int not null check (quantite > 0),
  prix_total numeric not null default 0,
  fournisseur text not null default '',
  employe_id uuid references employes(id) on delete set null
);
create index if not exists idx_achats_magasin on achats(magasin_id);

-- ---------------------------------------------------------
-- CAISSE MOVEMENTS
-- ---------------------------------------------------------
create table if not exists caisse_movements (
  id uuid primary key default gen_random_uuid(),
  magasin_id uuid not null references magasins(id),
  date timestamptz not null default now(),
  type text not null check (type in ('entree','sortie')),
  montant numeric not null check (montant >= 0),
  motif text not null default '',
  employe_id uuid references employes(id) on delete set null,
  source text not null check (source in ('vente','monnaie','manuel','payroll','paiement_dette')),
  vente_id uuid references ventes(id) on delete cascade
);
create index if not exists idx_caisse_magasin on caisse_movements(magasin_id);
create index if not exists idx_caisse_vente on caisse_movements(vente_id) where vente_id is not null;

-- ---------------------------------------------------------
-- PAYROLL PAIEMENTS
-- ---------------------------------------------------------
create table if not exists payroll_paiements (
  id uuid primary key default gen_random_uuid(),
  employe_id uuid references employes(id) on delete cascade,
  montant numeric not null default 0,
  date timestamptz not null default now(),
  periode text not null default ''
);

-- ---------------------------------------------------------
-- JOURNAL (log d'audit)
-- ---------------------------------------------------------
create table if not exists journal (
  id uuid primary key default gen_random_uuid(),
  date timestamptz not null default now(),
  action text not null,
  details text not null default '',
  employe_id uuid references employes(id) on delete set null,
  magasin_id uuid references magasins(id) on delete set null
);
create index if not exists idx_journal_date on journal(date desc);

-- ---------------------------------------------------------
-- Activer Realtime sur les tables qui doivent se synchroniser
-- instantanément entre postes (à activer aussi dans le
-- Dashboard Supabase > Database > Replication si nécessaire).
-- ---------------------------------------------------------
alter publication supabase_realtime add table
  settings, magasins, employes, produits, clients, ventes,
  proformas, transferts, achats, caisse_movements,
  payroll_paiements, journal;
