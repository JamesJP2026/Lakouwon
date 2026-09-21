-- =========================================================
-- Lakouwon POS — Données initiales optionnelles
-- À exécuter après schema.sql / policies.sql / functions.sql,
-- avant de démarrer l'app pour la première fois.
-- =========================================================

-- Crée le premier magasin si aucun n'existe encore (équivalent
-- du "Magasin Principal" créé automatiquement par l'ancienne
-- version localStorage). Le ou les magasins suivants se créent
-- normalement depuis Paramètres > Magasins une fois connecté.
insert into magasins (nom)
select 'Magasin Principal'
where not exists (select 1 from magasins);

-- Le tout premier compte Administrateur ne se crée PAS ici : ouvrez
-- simplement l'application une fois déployée — tant que `employes`
-- est vide, elle affiche l'écran "Configuration initiale" qui crée
-- le compte (Supabase Auth + ligne employes) directement depuis le
-- navigateur, via la policy RLS `employes_bootstrap_insert`.
