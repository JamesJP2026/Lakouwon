# Lakouwon — POS partagé (Supabase)

Application de point de vente et de gestion de commerce, 100% en
français, pour 2 magasins et plusieurs employés qui travaillent en
même temps sur les **mêmes données, en temps réel**.

C'est la reconstruction de `legacy/pos-business.html` (fichier unique,
`localStorage` par navigateur) en une application connectée à une
vraie base de données partagée (Supabase : Postgres + Auth + Realtime),
en gardant la même interface, la même logique métier et **du
JavaScript vanilla** (aucun framework, aucune étape de build).

## 1. Architecture

```
index.html              → page unique, charge src/js/app.js comme module
src/
  config.example.js     → modèle à copier en config.js (URL + clé Supabase)
  js/
    supabaseClient.js    → client Supabase (config.js)
    app.js                → état, auth, chargement des données, temps réel, routeur
    views.js              → toutes les vues + modales (fonctions pures de rendu HTML)
    events.js             → tous les gestionnaires d'événements (appels Supabase/RPC)
supabase/
  schema.sql             → tables
  policies.sql           → Row Level Security (permissions par rôle, côté serveur)
  functions.sql          → fonctions RPC atomiques (ventes, transferts, paiements...)
  seed.sql               → données initiales (premier magasin)
  functions/
    admin-employee/       → Edge Function (Deno) : création/reset des comptes employés
legacy/
  pos-business.html      → application d'origine (référence, non utilisée en prod)
```

Aucune étape de build : `index.html` charge `src/js/app.js` via
`<script type="module">`, qui importe le client Supabase depuis une
copie locale déjà empaquetée (`src/js/vendor/supabase.esm.js`) plutôt
que depuis un CDN — l'app n'a donc aucune dépendance réseau externe
au chargement (un blocage d'un CDN par un pare-feu, un bloqueur de
pub ou un réseau restrictif ne peut plus provoquer de page blanche).
Le dossier peut être servi tel quel par n'importe quel hébergeur de
fichiers statiques.

## 2. Pourquoi des fonctions RPC en plus de la base de données ?

Avec 2 magasins et plusieurs caissiers actifs en même temps, deux
ventes simultanées sur le même produit pourraient survendre un stock
déjà épuisé si chaque client lisait puis réécrivait le stock de son
côté (c'est exactement ce que faisait l'ancienne version
`localStorage`, qui n'avait qu'un seul utilisateur à la fois).

Les opérations sensibles (encaisser une vente, modifier/supprimer une
vente, payer une dette, transférer du stock, enregistrer un achat,
payer un salaire) passent donc par des fonctions Postgres
(`supabase/functions.sql`) qui verrouillent les lignes concernées et
vérifient/déduisent le stock dans une seule transaction atomique. Les
prix et coûts y sont **recalculés à partir de la table `produits`**,
jamais acceptés tels quels depuis le client — un caissier ne peut donc
pas falsifier un prix de vente depuis son navigateur.

Les permissions (`dashboard`, `vente`, `produits`, `parametres`, ...)
sont les mêmes clés que dans l'app d'origine, mais sont maintenant
vérifiées **côté serveur** par les policies RLS et par les fonctions
RPC (`supabase/policies.sql`), pas seulement pour cacher des boutons
dans l'interface.

## 3. Mise en place (une seule fois)

### 3.1. Créer le projet Supabase
Sur [supabase.com](https://supabase.com), créez un nouveau projet
(offre gratuite suffisante pour démarrer). Notez l'**URL du projet**
et la **clé `anon` publique** (Project Settings → API).

### 3.2. Exécuter le SQL
Dans l'éditeur SQL du projet Supabase, exécutez ces fichiers **dans
l'ordre** :
1. `supabase/schema.sql`
2. `supabase/policies.sql`
3. `supabase/functions.sql`
4. `supabase/seed.sql`

Si l'instruction `alter publication supabase_realtime add table ...`
de `schema.sql` échoue (certains projets créent la publication
autrement), activez la réplication manuellement pour chaque table
depuis *Database → Replication* dans le tableau de bord.

### 3.3. Déployer l'Edge Function
Nécessite le [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
supabase login
supabase link --project-ref VOTRE_REF_PROJET
supabase functions deploy admin-employee
```

Aucun secret à configurer manuellement : `SUPABASE_URL`,
`SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY` sont injectés
automatiquement par Supabase dans l'environnement des Edge Functions.

### 3.4. Configurer le client
```bash
cp src/config.example.js src/config.js
```
Renseignez `SUPABASE_URL` et `SUPABASE_ANON_KEY` dans `src/config.js`
(ce fichier n'est pas versionné — voir `.gitignore`). La clé `anon`
est publique par conception chez Supabase : la vraie protection vient
des policies RLS, pas du secret de cette clé.

### 3.5. Lancer l'app en local
Les modules ES nécessitent d'être servis en HTTP (pas `file://`) :
```bash
npx serve .
# ou : python3 -m http.server 8080
```
Ouvrez la page — comme la table `employes` est vide, l'écran
**« Configuration initiale »** apparaît automatiquement. Remplissez-le
pour créer le premier compte Administrateur (ceci appelle l'Edge
Function avec l'action `bootstrap`, qui ne fonctionne qu'une seule
fois, tant qu'aucun employé n'existe).

### 3.6. Déployer le frontend
Le dossier est un site statique : déployez-le sur Netlify, Vercel, ou
équivalent, sans commande de build. Pensez à créer `src/config.js` sur
la plateforme de déploiement aussi (il est ignoré par git).

## 4. Utilisation au quotidien

- **Ajouter un employé** : Employés & Paie → Nouvel employé, puis
  rouvrez sa fiche pour cliquer sur *Générer un mot de passe* (Admin
  uniquement). Le mot de passe n'est affiché **qu'une seule fois** —
  notez-le et transmettez-le à l'employé.
- **Changer de magasin** : le sélecteur en haut de la barre latérale
  change instantanément les données affichées ; tous les employés
  voient les mêmes données au même moment (Realtime).
- **Modifier/supprimer une vente** : réservé au rôle Admin, comme dans
  l'app d'origine — rien n'est modifié en base tant que vous n'avez
  pas validé l'encaissement de la fiche corrigée.

## 5. Différences volontaires avec l'app d'origine

| Ancien comportement (localStorage) | Nouveau comportement (Supabase) |
|---|---|
| Mot de passe vérifié en JavaScript, hashé SHA-256 côté client | Authentification Supabase Auth (bcrypt côté serveur) |
| Permissions vérifiées seulement pour masquer des boutons | Permissions vérifiées aussi par les policies RLS et les fonctions RPC |
| Vente : lire le stock puis l'écraser (racecondition possible) | `rpc_finalize_sale` : verrouillage + vérification + déduction atomiques |
| Modifier une vente = supprimer puis recréer immédiatement | Le brouillon reste local ; rien n'est écrit tant que vous ne validez pas |
| Logo en base64 dans le JSON local | Toujours en base64 (data URL) dans `settings.logo_url` — simple à migrer plus tard vers Supabase Storage si les images deviennent volumineuses |
| Sauvegarde = export JSON manuel, seule copie des données | Les données vivent dans Postgres (Supabase) ; l'export JSON reste disponible comme sauvegarde ponctuelle |

## 6. Limitations connues / pistes d'amélioration

- Le SQL (schéma, policies, fonctions RPC) n'a pas pu être exécuté ni
  testé contre un vrai projet Supabase dans cet environnement (aucun
  identifiant fourni) — à valider dans l'éditeur SQL avant mise en
  production, en particulier les fonctions RPC les plus longues
  (`rpc_finalize_sale`, `rpc_modifier_vente`, `rpc_execute_transfert`).
- Les logos restent en `data:` URL (base64) plutôt que dans Supabase
  Storage — suffisant pour de petites images, à revoir si besoin.
- `rpc_auto_archive_produits_inactifs` tourne à chaque connexion (comme
  l'ancienne version) ; pour un vrai historique de ventes volumineux,
  la planifier une fois par jour via `pg_cron` serait plus efficace.
- Pas de tests automatisés (l'app d'origine n'en avait pas non plus).

## 7. Sécurité

Voir `supabase/policies.sql` pour le détail des règles. En résumé :
- Un visiteur non connecté ne peut lire que deux informations
  publiques (nom/logo du commerce, et "faut-il créer le premier
  compte admin ?"), via deux fonctions dédiées — jamais les tables.
- Toutes les tables ont RLS activé ; les policies dérivent des mêmes
  permissions que l'interface (`dashboard`, `vente`, `produits`, ...).
- Modifier ou supprimer une vente est bloqué au niveau base de données
  pour tout rôle non-Admin (déclencheur `trg_ventes_update_admin_only`),
  pas seulement caché dans l'interface.
- La création de comptes et la génération de mots de passe passent par
  l'Edge Function `admin-employee`, seule à détenir la clé "service
  role" — jamais exposée au navigateur.
