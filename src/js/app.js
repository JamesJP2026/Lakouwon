import { supabase } from "./supabaseClient.js";

/* =========================================================
   MAPPING DB (snake_case) <-> STATE JS (camelCase)
   Le contenu des colonnes jsonb (items, lots, paiements) est
   déjà en camelCase (produit par les fonctions RPC), seules les
   colonnes de premier niveau ont besoin d'une conversion.
========================================================= */
const ROW_MAPS = {
  settings: { nom_commerce:'nomCommerce', adresse:'adresse', email:'email', telephone:'telephone', devise:'devise', logo_url:'logo', couleur_primaire:'couleurPrimaire', couleur_accent:'couleurAccent' },
  magasins: { id:'id', nom:'nom', adresse:'adresse', telephone:'telephone', email:'email', logo_url:'logo' },
  employes: { id:'id', auth_user_id:'authUserId', nom:'nom', role:'role', magasin_id:'magasinId', salaire:'salaire', telephone:'telephone', email:'email', permissions:'permissions', actif:'actif' },
  produits: { id:'id', magasin_id:'magasinId', nom:'nom', categorie:'categorie', quantite_par_caisse:'quantiteParCaisse', prix_achat:'prixAchat', quantite_caisse:'quantiteCaisse', quantite_detail:'quantiteDetail', prix_vente_detail:'prixVenteDetail', lots:'lots', stock_initial:'stockInitial', stock_minimum:'stockMinimum', archive:'archive', date_creation:'dateCreation' },
  clients: { id:'id', magasin_id:'magasinId', nom:'nom', telephone:'telephone' },
  ventes: { id:'id', numero:'numero', magasin_id:'magasinId', date:'date', items:'items', total_brut:'totalBrut', remise:'remise', total:'total', cout_total:'coutTotal', mode_paiement:'modePaiement', montant_recu:'montantRecu', monnaie_rendue:'monnaieRendue', montant_paye:'montantPaye', reste:'reste', client_id:'clientId', employe_id:'employeId', paiements:'paiements' },
  proformas: { id:'id', numero:'numero', magasin_id:'magasinId', date:'date', client_id:'clientId', client_nom_libre:'clientNomLibre', items:'items', total:'total', employe_id:'employeId', notes:'notes' },
  transferts: { id:'id', numero:'numero', date:'date', magasin_source_id:'magasinSourceId', magasin_dest_id:'magasinDestId', items:'items', employe_id:'employeId', statut:'statut', date_reception:'dateReception', confirme_par:'confirmePar' },
  achats: { id:'id', magasin_id:'magasinId', date:'date', produit_id:'produitId', nom:'nom', quantite:'quantite', prix_total:'prixTotal', fournisseur:'fournisseur', employe_id:'employeId', achat_groupe_id:'achatGroupeId' },
  caisse_movements: { id:'id', magasin_id:'magasinId', date:'date', type:'type', montant:'montant', motif:'motif', employe_id:'employeId', source:'source', vente_id:'venteId' },
  payroll_paiements: { id:'id', employe_id:'employeId', montant:'montant', date:'date', periode:'periode' },
  journal: { id:'id', date:'date', action:'action', details:'details', employe_id:'employeId', magasin_id:'magasinId' },
  categories: { id:'id', nom:'nom', created_at:'createdAt' },
};
const TABLE_TO_STATE_KEY = {
  settings:'settings', magasins:'magasins', employes:'employes', produits:'produits', clients:'clients',
  ventes:'ventes', proformas:'proformas', transferts:'transferts', achats:'achats',
  caisse_movements:'caisseMovements', payroll_paiements:'payrollPaiements', journal:'journal',
  categories:'categories',
};
function mapRow(table, row){
  const map = ROW_MAPS[table]; const out = {};
  for(const k in row){ out[map[k]||k] = row[k]; }
  return out;
}

/* =========================================================
   HELPERS PURS (portés à l'identique de l'app d'origine)
========================================================= */
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
const fmt = n => (Number(n)||0).toLocaleString('fr-FR',{maximumFractionDigits:2});
const money = n => fmt(n) + ' ' + (state.settings.devise||'HTG');
const nowStr = () => new Date().toLocaleString('fr-FR');

// Désactive un bouton et affiche un indicateur clair pendant une action
// asynchrone, pour éviter les doubles clics (double vente, double
// enregistrement...). Le bouton retrouve son état normal une fois terminé.
async function withBusyButton(btn, fn){
  if(!btn || btn.dataset.busy==='1') return;
  btn.dataset.busy = '1';
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spinner"></span> ${original}`;
  try{
    await fn();
  } finally {
    btn.dataset.busy = '';
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function coutUnitaire(p){ const qpc = p.quantiteParCaisse>0? p.quantiteParCaisse : 1; return (p.prixAchat||0)/qpc; }
function stockUnites(p){ return (p.quantiteCaisse||0)*(p.quantiteParCaisse||1) + (p.quantiteDetail||0); }
function margePct(prixVente, cout){ return cout>0 ? ((prixVente-cout)/cout*100) : 0; }

function periodBounds(p){
  const now = new Date();
  if(p==='today') return new Date(now.getFullYear(),now.getMonth(),now.getDate());
  if(p==='week'){ const d = new Date(now); d.setDate(now.getDate()-7); return d; }
  if(p==='month') return new Date(now.getFullYear(),now.getMonth(),1);
  return new Date(2000,0,1);
}
function unitsConsumed(item){ return item.mode==='gros' ? item.qte*item.uniteParLot : item.qte; }
// Arrondit à 2 décimales pour éviter les faux "montant insuffisant" causés
// par l'imprécision des nombres flottants (ex: 149.99999999999997 au lieu
// de 150), le montant reçu étant lui toujours un nombre "rond" saisi à la main.
function round2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function cartTotal(items){ return round2(items.reduce((s,i)=>s+i.qte*i.prixVente,0)); }
function cartCost(items){ return round2(items.reduce((s,i)=>s+i.qte*i.coutUnitaire,0)); }
function remiseMontant(totalBrut){
  if(posRemiseValeur<=0) return 0;
  const m = posRemiseType==='pourcentage' ? totalBrut*(posRemiseValeur/100) : posRemiseValeur;
  return round2(Math.max(0, Math.min(m, totalBrut)));
}
function venteTotalNet(){
  const brut = cartTotal(cart);
  return round2(Math.max(0, brut - remiseMontant(brut)));
}
function remiseSummaryHTML(){
  const brut = cartTotal(cart);
  const remise = remiseMontant(brut);
  const net = Math.max(0, brut-remise);
  if(remise<=0) return `<div class="cart-total"><span>Total</span><span class="num">${money(brut)}</span></div>`;
  return `
    <div class="breakdown-row"><span>Sous-total</span><span class="num">${money(brut)}</span></div>
    <div class="breakdown-row"><span>Remise</span><span class="num" style="color:var(--red);">-${money(remise)}</span></div>
    <div class="cart-total"><span>Total net</span><span class="num">${money(net)}</span></div>`;
}

function shadeColor(hex, percent){
  hex = (hex||'#132340').replace('#','');
  if(hex.length===3) hex = hex.split('').map(c=>c+c).join('');
  let f = parseInt(hex,16);
  let t = percent<0 ? 0 : 255;
  let p = percent<0 ? percent*-1 : percent;
  let R = f>>16, G = f>>8&0x00FF, B = f&0x0000FF;
  const newR = Math.round((t-R)*p)+R, newG = Math.round((t-G)*p)+G, newB = Math.round((t-B)*p)+B;
  return '#'+(0x1000000+newR*0x10000+newG*0x100+newB).toString(16).slice(1);
}
function applyTheme(){
  const navy = (state.settings.couleurPrimaire) || '#132340';
  const gold = (state.settings.couleurAccent) || '#c8973f';
  document.documentElement.style.setProperty('--navy', navy);
  document.documentElement.style.setProperty('--navy-2', shadeColor(navy, 0.18));
  document.documentElement.style.setProperty('--gold', gold);
  document.documentElement.style.setProperty('--gold-light', shadeColor(gold, 0.4));
}
const THEME_PRESETS = [
  {nom:'Marine & Or', navy:'#132340', gold:'#c8973f'},
  {nom:'Émeraude', navy:'#0f3d2e', gold:'#22c55e'},
  {nom:'Bleu Royal', navy:'#1e3a8a', gold:'#3b82f6'},
  {nom:'Bordeaux', navy:'#5c1a1a', gold:'#e0703a'},
  {nom:'Violet', navy:'#2e1a47', gold:'#a855f7'},
  {nom:'Ardoise', navy:'#1f2937', gold:'#d97706'},
];

const PERMS_ALL = ['dashboard','vente','fiches','proforma','produits','clients','caisse','depenses','transferts','achats','rapport','employes','journal','parametres'];
const PERMS_LABELS = {
  dashboard:'Tableau de bord', vente:'Nouvelle vente', fiches:'Fiches de vente', proforma:'Proforma',
  produits:'Produits & Stock', clients:'Clients & Dettes', caisse:'Caisse', depenses:'Dépenses', transferts:'Transfert entre magasins', achats:'Journal d\'achat', rapport:'Rapport journalier',
  employes:'Employés & Paie', journal:'Journal', parametres:'Paramètres'
};
const PERMS_PRESETS = {
  Admin: PERMS_ALL.slice(),
  Gerant: ['dashboard','vente','fiches','proforma','produits','clients','caisse','depenses','transferts','achats','employes','journal','rapport'],
  Caissier: ['dashboard','vente','fiches','clients','caisse']
};
const SEUIL_ARCHIVAGE_JOURS = 60;

/* =========================================================
   ÉTAT
========================================================= */
function emptyState(){
  return {
    settings:{ nomCommerce:'Mon Commerce', adresse:'', email:'', telephone:'', devise:'HTG', logo:'', couleurPrimaire:'#132340', couleurAccent:'#c8973f' },
    magasins:[], currentMagasinId:'', currentUserId:'',
    employes:[], payrollPaiements:[], produits:[], clients:[], ventes:[], proformas:[],
    transferts:[], achats:[], caisseMovements:[], journal:[], categories:[]
  };
}
let state = emptyState();
let bootstrapNeeded = false;
let loginState = {loggedIn:false};
let loginError = '';
let loginAttempts = 0;
let loginLockUntil = 0;
let changePwError = '';
let generatedPasswordPreview = '';
let view = 'dashboard';
let period = 'today';
let editing = null;
let cart = [];
let posClientId = '';
let posPayMode = 'cash';
let posDepositMode = 'cash';
let posMontantRecu = 0;
let posRemiseType = 'montant';
let posRemiseValeur = 0;
let posEncaissementPartiel = false;
let proformaView = 'liste';
let proformaCart = [];
let proformaClientId = '';
let proformaClientNomLibre = '';
let proformaNotes = '';
let ficheSearch = '';
let ficheFiltreDateDebut = '';
let ficheFiltreDateFin = '';
let ficheFiltreMode = '';
let ficheFiltreEmployeId = '';
let achatFiltreDateDebut = '';
let achatFiltreDateFin = '';
let caisseFiltreDateDebut = '';
let caisseFiltreDateFin = '';
let achatCart = [];
let achatDate = '';
let achatFournisseur = '';
let inventaireSearch = '';
let inventaireComptages = {};
let productLotsDraft = [];
let permissionsDraft = [];
let dashboardSearchQuery = '';
let rapportDate = '';
let magasinLogoDraft = null;
let transfertView = 'liste';
let transfertSourceId = '';
let transfertDestId = '';
let transfertCart = [];
let produitsFiltre = 'actifs';
let toast = null;
let mobileSidebarOpen = false;
let editingVenteId = null;
let editingVenteNumero = null;
let busy = false; // désactive les doubles soumissions pendant un appel réseau

function currentUser(){ return state.employes.find(e=>e.id===state.currentUserId); }
function isAdminConnecte(){ const u = currentUser(); return !!u && u.role==='Admin'; }
function can(perm){
  const u = currentUser();
  if(!u) return false;
  const perms = u.permissions || PERMS_PRESETS[u.role] || [];
  return perms.includes(perm);
}
function showToast(msg){ toast = msg; render(); setTimeout(()=>{ toast=null; render(); }, 2600); }
function friendlyError(err){
  if(isNetworkError(err)) return "Pas de connexion internet — cette action a échoué. Réessayez une fois la connexion rétablie.";
  return (err && err.message) ? err.message : 'Une erreur est survenue';
}
async function edgeFunctionErrorMessage(err){
  try{
    if(err?.context?.text){
      const text = await err.context.text();
      if(text){
        try{ const body = JSON.parse(text); if(body?.error) return body.error; }catch(e){}
        return text;
      }
    }
  }catch(e){}
  return friendlyError(err);
}

/* =========================================================
   CHARGEMENT DES DONNÉES + TEMPS RÉEL
========================================================= */
const DATA_TABLES = ['magasins','employes','produits','clients','ventes','proformas','transferts','achats','caisse_movements','payroll_paiements','journal','categories'];
let realtimeChannel = null;

async function loadAllData(){
  const { data: settingsRow, error: settingsError } = await supabase.from('settings').select('*').eq('id',1).maybeSingle();
  if(settingsError && isNetworkError(settingsError)) return false;
  if(settingsRow) state.settings = mapRow('settings', settingsRow);

  for(const table of DATA_TABLES){
    const key = TABLE_TO_STATE_KEY[table];
    const { data, error } = await supabase.from(table).select('*');
    if(error){ console.error('Erreur de chargement', table, error.message); state[key] = []; continue; }
    state[key] = (data||[]).map(r=>mapRow(table,r));
  }
  state.journal.sort((a,b)=>new Date(b.date)-new Date(a.date));
  state.ventes.sort((a,b)=>new Date(b.date)-new Date(a.date));

  if(!state.currentMagasinId){
    const u = currentUser();
    let preferred = '';
    try{ preferred = localStorage.getItem('lakouwon-magasin-pref') || ''; }catch(e){}
    if(preferred && state.magasins.some(m=>m.id===preferred)) state.currentMagasinId = preferred;
    else if(u && u.magasinId && state.magasins.some(m=>m.id===u.magasinId)) state.currentMagasinId = u.magasinId;
    else if(state.magasins[0]) state.currentMagasinId = state.magasins[0].id;
  }
  applyTheme();
  supabase.rpc('rpc_auto_archive_produits_inactifs').then(({error})=>{ if(error) console.warn(error.message); });
  persistOfflineCache();
  return true;
}

function subscribeRealtime(){
  if(realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase.channel('lakouwon-sync');
  realtimeChannel.on('postgres_changes', {event:'*', schema:'public', table:'settings'}, payload=>{
    if(payload.new) state.settings = mapRow('settings', payload.new);
    applyTheme(); render();
  });
  for(const table of DATA_TABLES){
    realtimeChannel.on('postgres_changes', {event:'*', schema:'public', table}, payload=>applyRealtimeEvent(table,payload));
  }
  realtimeChannel.subscribe();
}
function applyRealtimeEvent(table, payload){
  const key = TABLE_TO_STATE_KEY[table];
  const arr = state[key];
  if(payload.eventType==='INSERT'){
    const row = mapRow(table, payload.new);
    if(!arr.some(x=>x.id===row.id)) arr.push(row);
  } else if(payload.eventType==='UPDATE'){
    const row = mapRow(table, payload.new);
    const idx = arr.findIndex(x=>x.id===row.id);
    if(idx>=0) arr[idx] = row; else arr.push(row);
  } else if(payload.eventType==='DELETE'){
    const oldId = payload.old.id;
    state[key] = arr.filter(x=>x.id!==oldId);
  }
  if(table==='ventes') state.ventes.sort((a,b)=>new Date(b.date)-new Date(a.date));
  if(table==='journal') state.journal.sort((a,b)=>new Date(b.date)-new Date(a.date));
  persistOfflineCache();
  render();
}

function upsertRow(table, row){
  if(!row) return null;
  const key = TABLE_TO_STATE_KEY[table];
  const mapped = mapRow(table, row);
  if(key==='settings'){ state.settings = mapped; persistOfflineCache(); return mapped; }
  const arr = state[key];
  const idx = arr.findIndex(x=>x.id===mapped.id);
  if(idx>=0) arr[idx] = mapped; else arr.push(mapped);
  persistOfflineCache();
  return mapped;
}
function removeRow(table, id){
  const key = TABLE_TO_STATE_KEY[table];
  state[key] = state[key].filter(x=>x.id!==id);
  persistOfflineCache();
}

async function logAction(action, details){
  const employe = currentUser();
  if(!employe) return;
  const { error } = await supabase.from('journal').insert({
    action, details: details||'', employe_id: employe.id, magasin_id: state.currentMagasinId||null
  });
  if(error) console.warn('Journal:', error.message);
}

/* =========================================================
   PANIER DE VENTE PERSISTANT — pour ne pas perdre une vente en
   cours si la page se ferme/rafraîchit par accident (coupure de
   courant, onglet fermé par erreur...).
========================================================= */
const CART_DRAFT_KEY = 'lakouwon_cart_draft_v1';
function persistCartDraft(){
  try{
    if(editingVenteId){ return; } // ne jamais écraser une modification de fiche en cours
    if(!cart || cart.length===0){ localStorage.removeItem(CART_DRAFT_KEY); return; }
    localStorage.setItem(CART_DRAFT_KEY, JSON.stringify({
      cart, posClientId, posPayMode, posDepositMode, posMontantRecu, posRemiseType, posRemiseValeur, posEncaissementPartiel,
      magasinId: state.currentMagasinId, savedAt: Date.now(),
    }));
  }catch(e){}
}
function restoreCartDraft(){
  try{
    const raw = localStorage.getItem(CART_DRAFT_KEY);
    if(!raw) return;
    const d = JSON.parse(raw);
    if(!d || !Array.isArray(d.cart) || d.cart.length===0) return;
    if(d.magasinId && d.magasinId !== state.currentMagasinId) return;
    cart = d.cart;
    posClientId = d.posClientId||''; posPayMode = d.posPayMode||'cash'; posDepositMode = d.posDepositMode||'cash';
    posMontantRecu = d.posMontantRecu||0; posRemiseType = d.posRemiseType||'montant'; posRemiseValeur = d.posRemiseValeur||0;
    posEncaissementPartiel = !!d.posEncaissementPartiel;
    showToast('Panier en cours restauré (vente inachevée précédemment)');
  }catch(e){}
}

/* =========================================================
   INVENTAIRE PHYSIQUE — comptage en cours conservé par magasin
   pour ne pas perdre le travail en cas de fermeture accidentelle.
========================================================= */
const INVENTAIRE_DRAFT_KEY = 'lakouwon_inventaire_draft_v1';
function persistInventaireDraft(){
  try{
    const cle = Object.keys(inventaireComptages).length;
    if(!cle){ localStorage.removeItem(INVENTAIRE_DRAFT_KEY); return; }
    localStorage.setItem(INVENTAIRE_DRAFT_KEY, JSON.stringify({
      magasinId: state.currentMagasinId, comptages: inventaireComptages, savedAt: Date.now(),
    }));
  }catch(e){}
}
function restoreInventaireDraft(){
  try{
    const raw = localStorage.getItem(INVENTAIRE_DRAFT_KEY);
    if(!raw) return;
    const d = JSON.parse(raw);
    if(!d || d.magasinId !== state.currentMagasinId || !d.comptages) return;
    inventaireComptages = d.comptages;
  }catch(e){}
}

/* =========================================================
   MODE HORS-LIGNE — l'appareil garde en mémoire (localStorage)
   les dernières données reçues du serveur, pour pouvoir afficher
   l'application et continuer à vendre même sans connexion. Les
   ventes faites hors-ligne sont mises en file d'attente et
   envoyées automatiquement au retour de la connexion (voir
   finalizeSale/syncOfflineQueue dans events.js et plus bas).
   Les autres actions (produits, transferts, employés...) restent
   en ligne uniquement : trop risqué à rejouer sans savoir si
   l'état côté serveur a changé entre-temps.
========================================================= */
const OFFLINE_CACHE_KEY = 'lakouwon_offline_cache_v1';
const OFFLINE_QUEUE_KEY = 'lakouwon_offline_queue_v1';
let offlineMode = !navigator.onLine;
let installPromptEvent = null;

function isNetworkError(err){
  if(!err) return false;
  if(!navigator.onLine) return true;
  const msg = ((err.message||'')+'').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed') || msg.includes('network request failed');
}

function persistOfflineCache(){
  try{
    localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify({ state, cachedAt: Date.now() }));
  }catch(e){ /* stockage plein ou indisponible : tant pis, pas critique */ }
}
function tryRestoreOfflineCache(){
  try{
    const raw = localStorage.getItem(OFFLINE_CACHE_KEY);
    if(!raw) return false;
    const parsed = JSON.parse(raw);
    if(!parsed || !parsed.state) return false;
    state = parsed.state;
    return true;
  }catch(e){ return false; }
}

function loadOfflineQueue(){
  try{ return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); }catch(e){ return []; }
}
function saveOfflineQueue(queue){
  try{ localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue)); }catch(e){}
}
function queueOfflineSale(clientRef, params){
  const queue = loadOfflineQueue();
  queue.push({ clientRef, params, queuedAt: Date.now() });
  saveOfflineQueue(queue);
  persistOfflineCache();
}

async function syncOfflineQueue(){
  const queue = loadOfflineQueue();
  if(queue.length===0) return;
  const remaining = [];
  let synced = 0, failed = 0;
  for(const item of queue){
    const result = await supabase.rpc('rpc_finalize_sale', item.params);
    if(result.error){
      if(isNetworkError(result.error)){ remaining.push(item); continue; }
      remaining.push({...item, failed:true, errorMessage: friendlyError(result.error)});
      failed++;
      continue;
    }
    removeRow('ventes', item.clientRef);
    upsertRow('ventes', result.data);
    synced++;
  }
  saveOfflineQueue(remaining);
  if(synced>0) showToast(`${synced} vente(s) hors-ligne synchronisée(s) avec succès.`);
  if(failed>0) showToast(`⚠ ${failed} vente(s) hors-ligne n'ont pas pu être synchronisées (voir Paramètres) — vérifiez le stock concerné.`);
  persistOfflineCache();
  render();
}

function setupConnectivityListeners(){
  window.addEventListener('offline', ()=>{ offlineMode = true; render(); });
  window.addEventListener('online', async ()=>{
    offlineMode = false;
    render();
    if(!loginState.loggedIn) return;
    try{ await loadAllData(); subscribeRealtime(); }catch(e){ /* on retentera au prochain événement online */ }
    await syncOfflineQueue();
  });
}

// Le navigateur propose normalement l'installation via une icône discrète
// dans la barre d'adresse — on intercepte l'événement pour afficher à la
// place un bouton bien visible dans l'app (comme le bouton "Nouvelle vente").
// Ne fonctionne que sur Chrome/Edge/Android ; Safari (iPhone/iPad) n'a pas
// cet événement et garde son propre bouton Partager → "Sur l'écran d'accueil".
function setupInstallPromptListener(){
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    installPromptEvent = e;
    render();
  });
  window.addEventListener('appinstalled', ()=>{
    installPromptEvent = null;
    render();
  });
}
function isAppInstalled(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;
}
async function promptInstall(){
  if(!installPromptEvent) return;
  installPromptEvent.prompt();
  await installPromptEvent.userChoice;
  installPromptEvent = null;
  render();
}

/* =========================================================
   AUTHENTIFICATION
========================================================= */
async function refreshEmployeFromSession(){
  const { data: { session } } = await supabase.auth.getSession();
  if(!session){ loginState.loggedIn = false; return; }
  const { data: emp, error } = await supabase.from('employes').select('*').eq('auth_user_id', session.user.id).maybeSingle();
  if(error && isNetworkError(error)){
    // Hors-ligne au démarrage : on garde la session ouverte, l'employé et le
    // reste des données seront repris du cache local par loadAllData().
    loginState.loggedIn = true;
    return;
  }
  if(error || !emp || !emp.actif){
    await supabase.auth.signOut();
    loginState.loggedIn = false;
    loginError = (emp && !emp.actif) ? 'Ce compte est désactivé.' : '';
    return;
  }
  const mapped = mapRow('employes', emp);
  const idx = state.employes.findIndex(e=>e.id===mapped.id);
  if(idx>=0) state.employes[idx] = mapped; else state.employes.push(mapped);
  state.currentUserId = mapped.id;
  loginState.loggedIn = true;
}

async function doLogin(email, password){
  if(Date.now() < loginLockUntil){
    const secs = Math.ceil((loginLockUntil-Date.now())/1000);
    loginError = `Trop de tentatives échouées. Réessayez dans ${secs} seconde(s).`;
    render(); return;
  }
  busy = true; render();
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  busy = false;
  if(error){
    loginAttempts++;
    if(loginAttempts>=5){
      loginLockUntil = Date.now()+30000; loginAttempts = 0;
      loginError = 'Trop de tentatives échouées. Compte verrouillé 30 secondes.';
    } else {
      loginError = 'Identifiants invalides.';
    }
    render(); return;
  }
  loginAttempts = 0; loginError = '';
  await bootAfterAuth();
}

async function doLogout(){
  if(realtimeChannel){ supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
  await supabase.auth.signOut();
  loginState.loggedIn = false;
  state = emptyState();
  await loadPublicBranding();
  render();
}

async function bootAfterAuth(withLoad=true){
  await refreshEmployeFromSession();
  if(loginState.loggedIn){
    if(withLoad) await loadAllData();
    subscribeRealtime();
    logAction('Connexion', currentUser()?.nom||'');
    restoreCartDraft();
    restoreInventaireDraft();
  }
  render();
}

/* =========================================================
   RENDU RACINE
========================================================= */
async function checkBootstrapNeeded(){
  const { data, error } = await supabase.rpc('rpc_needs_bootstrap');
  if(error){ console.error(error.message); bootstrapNeeded = false; return; }
  bootstrapNeeded = !!data;
}

async function loadPublicBranding(){
  const { data } = await supabase.rpc('rpc_public_branding');
  const row = Array.isArray(data) ? data[0] : data;
  if(row){
    state.settings.nomCommerce = row.nom_commerce || state.settings.nomCommerce;
    state.settings.logo = row.logo_url || state.settings.logo;
    state.settings.couleurPrimaire = row.couleur_primaire || state.settings.couleurPrimaire;
    state.settings.couleurAccent = row.couleur_accent || state.settings.couleurAccent;
    applyTheme();
  }
}

let confirmState = null;
function askConfirm(message, onYes, danger, onNo){
  confirmState = {message, onYes, onNo, danger: danger!==false};
  render();
}
function renderConfirmDialog(){
  if(!confirmState) return '';
  return `<div class="overlay" id="confirm-overlay" style="z-index:300;"><div class="modal" style="max-width:400px;">
    <p style="font-size:14px; margin:0 0 18px; line-height:1.5;">${confirmState.message}</p>
    <div class="modal-actions"><button class="btn" id="btn-confirm-no">Annuler</button><button class="btn ${confirmState.danger?'btn-danger':'btn-primary'}" id="btn-confirm-yes">Confirmer</button></div>
  </div></div>`;
}

function render(){
  const app = document.getElementById('app');
  if(bootstrapNeeded){ app.innerHTML = renderSetup(); attachSetupEvents(); return; }
  if(!loginState.loggedIn){ app.innerHTML = renderLogin(); attachLoginEvents(); return; }
  persistCartDraft();
  app.innerHTML = `
    <button class="mobile-topbar-toggle" id="btn-toggle-sidebar" aria-label="Ouvrir le menu">☰</button>
    <div class="sidebar-overlay ${mobileSidebarOpen?'show':''}" id="sidebar-overlay"></div>
    ${renderSidebar()}
    <div class="main">
      ${toast? `<div style="position:fixed;top:18px;right:18px;background:var(--navy);color:#fff;padding:11px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:var(--shadow);z-index:100;">${toast}</div>`:''}
      ${renderView()}
    </div>
    ${view!=='vente' && can('vente') ? `<button class="fab-vente" id="btn-fab-vente" title="Nouvelle vente">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="9" cy="21" r="1.4" fill="#fff" stroke="none"></circle>
        <circle cx="18.5" cy="21" r="1.4" fill="#fff" stroke="none"></circle>
        <path d="M2.5 3h2.4l1.9 11.6a2 2 0 0 0 2 1.7h8.4a2 2 0 0 0 1.97-1.63L20.8 7.3H6.1"></path>
      </svg>
    </button>` : ''}
    ${installPromptEvent && !isAppInstalled() ? `<button class="fab-install" id="btn-fab-install" title="Installer l'application">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M4 19h16"></path>
      </svg>
      <span>Installer l'app</span>
    </button>` : ''}
    ${editing? renderModal(ctx()) : ''}
    ${confirmState? renderConfirmDialog() : ''}
  `;
  attachEvents();
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  if(btnToggleSidebar) btnToggleSidebar.onclick = ()=>{ mobileSidebarOpen = true; render(); };
  const btnCloseSidebar = document.getElementById('btn-close-sidebar');
  if(btnCloseSidebar) btnCloseSidebar.onclick = ()=>{ mobileSidebarOpen = false; render(); };
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  if(sidebarOverlay) sidebarOverlay.onclick = ()=>{ mobileSidebarOpen = false; render(); };
  const btnConfirmYes = document.getElementById('btn-confirm-yes');
  if(btnConfirmYes) btnConfirmYes.onclick = ()=>{ const cb = confirmState.onYes; confirmState=null; render(); if(cb) cb(); };
  const btnConfirmNo = document.getElementById('btn-confirm-no');
  if(btnConfirmNo) btnConfirmNo.onclick = ()=>{ const cbNo = confirmState.onNo; confirmState=null; render(); if(cbNo) cbNo(); };
  const btnFabVente = document.getElementById('btn-fab-vente');
  if(btnFabVente) btnFabVente.onclick = ()=>{ view = 'vente'; render(); };
  const btnFabInstall = document.getElementById('btn-fab-install');
  if(btnFabInstall) btnFabInstall.onclick = ()=> promptInstall();
}

function renderSetup(){
  return `
  <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--paper); padding:20px;">
    <div class="panel" style="max-width:420px; width:100%;">
      <h2 style="margin-top:0;">Configuration initiale</h2>
      <p class="muted" style="margin-top:-6px;">Créez le compte administrateur principal. Ceci protège l'accès à votre système partagé.</p>
      ${loginError? `<div style="background:var(--red-bg); color:var(--red); padding:9px 12px; border-radius:8px; font-size:13px; margin-bottom:12px;">${loginError}</div>`:''}
      <div class="field"><label>Nom</label><input id="setup-nom" value="Administrateur"></div>
      <div class="field"><label>Adresse email</label><input id="setup-email" type="email" placeholder="admin@moncommerce.com"></div>
      <div class="field"><label>Mot de passe</label><input id="setup-password" type="password"></div>
      <div class="field"><label>Confirmer le mot de passe</label><input id="setup-password2" type="password"></div>
      <button class="btn btn-primary" id="btn-setup" style="width:100%; justify-content:center; padding:11px;" ${busy?'disabled':''}>${busy?'Création...':'Créer le compte administrateur'}</button>
    </div>
  </div>`;
}
function attachSetupEvents(){
  const btn = document.getElementById('btn-setup');
  if(btn) btn.onclick = async ()=>{
    const nom = document.getElementById('setup-nom').value.trim();
    const email = document.getElementById('setup-email').value.trim().toLowerCase();
    const pw = document.getElementById('setup-password').value;
    const pw2 = document.getElementById('setup-password2').value;
    if(!nom || !email || !pw){ loginError='Tous les champs sont requis.'; render(); return; }
    if(pw!==pw2){ loginError='Les mots de passe ne correspondent pas.'; render(); return; }
    if(pw.length<6){ loginError='Le mot de passe doit contenir au moins 6 caractères.'; render(); return; }
    busy = true; loginError=''; render();

    let { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email, password: pw });
    if(signUpError && /already registered|already exists/i.test(signUpError.message||'')){
      // Une tentative précédente a créé le compte Auth sans terminer l'insertion
      // dans employes (ex: erreur réseau) — on retente une simple connexion.
      const signInRes = await supabase.auth.signInWithPassword({ email, password: pw });
      if(signInRes.error){
        busy = false;
        loginError = `Un compte existe déjà pour cet email mais avec un autre mot de passe. Supprimez-le dans Supabase (Authentication → Users → ${email} → Delete) puis recommencez.`;
        render();
        return;
      }
      signUpData = signInRes.data; signUpError = null;
    }
    if(signUpError){ busy=false; loginError = friendlyError(signUpError); render(); return; }
    if(!signUpData.session){
      busy = false;
      loginError = "Compte créé, mais aucune session n'a été ouverte automatiquement — désactivez \"Confirm email\" dans Supabase (Authentication → Providers → Email) puis réessayez, ou confirmez l'email reçu avant de vous reconnecter normalement.";
      render();
      return;
    }

    const { error: insertError } = await supabase.from('employes').insert({
      auth_user_id: signUpData.user.id, nom, email, role: 'Admin', actif: true,
      permissions: PERMS_ALL,
    });
    if(insertError){
      busy = false;
      loginError = friendlyError(insertError);
      render();
      return;
    }
    busy = false;
    bootstrapNeeded = false;
    await bootAfterAuth();
  };
}

function renderLogin(){
  return `
  <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--paper); padding:20px;">
    <div class="panel" style="max-width:380px; width:100%;">
      <h2 style="margin-top:0;">${state.settings.nomCommerce}</h2>
      <p class="muted" style="margin-top:-6px;">Connexion sécurisée</p>
      ${loginError? `<div style="background:var(--red-bg); color:var(--red); padding:9px 12px; border-radius:8px; font-size:13px; margin-bottom:12px;">${loginError}</div>`:''}
      <div class="field"><label>Adresse email</label><input id="login-email" type="email" placeholder="votre@email.com"></div>
      <div class="field"><label>Mot de passe</label><input id="login-password" type="password"></div>
      <button class="btn btn-primary" id="btn-login" style="width:100%; justify-content:center; padding:11px;" ${busy?'disabled':''}>${busy?'Connexion...':'Se connecter'}</button>
    </div>
  </div>`;
}
function attachLoginEvents(){
  const submit = ()=>{
    const email = document.getElementById('login-email').value;
    const pw = document.getElementById('login-password').value;
    doLogin(email, pw);
  };
  const btn = document.getElementById('btn-login'); if(btn) btn.onclick = submit;
  const pwInp = document.getElementById('login-password'); if(pwInp) pwInp.onkeydown = e=>{ if(e.key==='Enter') submit(); };
}

function connectivityBannerHTML(){
  const isOffline = offlineMode || !navigator.onLine;
  const pending = loadOfflineQueue().length;
  if(!isOffline && pending===0) return '';
  if(isOffline){
    return `<div style="margin:0 16px 10px; padding:8px 10px; border-radius:8px; background:var(--red-bg); color:var(--red); font-size:12px; font-weight:700;">
      🔴 Hors ligne${pending>0? ` — ${pending} vente(s) en attente d'envoi` : ' — les ventes seront synchronisées au retour d\'internet'}
    </div>`;
  }
  return `<div style="margin:0 16px 10px; padding:8px 10px; border-radius:8px; background:var(--amber-bg); color:var(--amber); font-size:12px; font-weight:700;">
    🟡 Synchronisation de ${pending} vente(s) en cours...
  </div>`;
}

function renderSidebar(){
  const u = currentUser();
  const sections = [
    {label:null, items:[['dashboard','📊','Tableau de bord']]},
    {label:'Ventes', items:[['vente','🛒','Nouvelle vente'],['fiches','🧾','Fiches de vente'],['proforma','📄','Proforma']]},
    {label:'Stock', items:[['produits','📦','Produits & Stock'],['inventaire','📋','Inventaire physique','produits'],['transferts','🔄','Transfert entre magasins'],['achats','📥','Journal d\'achat']]},
    {label:'Finances', items:[['clients','👥','Clients & Dettes'],['caisse','💵','Caisse'],['depenses','💸','Dépenses'],['rapport','📅','Rapport journalier']]},
    {label:'Administration', items:[['employes','🧑‍💼','Employés & Paie'],['journal','📜','Journal'],['parametres','⚙️','Paramètres']]},
  ].map(s=>({...s, items:s.items.filter(l=>can(l[3]||l[0]))})).filter(s=>s.items.length>0);
  const stockBasCount = magasinProduitsActifs().filter(p=>stockUnites(p) <= (p.stockMinimum||0)).length;
  return `
  <div class="sidebar ${mobileSidebarOpen?'open':''}" id="sidebar">
    <div class="brand">
      ${state.settings.logo? `<img src="${state.settings.logo}" class="brand-logo">` : ''}
      <div><div class="brand-name">${state.settings.nomCommerce}</div><div class="brand-sub">Système de gestion POS</div></div>
      <button class="sidebar-close" id="btn-close-sidebar" aria-label="Fermer le menu">✕</button>
    </div>
    <div class="store-select"><label>Magasin actif</label>
      <select id="sel-magasin">${state.magasins.map(m=>`<option value="${m.id}" ${m.id===state.currentMagasinId?'selected':''}>${m.nom}</option>`).join('')}</select>
    </div>
    <nav class="navlinks">${sections.map(s=>`
      ${s.label? `<div class="navsection-label">${s.label}</div>` : ''}
      ${s.items.map(([id,ic,label])=>`<button class="navlink ${view===id?'active':''}" data-view="${id}"><span class="ic">${ic}</span>${label}${id==='produits' && stockBasCount>0 ? `<span class="navlink-badge">${stockBasCount}</span>` : ''}</button>`).join('')}
    `).join('')}</nav>
    ${connectivityBannerHTML()}
    <div class="sidebar-foot">
      Connecté : <b>${u?u.nom:''}</b><br>${u?u.role:''}
      ${u && u.role==='Admin' ? `<button class="btn btn-sm" id="btn-change-password" style="width:100%; justify-content:center; margin-top:10px;">🔑 Changer mon mot de passe</button>` : ''}
      <button class="btn btn-sm" id="btn-logout" style="width:100%; justify-content:center; margin-top:6px;">🔒 Se déconnecter</button>
    </div>
  </div>`;
}

function renderView(){
  const fns = {dashboard:renderDashboard, vente:renderVente, fiches:renderFiches, proforma:renderProforma,
    produits:renderProduits, inventaire:renderInventaire, clients:renderClients, caisse:renderCaisse, depenses:renderDepenses, rapport:renderRapport,
    transferts:renderTransfertsRoot, achats:renderAchats, employes:renderEmployes, journal:renderJournal, parametres:renderParametres};
  return fns[view] ? fns[view](ctx()) : '';
}

/* =========================================================
   HELPERS DE FILTRAGE PAR MAGASIN
========================================================= */
function magasinProduits(){ return state.produits.filter(p=>p.magasinId===state.currentMagasinId); }
function magasinProduitsActifs(){ return magasinProduits().filter(p=>!p.archive); }
function magasinClients(){ return state.clients.filter(c=>c.magasinId===state.currentMagasinId); }
function magasinVentes(){ return state.ventes.filter(v=>v.magasinId===state.currentMagasinId); }
function magasinCaisse(){ return state.caisseMovements.filter(m=>m.magasinId===state.currentMagasinId); }
function magasinEmployes(){ return state.employes.filter(e=>e.magasinId===state.currentMagasinId); }
function magasinProformas(){ return state.proformas.filter(p=>p.magasinId===state.currentMagasinId); }
function magasinAchats(){ return state.achats.filter(a=>a.magasinId===state.currentMagasinId).slice().sort((a,b)=>new Date(b.date)-new Date(a.date)); }

function ventesPeriode(){ const start = periodBounds(period); return magasinVentes().filter(v=>new Date(v.date)>=start); }
function clientDette(clientId){ return state.ventes.filter(v=>v.clientId===clientId).reduce((s,v)=>s+(v.reste||0),0); }
function totalDettesMagasin(){ return magasinClients().reduce((s,c)=>s+clientDette(c.id),0); }
function valeurStock(){ return magasinProduits().reduce((s,p)=>s+(stockUnites(p)*coutUnitaire(p)),0); }
function soldeCaisse(){ return magasinCaisse().reduce((s,m)=>s+(m.type==='entree'?m.montant:-m.montant),0); }
function isDepense(m){ return m.type==='sortie' && (m.source==='manuel' || m.source==='payroll'); }
function kpisPeriode(){
  const ventes = ventesPeriode();
  const ca = ventes.reduce((s,v)=>s+v.total,0);
  const cmv = ventes.reduce((s,v)=>s+v.coutTotal,0);
  const margeBrute = ca-cmv;
  const margePctv = ca>0? (margeBrute/ca*100) : 0;
  const start = periodBounds(period);
  const depenses = magasinCaisse().filter(m=>isDepense(m) && new Date(m.date)>=start).reduce((s,m)=>s+m.montant,0);
  const beneficeNet = margeBrute - depenses;
  return {ca, cmv, margeBrute, margePct:margePctv, depenses, beneficeNet};
}
function empName(id){ const e = state.employes.find(x=>x.id===id); return e? e.nom : '—'; }
function clientName(id){ const c = state.clients.find(x=>x.id===id); return c? c.nom : 'Client comptant'; }
function joursDepuisDerniereVente(produitId){
  let dernier = null;
  state.ventes.forEach(v=>{ (v.items||[]).forEach(i=>{ if(i.produitId===produitId){ const d=new Date(v.date); if(!dernier||d>dernier) dernier=d; } }); });
  if(!dernier) return null;
  return Math.floor((Date.now()-dernier.getTime())/(1000*60*60*24));
}

import { attachAllEvents } from "./events.js";
import { renderDashboard, renderVente, renderFiches, renderProforma, renderProduits, renderInventaire, renderClients, renderCaisse,
  renderDepenses, renderRapport, renderTransfertsRoot, renderAchats, renderEmployes, renderJournal, renderParametres,
  renderModal, generateReceiptHTML, generateProformaHTML } from "./views.js";

function printReceipt(vente){ editing = {type:'receiptPreview', html: generateReceiptHTML(ctx(), vente)}; render(); }
function printProforma(pf){ editing = {type:'receiptPreview', html: generateProformaHTML(ctx(), pf)}; render(); }

// Export CSV (ouvrable dans Excel) — séparateur point-virgule, adapté aux
// réglages régionaux français (Excel FR sépare les colonnes par ; ).
function exportCSV(filename, headers, rows){
  const escape = v => {
    const s = (v===null||v===undefined) ? '' : String(v);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  };
  const lines = [headers.map(escape).join(';'), ...rows.map(r=>r.map(escape).join(';'))];
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function attachEvents(){ attachAllEvents(ctx()); }

/* =========================================================
   CONTEXTE PARTAGÉ — passé aux modules de vue/événements pour
   éviter les imports circulaires tout en gardant un seul état.
========================================================= */
function ctx(){
  return {
    supabase, state, get view(){return view;}, set view(v){view=v;},
    get period(){return period;}, set period(v){period=v;},
    get editing(){return editing;}, set editing(v){editing=v;},
    get cart(){return cart;}, set cart(v){cart=v;},
    get posClientId(){return posClientId;}, set posClientId(v){posClientId=v;},
    get posPayMode(){return posPayMode;}, set posPayMode(v){posPayMode=v;},
    get posDepositMode(){return posDepositMode;}, set posDepositMode(v){posDepositMode=v;},
    get posMontantRecu(){return posMontantRecu;}, set posMontantRecu(v){posMontantRecu=v;},
    get posRemiseType(){return posRemiseType;}, set posRemiseType(v){posRemiseType=v;},
    get posRemiseValeur(){return posRemiseValeur;}, set posRemiseValeur(v){posRemiseValeur=v;},
    get posEncaissementPartiel(){return posEncaissementPartiel;}, set posEncaissementPartiel(v){posEncaissementPartiel=v;},
    get proformaView(){return proformaView;}, set proformaView(v){proformaView=v;},
    get proformaCart(){return proformaCart;}, set proformaCart(v){proformaCart=v;},
    get proformaClientId(){return proformaClientId;}, set proformaClientId(v){proformaClientId=v;},
    get proformaClientNomLibre(){return proformaClientNomLibre;}, set proformaClientNomLibre(v){proformaClientNomLibre=v;},
    get proformaNotes(){return proformaNotes;}, set proformaNotes(v){proformaNotes=v;},
    get ficheSearch(){return ficheSearch;}, set ficheSearch(v){ficheSearch=v;},
    get ficheFiltreDateDebut(){return ficheFiltreDateDebut;}, set ficheFiltreDateDebut(v){ficheFiltreDateDebut=v;},
    get ficheFiltreDateFin(){return ficheFiltreDateFin;}, set ficheFiltreDateFin(v){ficheFiltreDateFin=v;},
    get ficheFiltreMode(){return ficheFiltreMode;}, set ficheFiltreMode(v){ficheFiltreMode=v;},
    get ficheFiltreEmployeId(){return ficheFiltreEmployeId;}, set ficheFiltreEmployeId(v){ficheFiltreEmployeId=v;},
    get achatFiltreDateDebut(){return achatFiltreDateDebut;}, set achatFiltreDateDebut(v){achatFiltreDateDebut=v;},
    get achatFiltreDateFin(){return achatFiltreDateFin;}, set achatFiltreDateFin(v){achatFiltreDateFin=v;},
    get caisseFiltreDateDebut(){return caisseFiltreDateDebut;}, set caisseFiltreDateDebut(v){caisseFiltreDateDebut=v;},
    get caisseFiltreDateFin(){return caisseFiltreDateFin;}, set caisseFiltreDateFin(v){caisseFiltreDateFin=v;},
    get achatCart(){return achatCart;}, set achatCart(v){achatCart=v;},
    get achatDate(){return achatDate;}, set achatDate(v){achatDate=v;},
    get achatFournisseur(){return achatFournisseur;}, set achatFournisseur(v){achatFournisseur=v;},
    get inventaireSearch(){return inventaireSearch;}, set inventaireSearch(v){inventaireSearch=v;},
    get inventaireComptages(){return inventaireComptages;}, set inventaireComptages(v){inventaireComptages=v;},
    persistInventaireDraft,
    get productLotsDraft(){return productLotsDraft;}, set productLotsDraft(v){productLotsDraft=v;},
    get permissionsDraft(){return permissionsDraft;}, set permissionsDraft(v){permissionsDraft=v;},
    get dashboardSearchQuery(){return dashboardSearchQuery;}, set dashboardSearchQuery(v){dashboardSearchQuery=v;},
    get rapportDate(){return rapportDate;}, set rapportDate(v){rapportDate=v;},
    get magasinLogoDraft(){return magasinLogoDraft;}, set magasinLogoDraft(v){magasinLogoDraft=v;},
    get transfertView(){return transfertView;}, set transfertView(v){transfertView=v;},
    get transfertSourceId(){return transfertSourceId;}, set transfertSourceId(v){transfertSourceId=v;},
    get transfertDestId(){return transfertDestId;}, set transfertDestId(v){transfertDestId=v;},
    get transfertCart(){return transfertCart;}, set transfertCart(v){transfertCart=v;},
    get produitsFiltre(){return produitsFiltre;}, set produitsFiltre(v){produitsFiltre=v;},
    get editingVenteId(){return editingVenteId;}, set editingVenteId(v){editingVenteId=v;},
    get editingVenteNumero(){return editingVenteNumero;}, set editingVenteNumero(v){editingVenteNumero=v;},
    get generatedPasswordPreview(){return generatedPasswordPreview;}, set generatedPasswordPreview(v){generatedPasswordPreview=v;},
    get changePwError(){return changePwError;}, set changePwError(v){changePwError=v;},
    get busy(){return busy;}, set busy(v){busy=v;},
    render, showToast, askConfirm, logAction, friendlyError, edgeFunctionErrorMessage,
    currentUser, isAdminConnecte, can, empName, clientName,
    magasinProduits, magasinProduitsActifs, magasinClients, magasinVentes, magasinCaisse, magasinEmployes,
    magasinProformas, magasinAchats, ventesPeriode, clientDette, totalDettesMagasin, valeurStock, soldeCaisse,
    isDepense, kpisPeriode, joursDepuisDerniereVente,
    coutUnitaire, stockUnites, margePct, unitsConsumed, cartTotal, cartCost, remiseMontant, venteTotalNet, remiseSummaryHTML,
    fmt, money, nowStr, uid, applyTheme, shadeColor, THEME_PRESETS, PERMS_ALL, PERMS_LABELS, PERMS_PRESETS,
    SEUIL_ARCHIVAGE_JOURS, periodBounds, printReceipt, printProforma, doLogout,
    upsertRow, removeRow, mapRow,
    get offlineMode(){return offlineMode;},
    isNetworkError, queueOfflineSale, loadOfflineQueue, saveOfflineQueue, persistOfflineCache, syncOfflineQueue,
    withBusyButton, exportCSV,
    get mobileSidebarOpen(){return mobileSidebarOpen;}, set mobileSidebarOpen(v){mobileSidebarOpen=v;},
    get installPromptEvent(){return installPromptEvent;}, isAppInstalled, promptInstall,
  };
}

document.addEventListener('wheel', ()=>{
  if(document.activeElement && document.activeElement.type==='number') document.activeElement.blur();
}, { passive:true });

// Enregistré tout de suite (pas dans boot()) car l'événement peut être
// déclenché par le navigateur avant même la fin du chargement de l'app.
setupInstallPromptListener();

/* =========================================================
   DÉMARRAGE
========================================================= */
async function boot(){
  setupConnectivityListeners();
  try{
    await checkBootstrapNeeded();
    if(!bootstrapNeeded){
      await refreshEmployeFromSession();
      if(loginState.loggedIn){
        const ok = await loadAllData();
        if(ok) subscribeRealtime();
        else if(tryRestoreOfflineCache()) offlineMode = true;
        restoreCartDraft();
        restoreInventaireDraft();
      }
      else { await loadPublicBranding(); }
    }
  }catch(e){
    // Démarrage hors-ligne inattendu (ex: session expirée sans réseau pour la
    // renouveler) : on tente de retomber sur les dernières données connues
    // plutôt que de laisser l'application planter sur un écran vide.
    if(tryRestoreOfflineCache()){ offlineMode = true; loginState.loggedIn = true; }
  }
  render();

  supabase.auth.onAuthStateChange((event)=>{
    if(event==='SIGNED_OUT'){ loginState.loggedIn=false; state=emptyState(); render(); }
  });
}
boot();
