-- =========================================================
-- Lakouwon POS — Fonctions RPC (transactions atomiques)
-- À exécuter après schema.sql et policies.sql
-- =========================================================
-- Pourquoi des RPC et pas seulement des requêtes directes du
-- client ? Deux magasins et plusieurs employés peuvent agir en
-- même temps sur le même stock. Un simple "lire le stock côté
-- client puis réécrire" (comme dans l'ancienne version
-- localStorage) provoquerait des ventes en double sur un stock
-- déjà épuisé. Chaque opération sensible est donc encapsulée
-- dans une fonction SQL qui verrouille les lignes concernées
-- (`for update`) et vérifie/déduit le stock de façon atomique,
-- dans une seule transaction. Les prix et coûts sont recalculés
-- ici à partir de la table `produits`, jamais acceptés tels quels
-- depuis le client, pour empêcher une falsification des prix.
-- =========================================================

-- ---------------------------------------------------------
-- to_base36 — convertit un entier en base 36 (chiffres + lettres),
-- utilisé pour générer des numéros de fiche courts mais variés
-- (combinaison de lettres/chiffres) à partir d'un compteur séquentiel.
-- ---------------------------------------------------------
create or replace function to_base36(n bigint) returns text
language plpgsql immutable as $$
declare
  chars text := '0123456789abcdefghijklmnopqrstuvwxyz';
  result text := '';
  reste bigint;
begin
  if n = 0 then return '0'; end if;
  while n > 0 loop
    reste := n % 36;
    result := substr(chars, (reste+1)::int, 1) || result;
    n := n / 36;
  end loop;
  return result;
end;
$$;

-- ---------------------------------------------------------
-- rpc_finalize_sale — encaissement d'une nouvelle vente
-- p_items: [{"produit_id":"uuid","mode":"detail"|"gros","lot_id":"uuid|null","qte":n}]
-- ---------------------------------------------------------
create or replace function rpc_finalize_sale(
  p_magasin_id uuid,
  p_items jsonb,
  p_remise_type text,
  p_remise_valeur numeric,
  p_mode_paiement text,
  p_montant_recu numeric,
  p_encaissement_partiel boolean,
  p_client_id uuid,
  p_client_ref text default null
) returns ventes
language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_existing ventes;
  v_item jsonb;
  v_produit produits;
  v_lot jsonb;
  v_qte int;
  v_unite_par_lot int;
  v_prix_vente numeric;
  v_cout_unitaire numeric;
  v_nom text;
  v_units_needed int;
  v_stock_total int;
  v_caisses_needed int;
  v_reste_u int;
  v_total_brut numeric := 0;
  v_cout_total numeric := 0;
  v_remise numeric := 0;
  v_total numeric := 0;
  v_reste numeric := 0;
  v_montant_paye numeric := 0;
  v_monnaie numeric := 0;
  v_mode_final text;
  v_numero text;
  v_vente_id uuid;
  v_items_out jsonb := '[]'::jsonb;
  v_produit_id uuid;
begin
  v_employe := current_employe_row();
  if v_employe.id is null then raise exception 'Employé non authentifié ou inactif'; end if;
  if not has_perm('vente') then raise exception 'Permission refusée : vente'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Le panier est vide'; end if;

  -- Rejeu idempotent : si cette vente hors-ligne a déjà été synchronisée
  -- (ex: connexion coupée juste après la réponse du serveur), on renvoie
  -- simplement la vente existante au lieu de déduire le stock une seconde fois.
  if p_client_ref is not null then
    select * into v_existing from ventes where client_ref = p_client_ref;
    if found then return v_existing; end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_produit_id := (v_item->>'produit_id')::uuid;
    v_qte := greatest(1, (v_item->>'qte')::int);
    select * into v_produit from produits where id = v_produit_id and magasin_id = p_magasin_id for update;
    if not found then raise exception 'Produit introuvable'; end if;

    if (v_item->>'mode') = 'gros' then
      select l into v_lot from jsonb_array_elements(v_produit.lots) l where l->>'id' = (v_item->>'lot_id') limit 1;
      if v_lot is null then raise exception 'Lot introuvable pour %', v_produit.nom; end if;
      v_unite_par_lot := (v_lot->>'taille')::int;
      v_prix_vente := (v_lot->>'prix')::numeric;
      v_cout_unitaire := (v_produit.prix_achat / greatest(v_produit.quantite_par_caisse,1)) * v_unite_par_lot;
      v_nom := v_produit.nom || ' — Lot de ' || v_unite_par_lot;
    else
      v_unite_par_lot := 1;
      v_prix_vente := v_produit.prix_vente_detail;
      v_cout_unitaire := v_produit.prix_achat / greatest(v_produit.quantite_par_caisse,1);
      v_nom := v_produit.nom;
    end if;

    v_units_needed := v_qte * v_unite_par_lot;
    v_stock_total := v_produit.quantite_caisse * v_produit.quantite_par_caisse + v_produit.quantite_detail;
    if v_units_needed > v_stock_total then raise exception 'Stock insuffisant pour %', v_produit.nom; end if;

    if v_produit.quantite_detail >= v_units_needed then
      update produits set quantite_detail = quantite_detail - v_units_needed where id = v_produit_id;
    else
      v_reste_u := v_units_needed - v_produit.quantite_detail;
      v_caisses_needed := ceil(v_reste_u::numeric / greatest(v_produit.quantite_par_caisse,1));
      update produits set
        quantite_caisse = quantite_caisse - v_caisses_needed,
        quantite_detail = (v_caisses_needed * greatest(v_produit.quantite_par_caisse,1)) - v_reste_u
      where id = v_produit_id;
    end if;

    v_total_brut := v_total_brut + (v_qte * v_prix_vente);
    v_cout_total := v_cout_total + (v_qte * v_cout_unitaire);
    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'produitId', v_produit_id, 'nom', v_nom, 'mode', coalesce(v_item->>'mode','detail'),
      'qte', v_qte, 'uniteParLot', v_unite_par_lot, 'prixVente', v_prix_vente, 'coutUnitaire', v_cout_unitaire));
  end loop;

  v_remise := round(case when p_remise_valeur is null or p_remise_valeur <= 0 then 0
    when p_remise_type = 'pourcentage' then greatest(0, least(v_total_brut * (p_remise_valeur/100.0), v_total_brut))
    else greatest(0, least(p_remise_valeur, v_total_brut)) end, 2);
  v_total := round(greatest(0, v_total_brut - v_remise), 2);

  -- Marge d'un centime pour absorber les arrondis (le montant reçu est
  -- toujours saisi par l'employé en chiffres "ronds").
  if not p_encaissement_partiel and p_montant_recu < v_total - 0.01 then
    raise exception 'Montant reçu insuffisant (reçu: %, total calculé: %, sous-total: %, remise: %)', p_montant_recu, v_total, v_total_brut, v_remise;
  end if;
  if p_encaissement_partiel and p_client_id is null then
    raise exception 'Un client est requis pour un encaissement partiel';
  end if;

  v_reste := case when p_encaissement_partiel then greatest(0, v_total - p_montant_recu) else 0 end;
  v_montant_paye := v_total - v_reste;
  v_monnaie := greatest(0, p_montant_recu - v_total);
  v_mode_final := case when v_reste > 0 then 'credit' else p_mode_paiement end;
  v_vente_id := gen_random_uuid();
  -- Numéro à 2 lettres aléatoires + 6 chiffres (ex: AB000042). L'unicité
  -- vient uniquement de la partie chiffrée (compteur global), les lettres
  -- ne servent qu'à varier l'apparence du numéro.
  v_numero := chr(65+floor(random()*26)::int) || chr(65+floor(random()*26)::int)
    || lpad(nextval('ventes_numero_seq')::text, 6, '0');

  insert into ventes (id, numero, magasin_id, date, items, total_brut, remise, total, cout_total,
    mode_paiement, montant_recu, monnaie_rendue, montant_paye, reste, client_id, employe_id, paiements, client_ref)
  values (v_vente_id, v_numero, p_magasin_id, now(), v_items_out, v_total_brut, v_remise, v_total, v_cout_total,
    v_mode_final, p_montant_recu, v_monnaie, v_montant_paye, v_reste,
    case when v_reste > 0 or p_client_id is not null then p_client_id else null end,
    v_employe.id, '[]'::jsonb, p_client_ref);

  if p_mode_paiement = 'cash' then
    if p_montant_recu > 0 then
      insert into caisse_movements (magasin_id, date, type, montant, motif, employe_id, source, vente_id)
      values (p_magasin_id, now(), 'entree', p_montant_recu, 'Vente ' || v_numero, v_employe.id, 'vente', v_vente_id);
    end if;
    if v_monnaie > 0 then
      insert into caisse_movements (magasin_id, date, type, montant, motif, employe_id, source, vente_id)
      values (p_magasin_id, now(), 'sortie', v_monnaie, 'Monnaie rendue — ' || v_numero, v_employe.id, 'monnaie', v_vente_id);
    end if;
  end if;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Vente ' || v_numero || ' enregistrée', v_total::text || ' · ' || v_mode_final, v_employe.id, p_magasin_id);

  return (select v from ventes v where v.id = v_vente_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_modifier_vente — Admin uniquement. Restaure le stock de
-- l'ancienne version, retire ses mouvements de caisse, puis
-- ré-applique la nouvelle vente sur la MÊME ligne (id/numéro
-- conservés). L'historique de paiements partiels est réinitialisé
-- (comme dans l'app d'origine, avec avertissement côté client).
-- ---------------------------------------------------------
create or replace function rpc_modifier_vente(
  p_vente_id uuid,
  p_items jsonb,
  p_remise_type text,
  p_remise_valeur numeric,
  p_mode_paiement text,
  p_montant_recu numeric,
  p_encaissement_partiel boolean,
  p_client_id uuid
) returns ventes
language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_old ventes;
  v_old_item jsonb;
  v_item jsonb;
  v_produit produits;
  v_lot jsonb;
  v_qte int;
  v_unite_par_lot int;
  v_prix_vente numeric;
  v_cout_unitaire numeric;
  v_nom text;
  v_units_needed int;
  v_stock_total int;
  v_caisses_needed int;
  v_reste_u int;
  v_total_brut numeric := 0;
  v_cout_total numeric := 0;
  v_remise numeric := 0;
  v_total numeric := 0;
  v_reste numeric := 0;
  v_montant_paye numeric := 0;
  v_monnaie numeric := 0;
  v_mode_final text;
  v_items_out jsonb := '[]'::jsonb;
  v_produit_id uuid;
begin
  if not is_admin() then raise exception 'Seul un administrateur peut modifier une vente'; end if;
  v_employe := current_employe_row();
  select * into v_old from ventes where id = p_vente_id for update;
  if not found then raise exception 'Vente introuvable'; end if;

  for v_old_item in select * from jsonb_array_elements(v_old.items) loop
    update produits set quantite_detail = quantite_detail + (
      case when (v_old_item->>'mode') = 'gros'
        then (v_old_item->>'qte')::int * (v_old_item->>'uniteParLot')::int
        else (v_old_item->>'qte')::int end
    ) where id = (v_old_item->>'produitId')::uuid;
  end loop;
  delete from caisse_movements where vente_id = p_vente_id;

  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Le panier est vide'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_produit_id := (v_item->>'produit_id')::uuid;
    v_qte := greatest(1, (v_item->>'qte')::int);
    select * into v_produit from produits where id = v_produit_id and magasin_id = v_old.magasin_id for update;
    if not found then raise exception 'Produit introuvable'; end if;

    if (v_item->>'mode') = 'gros' then
      select l into v_lot from jsonb_array_elements(v_produit.lots) l where l->>'id' = (v_item->>'lot_id') limit 1;
      if v_lot is null then raise exception 'Lot introuvable pour %', v_produit.nom; end if;
      v_unite_par_lot := (v_lot->>'taille')::int;
      v_prix_vente := (v_lot->>'prix')::numeric;
      v_cout_unitaire := (v_produit.prix_achat / greatest(v_produit.quantite_par_caisse,1)) * v_unite_par_lot;
      v_nom := v_produit.nom || ' — Lot de ' || v_unite_par_lot;
    else
      v_unite_par_lot := 1;
      v_prix_vente := v_produit.prix_vente_detail;
      v_cout_unitaire := v_produit.prix_achat / greatest(v_produit.quantite_par_caisse,1);
      v_nom := v_produit.nom;
    end if;

    v_units_needed := v_qte * v_unite_par_lot;
    v_stock_total := v_produit.quantite_caisse * v_produit.quantite_par_caisse + v_produit.quantite_detail;
    if v_units_needed > v_stock_total then raise exception 'Stock insuffisant pour %', v_produit.nom; end if;

    if v_produit.quantite_detail >= v_units_needed then
      update produits set quantite_detail = quantite_detail - v_units_needed where id = v_produit_id;
    else
      v_reste_u := v_units_needed - v_produit.quantite_detail;
      v_caisses_needed := ceil(v_reste_u::numeric / greatest(v_produit.quantite_par_caisse,1));
      update produits set
        quantite_caisse = quantite_caisse - v_caisses_needed,
        quantite_detail = (v_caisses_needed * greatest(v_produit.quantite_par_caisse,1)) - v_reste_u
      where id = v_produit_id;
    end if;

    v_total_brut := v_total_brut + (v_qte * v_prix_vente);
    v_cout_total := v_cout_total + (v_qte * v_cout_unitaire);
    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'produitId', v_produit_id, 'nom', v_nom, 'mode', coalesce(v_item->>'mode','detail'),
      'qte', v_qte, 'uniteParLot', v_unite_par_lot, 'prixVente', v_prix_vente, 'coutUnitaire', v_cout_unitaire));
  end loop;

  v_remise := round(case when p_remise_valeur is null or p_remise_valeur <= 0 then 0
    when p_remise_type = 'pourcentage' then greatest(0, least(v_total_brut * (p_remise_valeur/100.0), v_total_brut))
    else greatest(0, least(p_remise_valeur, v_total_brut)) end, 2);
  v_total := round(greatest(0, v_total_brut - v_remise), 2);

  if not p_encaissement_partiel and p_montant_recu < v_total - 0.01 then raise exception 'Montant reçu insuffisant (reçu: %, total calculé: %, sous-total: %, remise: %)', p_montant_recu, v_total, v_total_brut, v_remise; end if;
  if p_encaissement_partiel and p_client_id is null then raise exception 'Un client est requis pour un encaissement partiel'; end if;

  v_reste := case when p_encaissement_partiel then greatest(0, v_total - p_montant_recu) else 0 end;
  v_montant_paye := v_total - v_reste;
  v_monnaie := greatest(0, p_montant_recu - v_total);
  v_mode_final := case when v_reste > 0 then 'credit' else p_mode_paiement end;

  update ventes set
    date = now(), items = v_items_out, total_brut = v_total_brut, remise = v_remise, total = v_total,
    cout_total = v_cout_total, mode_paiement = v_mode_final, montant_recu = p_montant_recu,
    monnaie_rendue = v_monnaie, montant_paye = v_montant_paye, reste = v_reste,
    client_id = case when v_reste > 0 or p_client_id is not null then p_client_id else null end,
    paiements = '[]'::jsonb
  where id = p_vente_id;

  if p_mode_paiement = 'cash' then
    if p_montant_recu > 0 then
      insert into caisse_movements (magasin_id, date, type, montant, motif, employe_id, source, vente_id)
      values (v_old.magasin_id, now(), 'entree', p_montant_recu, 'Vente ' || v_old.numero, v_employe.id, 'vente', p_vente_id);
    end if;
    if v_monnaie > 0 then
      insert into caisse_movements (magasin_id, date, type, montant, motif, employe_id, source, vente_id)
      values (v_old.magasin_id, now(), 'sortie', v_monnaie, 'Monnaie rendue — ' || v_old.numero, v_employe.id, 'monnaie', p_vente_id);
    end if;
  end if;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Fiche ' || v_old.numero || ' modifiée', v_total::text || ' · ' || v_mode_final, v_employe.id, v_old.magasin_id);

  return (select v from ventes v where v.id = p_vente_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_delete_vente — Admin uniquement. Restitue le stock ; les
-- mouvements de caisse liés partent automatiquement (ON DELETE
-- CASCADE via vente_id).
-- ---------------------------------------------------------
create or replace function rpc_delete_vente(p_vente_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_vente ventes;
  v_item jsonb;
  v_employe employes;
begin
  v_employe := current_employe_row();
  if not is_admin() then raise exception 'Seul un administrateur peut supprimer une vente'; end if;
  select * into v_vente from ventes where id = p_vente_id for update;
  if not found then raise exception 'Vente introuvable'; end if;

  for v_item in select * from jsonb_array_elements(v_vente.items) loop
    update produits set quantite_detail = quantite_detail + (
      case when (v_item->>'mode') = 'gros'
        then (v_item->>'qte')::int * (v_item->>'uniteParLot')::int
        else (v_item->>'qte')::int end
    ) where id = (v_item->>'produitId')::uuid;
  end loop;

  delete from ventes where id = p_vente_id;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Vente supprimée', v_vente.numero || ' · ' || v_vente.total::text, v_employe.id, v_vente.magasin_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_pay_client_debt — paiement partiel réparti sur les fiches
-- les plus anciennes d'un client (FIFO), comme l'app d'origine.
-- ---------------------------------------------------------
create or replace function rpc_pay_client_debt(p_client_id uuid, p_montant numeric, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_client clients;
  v_vente ventes;
  v_restant numeric := p_montant;
  v_pay numeric;
begin
  v_employe := current_employe_row();
  if v_employe.id is null then raise exception 'Employé non authentifié'; end if;
  if not (has_perm('clients') or has_perm('fiches') or has_perm('caisse')) then
    raise exception 'Permission refusée';
  end if;
  if p_montant <= 0 then raise exception 'Montant invalide'; end if;
  select * into v_client from clients where id = p_client_id;
  if not found then raise exception 'Client introuvable'; end if;

  for v_vente in select * from ventes where client_id = p_client_id and reste > 0 order by date asc for update loop
    exit when v_restant <= 0;
    v_pay := least(v_restant, v_vente.reste);
    update ventes set
      reste = reste - v_pay,
      montant_paye = montant_paye + v_pay,
      paiements = paiements || jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid(), 'montant', v_pay, 'mode', p_mode, 'date', now(), 'employeId', v_employe.id))
    where id = v_vente.id;
    v_restant := v_restant - v_pay;
  end loop;

  if p_mode = 'cash' and p_montant > 0 then
    insert into caisse_movements (magasin_id, date, type, montant, motif, employe_id, source)
    values (v_client.magasin_id, now(), 'entree', p_montant, 'Paiement dette — ' || v_client.nom, v_employe.id, 'paiement_dette');
  end if;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Paiement de dette reçu', v_client.nom || ' · ' || p_montant::text, v_employe.id, v_client.magasin_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_pay_vente — paiement partiel sur une fiche précise.
-- ---------------------------------------------------------
create or replace function rpc_pay_vente(p_vente_id uuid, p_montant numeric, p_mode text)
returns ventes language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_vente ventes;
  v_pay numeric;
begin
  v_employe := current_employe_row();
  if v_employe.id is null then raise exception 'Employé non authentifié'; end if;
  if not (has_perm('clients') or has_perm('fiches') or has_perm('caisse') or has_perm('vente')) then
    raise exception 'Permission refusée';
  end if;
  if p_montant <= 0 then raise exception 'Montant invalide'; end if;
  select * into v_vente from ventes where id = p_vente_id for update;
  if not found then raise exception 'Vente introuvable'; end if;
  v_pay := least(p_montant, v_vente.reste);
  if v_pay <= 0 then raise exception 'Rien à payer sur cette fiche'; end if;

  update ventes set
    reste = reste - v_pay,
    montant_paye = montant_paye + v_pay,
    paiements = paiements || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(), 'montant', v_pay, 'mode', p_mode, 'date', now(), 'employeId', v_employe.id))
  where id = p_vente_id;

  if p_mode = 'cash' then
    insert into caisse_movements (magasin_id, date, type, montant, motif, employe_id, source, vente_id)
    values (v_vente.magasin_id, now(), 'entree', v_pay, 'Paiement fiche ' || v_vente.numero, v_employe.id, 'paiement_dette', p_vente_id);
  end if;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Paiement reçu sur fiche', v_vente.numero || ' · ' || v_pay::text, v_employe.id, v_vente.magasin_id);

  return (select v from ventes v where v.id = p_vente_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_creer_transfert — Étape 1/2 : le magasin source envoie la
-- marchandise. Le stock est retiré IMMÉDIATEMENT du magasin source
-- (pour ne pas le revendre pendant qu'il est en route), mais rien
-- n'est ajouté au magasin destinataire tant que celui-ci n'a pas
-- confirmé la réception (rpc_confirmer_transfert). Le transfert est
-- créé avec le statut 'en_transit'.
-- p_items: [{"produit_id":"uuid","qte":n}]
-- ---------------------------------------------------------
create or replace function rpc_creer_transfert(p_source_id uuid, p_dest_id uuid, p_items jsonb)
returns transferts language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_item jsonb;
  v_produit_id uuid;
  v_qte int;
  v_src produits;
  v_stock_total int;
  v_caisses_needed int;
  v_reste_u int;
  v_numero text;
  v_id uuid;
  v_items_out jsonb := '[]'::jsonb;
begin
  v_employe := current_employe_row();
  if v_employe.id is null then raise exception 'Employé non authentifié'; end if;
  if not has_perm('transferts') then raise exception 'Permission refusée : transferts'; end if;
  if p_source_id = p_dest_id then raise exception 'Source et destination identiques'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Aucun article sélectionné'; end if;

  v_numero := 'T' || to_char(now(),'YYMMDDHH24MISS') || substr(md5(random()::text || clock_timestamp()::text),1,4);
  v_id := gen_random_uuid();

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_produit_id := (v_item->>'produit_id')::uuid;
    v_qte := greatest(1, (v_item->>'qte')::int);
    select * into v_src from produits where id = v_produit_id and magasin_id = p_source_id for update;
    if not found then raise exception 'Produit introuvable dans le magasin source'; end if;

    v_stock_total := v_src.quantite_caisse * v_src.quantite_par_caisse + v_src.quantite_detail;
    if v_qte > v_stock_total then raise exception 'Stock insuffisant pour %', v_src.nom; end if;

    if v_src.quantite_detail >= v_qte then
      update produits set quantite_detail = quantite_detail - v_qte where id = v_produit_id;
    else
      v_reste_u := v_qte - v_src.quantite_detail;
      v_caisses_needed := ceil(v_reste_u::numeric / greatest(v_src.quantite_par_caisse,1));
      update produits set
        quantite_caisse = quantite_caisse - v_caisses_needed,
        quantite_detail = (v_caisses_needed * greatest(v_src.quantite_par_caisse,1)) - v_reste_u
      where id = v_produit_id;
    end if;

    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object('produitId', v_produit_id, 'nom', v_src.nom, 'qte', v_qte));
  end loop;

  insert into transferts (id, numero, date, magasin_source_id, magasin_dest_id, items, employe_id, statut)
  values (v_id, v_numero, now(), p_source_id, p_dest_id, v_items_out, v_employe.id, 'en_transit');

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Transfert ' || v_numero || ' envoyé', 'vers ' || (select nom from magasins where id = p_dest_id) || ' — en attente de réception', v_employe.id, p_source_id);

  return (select t from transferts t where t.id = v_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_confirmer_transfert — Étape 2/2 : le magasin destinataire
-- confirme avoir reçu la marchandise. Le stock est ajouté à ce
-- moment-là seulement (crée le produit côté destination si besoin,
-- en copiant sa config depuis le produit source).
-- ---------------------------------------------------------
create or replace function rpc_confirmer_transfert(p_transfert_id uuid)
returns transferts language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_transfert transferts;
  v_item jsonb;
  v_produit_id uuid;
  v_qte int;
  v_src produits;
  v_dst_id uuid;
begin
  v_employe := current_employe_row();
  if v_employe.id is null then raise exception 'Employé non authentifié'; end if;
  select * into v_transfert from transferts where id = p_transfert_id for update;
  if not found then raise exception 'Transfert introuvable'; end if;
  if not has_perm('transferts') then raise exception 'Permission refusée : transferts'; end if;
  if v_transfert.statut <> 'en_transit' then raise exception 'Ce transfert n''est plus en attente de réception'; end if;

  for v_item in select * from jsonb_array_elements(v_transfert.items) loop
    v_produit_id := (v_item->>'produitId')::uuid;
    v_qte := (v_item->>'qte')::int;
    select * into v_src from produits where id = v_produit_id;

    select id into v_dst_id from produits
      where magasin_id = v_transfert.magasin_dest_id and lower(nom) = lower(v_item->>'nom') limit 1 for update;
    if v_dst_id is null then
      insert into produits (magasin_id, nom, categorie, quantite_par_caisse, prix_achat, quantite_caisse,
        quantite_detail, prix_vente_detail, lots, stock_initial, stock_minimum, archive)
      values (
        v_transfert.magasin_dest_id, v_item->>'nom',
        coalesce(v_src.categorie, ''), coalesce(v_src.quantite_par_caisse, 1), coalesce(v_src.prix_achat, 0), 0,
        v_qte, coalesce(v_src.prix_vente_detail, 0),
        coalesce((select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'taille', (l->>'taille')::int, 'prix', (l->>'prix')::numeric))
           from jsonb_array_elements(coalesce(v_src.lots,'[]'::jsonb)) l), '[]'::jsonb),
        0, coalesce(v_src.stock_minimum, 0), false);
    else
      update produits set quantite_detail = quantite_detail + v_qte where id = v_dst_id;
    end if;
  end loop;

  update transferts set statut = 'recu', date_reception = now(), confirme_par = v_employe.id
  where id = p_transfert_id;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Transfert ' || v_transfert.numero || ' reçu', 'confirmé par ' || v_employe.nom, v_employe.id, v_transfert.magasin_dest_id);

  return (select t from transferts t where t.id = p_transfert_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_annuler_transfert — Admin uniquement. Annule un transfert
-- encore en transit et restitue le stock au magasin source.
-- ---------------------------------------------------------
create or replace function rpc_annuler_transfert(p_transfert_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_transfert transferts;
  v_item jsonb;
begin
  v_employe := current_employe_row();
  if not is_admin() then raise exception 'Seul un administrateur peut annuler un transfert'; end if;
  select * into v_transfert from transferts where id = p_transfert_id for update;
  if not found then raise exception 'Transfert introuvable'; end if;
  if v_transfert.statut <> 'en_transit' then raise exception 'Ce transfert n''est plus en attente de réception'; end if;

  for v_item in select * from jsonb_array_elements(v_transfert.items) loop
    update produits set quantite_detail = quantite_detail + (v_item->>'qte')::int
    where id = (v_item->>'produitId')::uuid;
  end loop;

  update transferts set statut = 'annule' where id = p_transfert_id;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Transfert ' || v_transfert.numero || ' annulé', 'stock restitué au magasin source', v_employe.id, v_transfert.magasin_source_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_add_achat — enregistre un achat fournisseur et incrémente
-- le stock détail de façon atomique si demandé.
-- ---------------------------------------------------------
create or replace function rpc_add_achat(
  p_magasin_id uuid, p_produit_id uuid, p_date date, p_fournisseur text,
  p_quantite int, p_prix_total numeric, p_ajout_stock boolean
) returns achats language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_produit produits;
  v_achat achats;
begin
  v_employe := current_employe_row();
  if not has_perm('achats') then raise exception 'Permission refusée : achats'; end if;
  select * into v_produit from produits where id = p_produit_id for update;
  if not found then raise exception 'Produit introuvable'; end if;
  if p_quantite <= 0 then raise exception 'Quantité invalide'; end if;

  insert into achats (magasin_id, date, produit_id, nom, quantite, prix_total, fournisseur, employe_id)
  values (p_magasin_id, p_date::timestamptz + time '12:00', p_produit_id, v_produit.nom, p_quantite, p_prix_total, coalesce(p_fournisseur,''), v_employe.id)
  returning * into v_achat;

  if p_ajout_stock then
    update produits set quantite_detail = quantite_detail + p_quantite where id = p_produit_id;
  end if;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Achat enregistré', v_produit.nom || ' · ' || p_quantite::text || ' · ' || p_prix_total::text || coalesce(' · '||nullif(p_fournisseur,''),''), v_employe.id, p_magasin_id);

  return v_achat;
end;
$$;

-- ---------------------------------------------------------
-- rpc_add_achats_groupe — enregistre une LISTE d'achats (plusieurs
-- produits) en une seule entrée de journal (même achat_groupe_id) et
-- ajoute automatiquement chaque quantité au stock détail, de façon
-- atomique (tout ou rien).
-- p_items: [{"produit_id":"uuid","quantite":n,"prix_total":numeric}]
-- ---------------------------------------------------------
create or replace function rpc_add_achats_groupe(
  p_magasin_id uuid, p_date date, p_fournisseur text, p_items jsonb
) returns setof achats language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_produit produits;
  v_item jsonb;
  v_groupe_id uuid := gen_random_uuid();
  v_quantite int;
  v_prix_total numeric;
  v_nb int := 0;
  v_total numeric := 0;
  v_noms text := '';
begin
  v_employe := current_employe_row();
  if not has_perm('achats') then raise exception 'Permission refusée : achats'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'La liste d''achat est vide'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_quantite := (v_item->>'quantite')::int;
    v_prix_total := coalesce((v_item->>'prix_total')::numeric, 0);
    select * into v_produit from produits where id = (v_item->>'produit_id')::uuid for update;
    if not found then raise exception 'Produit introuvable'; end if;
    if v_quantite <= 0 then raise exception 'Quantité invalide pour %', v_produit.nom; end if;

    insert into achats (magasin_id, date, produit_id, nom, quantite, prix_total, fournisseur, employe_id, achat_groupe_id)
    values (p_magasin_id, p_date::timestamptz + time '12:00', v_produit.id, v_produit.nom, v_quantite, v_prix_total, coalesce(p_fournisseur,''), v_employe.id, v_groupe_id);

    update produits set quantite_detail = quantite_detail + v_quantite where id = v_produit.id;

    v_nb := v_nb + 1;
    v_total := v_total + v_prix_total;
    v_noms := v_noms || case when v_noms='' then '' else ', ' end || v_produit.nom;
  end loop;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Achat enregistré (' || v_nb::text || ' produits)', v_noms || ' · ' || v_total::text || coalesce(' · '||nullif(p_fournisseur,''),''), v_employe.id, p_magasin_id);

  return query select * from achats where achat_groupe_id = v_groupe_id;
end;
$$;

-- ---------------------------------------------------------
-- rpc_pay_salaire — enregistre un paiement de salaire et, si
-- réglé en espèces, la sortie de caisse correspondante.
-- ---------------------------------------------------------
create or replace function rpc_pay_salaire(p_magasin_id uuid, p_employe_id uuid, p_montant numeric, p_periode text, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_employe employes;
  v_emp_target employes;
begin
  v_employe := current_employe_row();
  if not has_perm('employes') then raise exception 'Permission refusée : employes'; end if;
  if p_montant <= 0 then raise exception 'Montant invalide'; end if;
  select * into v_emp_target from employes where id = p_employe_id;
  if not found then raise exception 'Employé introuvable'; end if;

  insert into payroll_paiements (employe_id, montant, date, periode)
  values (p_employe_id, p_montant, now(), coalesce(p_periode,''));

  if p_mode = 'cash' then
    insert into caisse_movements (magasin_id, date, type, montant, motif, employe_id, source)
    values (p_magasin_id, now(), 'sortie', p_montant, 'Salaire — ' || v_emp_target.nom || ' (' || coalesce(p_periode,'') || ')', v_employe.id, 'payroll');
  end if;

  insert into journal (date, action, details, employe_id, magasin_id)
  values (now(), 'Salaire payé', v_emp_target.nom || ' · ' || p_montant::text, v_employe.id, p_magasin_id);
end;
$$;

-- ---------------------------------------------------------
-- rpc_auto_archive_produits_inactifs — appelée par le client au
-- chargement (comme l'ancienne autoArchiverProduitsInactifs), ou
-- planifiable via pg_cron pour tourner une fois par jour.
-- ---------------------------------------------------------
create or replace function rpc_auto_archive_produits_inactifs()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_produit record;
  v_dernier timestamptz;
  v_employe employes;
begin
  v_employe := current_employe_row();
  if v_employe.id is null then return; end if;
  for v_produit in select * from produits where archive = false and date_creation <= now() - interval '60 days' loop
    select max((v->>'date')::timestamptz) into v_dernier
    from ventes vt, jsonb_array_elements(vt.items) v
    where (v->>'produitId')::uuid = v_produit.id;
    if v_dernier is null or v_dernier <= now() - interval '60 days' then
      update produits set archive = true where id = v_produit.id;
      insert into journal (date, action, details, employe_id, magasin_id)
      values (now(), 'Produit archivé automatiquement (aucune vente récente)', v_produit.nom, v_employe.id, v_produit.magasin_id);
    end if;
  end loop;
end;
$$;

-- Autorise l'appel de ces fonctions par les rôles applicatifs
-- (RLS + vérifications internes restent l'unique barrière).
grant execute on function
  rpc_finalize_sale, rpc_modifier_vente, rpc_delete_vente,
  rpc_pay_client_debt, rpc_pay_vente,
  rpc_creer_transfert, rpc_confirmer_transfert, rpc_annuler_transfert,
  rpc_add_achat, rpc_add_achats_groupe, rpc_pay_salaire, rpc_auto_archive_produits_inactifs
to authenticated;

-- Si vous avez déjà exécuté une version précédente de ce fichier,
-- l'ancienne fonction rpc_execute_transfert (remplacée par
-- rpc_creer_transfert + rpc_confirmer_transfert ci-dessus) peut être
-- supprimée sans risque :
drop function if exists rpc_execute_transfert(uuid, uuid, jsonb);
