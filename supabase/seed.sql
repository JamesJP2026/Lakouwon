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

-- Le tout premier compte Administrateur ne se crée PAS ici (il a
-- besoin d'un compte Supabase Auth) : utilisez l'Edge Function
-- `admin-employee` avec l'action "bootstrap" juste après avoir
-- exécuté ce fichier — voir README.md, section "Premier
-- démarrage". Elle ne fonctionne qu'une seule fois, tant que la
-- table `employes` est vide.
