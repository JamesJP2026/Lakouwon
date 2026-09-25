/* =========================================================
   ÉVÉNEMENTS — équivalent de attachEvents() dans l'app d'origine,
   avec les mutations de state remplacées par des appels Supabase
   (CRUD direct pour les tables simples, RPC pour les opérations
   qui doivent rester atomiques : ventes, transferts, achats,
   paiements, salaires — voir supabase/functions.sql).
========================================================= */
import { fichesTableHTML, searchFichesEtProformas, renderSearchResults, todayISOLocal,
  lotsEditorHTML, produitLiveInfoHTML, lotMarginText, cvDynamicHTML, cvValiderDisabled,
  fichesFiltrees, achatsFiltres, rapportDuJour,
  generateStockPrintHTML, generateInventairePrintHTML } from "./views.js";

export function attachAllEvents(ctx){
  const { state, supabase } = ctx;

  document.querySelectorAll('.navlink').forEach(b=>b.onclick = ()=>{ ctx.view = b.dataset.view; ctx.mobileSidebarOpen = false; ctx.render(); });
  const selMag = document.getElementById('sel-magasin');
  if(selMag) selMag.onchange = e=>{
    state.currentMagasinId = e.target.value;
    try{ localStorage.setItem('lakouwon-magasin-pref', state.currentMagasinId); }catch(err){}
    ctx.render();
  };
  const btnLogout = document.getElementById('btn-logout'); if(btnLogout) btnLogout.onclick = ()=> ctx.doLogout();
  const btnChangePw = document.getElementById('btn-change-password');
  if(btnChangePw) btnChangePw.onclick = ()=>{ if(!ctx.isAdminConnecte()) return; ctx.changePwError=''; ctx.editing={type:'changePassword'}; ctx.render(); };
  const btnSaveChangePw = document.getElementById('btn-save-change-password');
  if(btnSaveChangePw) btnSaveChangePw.onclick = async ()=>{
    const newPw = document.getElementById('cp-new').value;
    const newPw2 = document.getElementById('cp-new2').value;
    if(newPw.length<6){ ctx.changePwError='Le nouveau mot de passe doit contenir au moins 6 caractères.'; ctx.render(); return; }
    if(newPw!==newPw2){ ctx.changePwError='Les nouveaux mots de passe ne correspondent pas.'; ctx.render(); return; }
    const { error } = await supabase.auth.updateUser({ password: newPw });
    if(error){ ctx.changePwError = ctx.friendlyError(error); ctx.render(); return; }
    ctx.logAction('Mot de passe changé', ctx.currentUser()?.nom||'');
    ctx.editing=null; ctx.showToast('Mot de passe mis à jour'); ctx.render();
  };
  document.querySelectorAll('.period-tab').forEach(b=>b.onclick = ()=>{ ctx.period = b.dataset.period; ctx.render(); });
  const rapportDateInp = document.getElementById('rapport-date'); if(rapportDateInp) rapportDateInp.onchange = e=>{ ctx.rapportDate = e.target.value; ctx.render(); };
  const btnExportRapport = document.getElementById('btn-export-rapport');
  if(btnExportRapport) btnExportRapport.onclick = ()=>{
    const dateStr = ctx.rapportDate || todayISOLocal();
    const r = rapportDuJour(ctx, dateStr);
    ctx.exportCSV(`rapport-${dateStr}.csv`,
      ['Numéro','Heure','Client','Mode de paiement','Total','Payé','Reste'],
      r.ventes.map(v=>[v.numero, new Date(v.date).toLocaleTimeString('fr-FR'), v.clientId?ctx.clientName(v.clientId):'Comptant', v.modePaiement, v.total, v.montantPaye, v.reste])
    );
  };
  const globalSearch = document.getElementById('global-search');
  if(globalSearch){
    const wireSearchOpen = ()=>document.querySelectorAll('[data-search-open]').forEach(b=>b.onclick = ()=>{
      const [t,id] = b.dataset.searchOpen.split(':');
      ctx.editing = {type: t==='vente'?'voirVente':'voirProforma', id};
      ctx.render();
    });
    globalSearch.oninput = ()=>{
      ctx.dashboardSearchQuery = globalSearch.value;
      const results = searchFichesEtProformas(ctx, ctx.dashboardSearchQuery);
      document.getElementById('global-search-results').innerHTML = renderSearchResults(ctx, results, ctx.dashboardSearchQuery);
      wireSearchOpen();
    };
    wireSearchOpen();
  }

  /* ---------------- Vente / POS ---------------- */
  document.querySelectorAll('[data-add-detail]').forEach(b=>b.onclick = ()=> addToCart(ctx, b.dataset.addDetail));
  document.querySelectorAll('[data-lot-add]').forEach(sel=>sel.onchange = ()=>{
    if(sel.value) addLotToCart(ctx, sel.dataset.lotAdd, sel.value);
    sel.value = '';
  });
  document.querySelectorAll('[data-remove]').forEach(b=>b.onclick = ()=>{ ctx.cart.splice(+b.dataset.remove,1); ctx.render(); });
  document.querySelectorAll('[data-qty]').forEach(inp=>inp.onchange = ()=>{
    const idx = +inp.dataset.qty; const item = ctx.cart[idx]; const p = state.produits.find(x=>x.id===item.produitId);
    let val = Math.max(1, parseInt(inp.value)||1);
    const autres = ctx.cart.reduce((s,i,ix)=> ix!==idx && i.produitId===item.produitId ? s+ctx.unitsConsumed(i) : s, 0);
    const dispoUnites = p ? ctx.stockUnites(p)-autres : val*item.uniteParLot;
    const maxQte = Math.max(1, Math.floor(dispoUnites/item.uniteParLot));
    if(val>maxQte) val = maxQte;
    item.qte = val; ctx.render();
  });
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick = ()=>{ ctx.posPayMode = b.dataset.mode; ctx.render(); });
  const btnEncaisser = document.getElementById('btn-encaisser');
  if(btnEncaisser) btnEncaisser.onclick = ()=>{
    if(ctx.cart.length===0) return;
    syncCartPrices(ctx);
    ctx.posEncaissementPartiel = ctx.posPayMode==='credit';
    ctx.posMontantRecu = ctx.posPayMode==='credit' ? 0 : ctx.venteTotalNet();
    ctx.posDepositMode = (ctx.posPayMode==='cash'||ctx.posPayMode==='banque'||ctx.posPayMode==='moncash') ? ctx.posPayMode : 'cash';
    ctx.editing = {type:'confirmVente'};
    ctx.render();
  };
  const prodSearch = document.getElementById('prod-search');
  if(prodSearch) prodSearch.oninput = ()=>{
    const q = prodSearch.value.toLowerCase();
    document.querySelectorAll('#prod-pick .prod-card').forEach(c=>{ c.style.display = c.dataset.name.includes(q) ? '' : 'none'; });
  };
  const btnAnnulerModifVente = document.getElementById('btn-annuler-modif-vente');
  if(btnAnnulerModifVente) btnAnnulerModifVente.onclick = ()=>{
    ctx.askConfirm('Annuler la modification ? La fiche originale reste inchangée (rien n\'a encore été enregistré).', ()=>{
      ctx.editingVenteId=null; ctx.editingVenteNumero=null;
      ctx.cart=[]; ctx.posPayMode='cash'; ctx.posClientId=''; ctx.posRemiseType='montant'; ctx.posRemiseValeur=0;
      ctx.view = 'fiches'; ctx.render();
    });
  };
  const remiseType = document.getElementById('remise-type');
  if(remiseType) remiseType.onchange = e=>{
    ctx.posRemiseType = e.target.value;
    const sum = document.getElementById('remise-summary'); if(sum) sum.innerHTML = ctx.remiseSummaryHTML();
  };
  const remiseValeur = document.getElementById('remise-valeur');
  if(remiseValeur) remiseValeur.oninput = e=>{
    ctx.posRemiseValeur = Math.max(0, parseFloat(e.target.value)||0);
    const sum = document.getElementById('remise-summary'); if(sum) sum.innerHTML = ctx.remiseSummaryHTML();
  };

  /* ---------------- Confirmation vente ---------------- */
  const cvPartial = document.getElementById('cv-partial'); if(cvPartial) cvPartial.onchange = e=>{
    ctx.posEncaissementPartiel = e.target.checked;
    if(!ctx.posEncaissementPartiel) ctx.posMontantRecu = ctx.venteTotalNet();
    ctx.render();
  };
  const fMontantRecu = document.getElementById('f-montant-recu');
  if(fMontantRecu) fMontantRecu.oninput = e=>{
    ctx.posMontantRecu = Math.max(0, parseFloat(e.target.value)||0);
    const dyn = document.getElementById('cv-dynamic');
    if(dyn){ dyn.innerHTML = cvDynamicHTML(ctx); attachCvDynamicEvents(ctx); }
    const btn = document.getElementById('btn-valider-vente'); if(btn) btn.disabled = cvValiderDisabled(ctx);
  };
  const fDepositMode = document.getElementById('f-deposit-mode'); if(fDepositMode) fDepositMode.onchange = e=>ctx.posDepositMode = e.target.value;
  attachCvDynamicEvents(ctx);
  const btnValiderVente = document.getElementById('btn-valider-vente'); if(btnValiderVente) btnValiderVente.onclick = ()=> finalizeSale(ctx, ctx.posMontantRecu);

  /* ---------------- Fiches ---------------- */
  const refreshFichesTable = ()=>{
    const wrap = document.getElementById('fiches-table-wrap');
    if(wrap){ wrap.innerHTML = fichesTableHTML(ctx); attachFichesTableEvents(ctx); }
  };
  const ficheSearchInp = document.getElementById('fiche-search');
  if(ficheSearchInp) ficheSearchInp.oninput = e=>{ ctx.ficheSearch = e.target.value; refreshFichesTable(); };
  const ficheDateDebutInp = document.getElementById('fiche-filtre-date-debut');
  if(ficheDateDebutInp) ficheDateDebutInp.onchange = e=>{ ctx.ficheFiltreDateDebut = e.target.value; refreshFichesTable(); };
  const ficheDateFinInp = document.getElementById('fiche-filtre-date-fin');
  if(ficheDateFinInp) ficheDateFinInp.onchange = e=>{ ctx.ficheFiltreDateFin = e.target.value; refreshFichesTable(); };
  const ficheModeInp = document.getElementById('fiche-filtre-mode');
  if(ficheModeInp) ficheModeInp.onchange = e=>{ ctx.ficheFiltreMode = e.target.value; refreshFichesTable(); };
  const ficheEmployeInp = document.getElementById('fiche-filtre-employe');
  if(ficheEmployeInp) ficheEmployeInp.onchange = e=>{ ctx.ficheFiltreEmployeId = e.target.value; refreshFichesTable(); };
  const btnResetFiltresFiches = document.getElementById('btn-reset-filtres-fiches');
  if(btnResetFiltresFiches) btnResetFiltresFiches.onclick = ()=>{
    ctx.ficheSearch=''; ctx.ficheFiltreDateDebut=''; ctx.ficheFiltreDateFin=''; ctx.ficheFiltreMode=''; ctx.ficheFiltreEmployeId='';
    ctx.render();
  };
  const btnExportFiches = document.getElementById('btn-export-fiches');
  if(btnExportFiches) btnExportFiches.onclick = ()=>{
    ctx.exportCSV('fiches-de-vente.csv',
      ['Numéro','Date','Client','Mode de paiement','Total','Payé','Reste'],
      fichesFiltrees(ctx).map(v=>[v.numero, new Date(v.date).toLocaleString('fr-FR'), v.clientId?ctx.clientName(v.clientId):'Comptant', v.modePaiement, v.total, v.montantPaye, v.reste])
    );
  };
  attachFichesTableEvents(ctx);
  const btnPayVente = document.getElementById('btn-pay-vente'); if(btnPayVente) btnPayVente.onclick = ()=>{ ctx.editing={type:'payVente', id:ctx.editing.id}; ctx.render(); };
  const btnReprint = document.getElementById('btn-reprint-vente'); if(btnReprint) btnReprint.onclick = ()=>{ ctx.printReceipt(state.ventes.find(x=>x.id===ctx.editing.id)); };
  const btnModifierVente = document.getElementById('btn-modifier-vente');
  if(btnModifierVente) btnModifierVente.onclick = ()=>{ if(ctx.isAdminConnecte()) commencerModificationVente(ctx, ctx.editing.id); };
  const btnSupprVenteModal = document.getElementById('btn-suppr-vente');
  if(btnSupprVenteModal) btnSupprVenteModal.onclick = ()=>{
    if(!ctx.isAdminConnecte()) return;
    const v = state.ventes.find(x=>x.id===ctx.editing.id);
    ctx.askConfirm(`Supprimer définitivement la fiche ${v.numero} ? Le stock sera restitué et les mouvements de caisse associés seront retirés.`, async ()=>{
      await deleteVente(ctx, v.id);
    });
  };
  document.querySelectorAll('[data-modifier-vente]').forEach(b=>b.onclick = ()=>{ if(ctx.isAdminConnecte()) commencerModificationVente(ctx, b.dataset.modifierVente); });
  document.querySelectorAll('[data-suppr-vente]').forEach(b=>b.onclick = ()=>{
    if(!ctx.isAdminConnecte()) return;
    const v = state.ventes.find(x=>x.id===b.dataset.supprVente);
    ctx.askConfirm(`Supprimer définitivement la fiche ${v.numero} ? Le stock sera restitué et les mouvements de caisse associés seront retirés.`, async ()=>{
      await deleteVente(ctx, v.id);
    });
  });
  const btnSavePayVente = document.getElementById('btn-save-payvente');
  if(btnSavePayVente) btnSavePayVente.onclick = async ()=>{
    const montant = parseFloat(document.getElementById('f-montant').value)||0;
    const mode = document.getElementById('f-mode').value;
    if(montant<=0){ ctx.showToast('Montant invalide'); return; }
    const { data, error } = await supabase.rpc('rpc_pay_vente', { p_vente_id: ctx.editing.id, p_montant: montant, p_mode: mode });
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    ctx.upsertRow('ventes', data);
    ctx.showToast('Paiement enregistré');
    ctx.editing = {type:'voirVente', id:ctx.editing.id}; ctx.render();
  };

  /* ---------------- Produits ---------------- */
  document.querySelectorAll('[data-produits-filtre]').forEach(b=>b.onclick = ()=>{ ctx.produitsFiltre = b.dataset.produitsFiltre; ctx.render(); });
  const produitsSearch = document.getElementById('produits-search');
  if(produitsSearch) produitsSearch.oninput = ()=>{
    const q = produitsSearch.value.toLowerCase();
    document.querySelectorAll('#product-grid .product-card').forEach(c=>{ c.style.display = c.dataset.name.includes(q) ? '' : 'none'; });
  };
  const btnCatFilterTous = document.getElementById('btn-cat-filter-tous');
  if(btnCatFilterTous) btnCatFilterTous.onclick = ()=>{
    if(produitsSearch) produitsSearch.value = '';
    document.querySelectorAll('#product-grid .product-card').forEach(c=>{ c.style.display = ''; });
    document.getElementById('product-grid')?.scrollIntoView({ behavior:'smooth', block:'start' });
  };
  document.querySelectorAll('[data-cat-filter]').forEach(b=>b.onclick = ()=>{
    if(produitsSearch) produitsSearch.value = '';
    const cat = b.dataset.catFilter;
    document.querySelectorAll('#product-grid .product-card').forEach(c=>{ c.style.display = c.dataset.cat===cat ? '' : 'none'; });
    document.getElementById('product-grid')?.scrollIntoView({ behavior:'smooth', block:'start' });
  });
  const btnExportStockCsv = document.getElementById('btn-export-stock-csv');
  if(btnExportStockCsv) btnExportStockCsv.onclick = ()=>{
    ctx.exportCSV('stock.csv',
      ['Produit','Catégorie','Stock (unités)','Prix d\'achat (caisse)','Prix vente détail','Valeur (achat)'],
      ctx.magasinProduitsActifs().map(p=>[p.nom, p.categorie||'', ctx.stockUnites(p), p.prixAchat, p.prixVenteDetail, (ctx.stockUnites(p)*ctx.coutUnitaire(p)).toFixed(2)])
    );
  };
  const btnExportStockPdf = document.getElementById('btn-export-stock-pdf');
  if(btnExportStockPdf) btnExportStockPdf.onclick = ()=>{ ctx.editing = {type:'receiptPreview', html: generateStockPrintHTML(ctx)}; ctx.render(); };
  const btnNewProduit = document.getElementById('btn-new-produit'); if(btnNewProduit) btnNewProduit.onclick = ()=>{ ctx.productLotsDraft=[]; ctx.editing={type:'produit', id:null}; ctx.render(); };
  document.querySelectorAll('[data-edit-produit]').forEach(b=>b.onclick = ()=>{
    const prod = state.produits.find(x=>x.id===b.dataset.editProduit);
    ctx.productLotsDraft = (prod.lots||[]).filter(l=>l.taille!==prod.quantiteParCaisse).map(l=>({...l}));
    ctx.editing={type:'produit', id:b.dataset.editProduit}; ctx.render();
  });
  document.querySelectorAll('[data-archive-produit]').forEach(b=>b.onclick = async ()=>{
    const p = state.produits.find(x=>x.id===b.dataset.archiveProduit);
    const { error } = await supabase.from('produits').update({archive:true}).eq('id', p.id);
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    p.archive = true; ctx.logAction('Produit archivé manuellement', p.nom); ctx.showToast('Produit archivé'); ctx.render();
  });
  document.querySelectorAll('[data-unarchive-produit]').forEach(b=>b.onclick = async ()=>{
    const p = state.produits.find(x=>x.id===b.dataset.unarchiveProduit);
    const { error } = await supabase.from('produits').update({archive:false}).eq('id', p.id);
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    p.archive = false; ctx.logAction('Produit réactivé', p.nom); ctx.showToast('Produit réactivé'); ctx.render();
  });
  document.querySelectorAll('[data-del-produit]').forEach(b=>b.onclick = ()=>{
    const p = state.produits.find(x=>x.id===b.dataset.delProduit);
    ctx.askConfirm(`Supprimer "${p.nom}" ?`, async ()=>{
      const { error } = await supabase.from('produits').delete().eq('id', p.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      state.produits = state.produits.filter(x=>x.id!==p.id);
      ctx.logAction('Produit supprimé', p.nom); ctx.render();
    });
  });

  /* ---------------- Inventaire physique ---------------- */
  const inventaireSearchInp = document.getElementById('inventaire-search');
  if(inventaireSearchInp) inventaireSearchInp.oninput = e=>{ ctx.inventaireSearch = e.target.value; ctx.render(); };
  document.querySelectorAll('[data-inv-input]').forEach(inp=>inp.oninput = ()=>{
    const id = inp.dataset.invInput;
    ctx.inventaireComptages[id] = inp.value;
    ctx.persistInventaireDraft();
    const p = state.produits.find(x=>x.id===id);
    const systeme = ctx.stockUnites(p);
    const compte = inp.value===''? null : parseInt(inp.value)||0;
    const ecart = compte===null? null : compte - systeme;
    const ecartCell = document.querySelector(`[data-inv-ecart="${id}"]`);
    if(ecartCell){
      ecartCell.textContent = ecart===null?'—':(ecart>0?'+':'')+ctx.fmt(ecart);
      ecartCell.style.color = ecart>0?'var(--green)':ecart<0?'var(--red)':'';
      ecartCell.style.fontWeight = ecart? '700':'';
    }
  });
  const btnResetInventaire = document.getElementById('btn-reset-inventaire');
  if(btnResetInventaire) btnResetInventaire.onclick = ()=>{
    ctx.askConfirm('Effacer tout le comptage en cours ?', ()=>{
      ctx.inventaireComptages = {};
      ctx.persistInventaireDraft();
      ctx.render();
    });
  };
  const btnExportInventaireCsv = document.getElementById('btn-export-inventaire-csv');
  if(btnExportInventaireCsv) btnExportInventaireCsv.onclick = ()=>{
    const produits = ctx.magasinProduitsActifs();
    ctx.exportCSV('inventaire-physique.csv',
      ['Produit','Catégorie','Stock système','Compté','Écart'],
      produits.map(p=>{
        const raw = ctx.inventaireComptages[p.id];
        const compte = (raw===''||raw===undefined||raw===null)? '' : parseInt(raw)||0;
        const systeme = ctx.stockUnites(p);
        const ecart = compte===''? '' : compte - systeme;
        return [p.nom, p.categorie||'', systeme, compte, ecart];
      })
    );
  };
  const btnExportInventairePdf = document.getElementById('btn-export-inventaire-pdf');
  if(btnExportInventairePdf) btnExportInventairePdf.onclick = ()=>{ ctx.editing = {type:'receiptPreview', html: generateInventairePrintHTML(ctx)}; ctx.render(); };
  const btnAppliquerInventaire = document.getElementById('btn-appliquer-inventaire');
  if(btnAppliquerInventaire) btnAppliquerInventaire.onclick = ()=>{
    const produits = ctx.magasinProduitsActifs();
    const aAppliquer = produits.filter(p=>{
      const raw = ctx.inventaireComptages[p.id];
      return raw!==''&&raw!==undefined&&raw!==null;
    });
    if(aAppliquer.length===0){ ctx.showToast('Aucune quantité comptée à appliquer'); return; }
    ctx.askConfirm(`Mettre à jour le stock de ${aAppliquer.length} produit(s) selon le comptage ? Cette action est irréversible et remplace le stock système actuel. À faire de préférence quand les ventes sont arrêtées, pour éviter d'écraser une vente en cours ailleurs.`, async ()=>{
      let ok = 0, echecs = 0;
      for(const p of aAppliquer){
        const compte = Math.max(0, parseInt(ctx.inventaireComptages[p.id])||0);
        const qpc = Math.max(p.quantiteParCaisse||1, 1);
        const quantiteCaisse = Math.floor(compte / qpc);
        const quantiteDetail = compte % qpc;
        const { error } = await supabase.from('produits').update({ quantite_caisse: quantiteCaisse, quantite_detail: quantiteDetail }).eq('id', p.id);
        if(error){ echecs++; continue; }
        p.quantiteCaisse = quantiteCaisse; p.quantiteDetail = quantiteDetail;
        ok++;
      }
      await ctx.logAction('Inventaire physique appliqué', `${ok} produit(s) ajusté(s)${echecs?`, ${echecs} échec(s)`:''}`);
      ctx.inventaireComptages = {};
      ctx.persistInventaireDraft();
      ctx.showToast(`Stock mis à jour pour ${ok} produit(s)${echecs?` (${echecs} échec(s))`:''}`);
      ctx.render();
    });
  };

  /* ---------------- Clients ---------------- */
  const btnNewClient = document.getElementById('btn-new-client'); if(btnNewClient) btnNewClient.onclick = ()=>{ ctx.editing={type:'client', id:null}; ctx.render(); };
  document.querySelectorAll('[data-edit-client]').forEach(b=>b.onclick = ()=>{ ctx.editing={type:'client', id:b.dataset.editClient}; ctx.render(); });
  document.querySelectorAll('[data-del-client]').forEach(b=>b.onclick = ()=>{
    const c = state.clients.find(x=>x.id===b.dataset.delClient);
    ctx.askConfirm(`Supprimer "${c.nom}" ?`, async ()=>{
      const { error } = await supabase.from('clients').delete().eq('id', c.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      state.clients = state.clients.filter(x=>x.id!==c.id);
      ctx.logAction('Client supprimé', c.nom); ctx.render();
    });
  });
  document.querySelectorAll('[data-pay-dette]').forEach(b=>b.onclick = ()=>{ ctx.editing={type:'payDette', id:b.dataset.payDette}; ctx.render(); });

  /* ---------------- Employés ---------------- */
  const btnNewEmp = document.getElementById('btn-new-employe'); if(btnNewEmp) btnNewEmp.onclick = ()=>{ ctx.permissionsDraft = ctx.PERMS_PRESETS.Caissier.slice(); ctx.generatedPasswordPreview=''; ctx.editing={type:'employe', id:null}; ctx.render(); };
  document.querySelectorAll('[data-edit-employe]').forEach(b=>b.onclick = ()=>{
    const emp = state.employes.find(x=>x.id===b.dataset.editEmploye);
    ctx.permissionsDraft = (emp.permissions || ctx.PERMS_PRESETS[emp.role] || []).slice();
    ctx.generatedPasswordPreview='';
    ctx.editing={type:'employe', id:b.dataset.editEmploye}; ctx.render();
  });
  document.querySelectorAll('[data-del-employe]').forEach(b=>b.onclick = ()=>{
    const em = state.employes.find(x=>x.id===b.dataset.delEmploye);
    if(state.employes.length<=1){ ctx.showToast('Impossible de supprimer le dernier employé'); return; }
    ctx.askConfirm(`Supprimer "${em.nom}" ?`, async ()=>{
      const { error } = await supabase.from('employes').delete().eq('id', em.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      state.employes = state.employes.filter(x=>x.id!==em.id);
      ctx.logAction('Employé supprimé', em.nom); ctx.render();
    });
  });
  document.querySelectorAll('[data-pay-salaire]').forEach(b=>b.onclick = ()=>{ ctx.editing={type:'paySalaire', id:b.dataset.paySalaire}; ctx.render(); });

  /* ---------------- Caisse / Dépenses ---------------- */
  const btnCE = document.getElementById('btn-caisse-entree'); if(btnCE) btnCE.onclick = ()=>{ ctx.editing={type:'caisseMouvement', mode:'entree'}; ctx.render(); };
  const btnCS = document.getElementById('btn-caisse-sortie'); if(btnCS) btnCS.onclick = ()=>{ ctx.editing={type:'caisseMouvement', mode:'sortie'}; ctx.render(); };
  const btnNewDepense = document.getElementById('btn-new-depense'); if(btnNewDepense) btnNewDepense.onclick = ()=>{ ctx.editing={type:'caisseMouvement', mode:'sortie'}; ctx.render(); };
  const caisseDateDebutInp = document.getElementById('caisse-filtre-date-debut');
  if(caisseDateDebutInp) caisseDateDebutInp.onchange = e=>{ ctx.caisseFiltreDateDebut = e.target.value; ctx.render(); };
  const caisseDateFinInp = document.getElementById('caisse-filtre-date-fin');
  if(caisseDateFinInp) caisseDateFinInp.onchange = e=>{ ctx.caisseFiltreDateFin = e.target.value; ctx.render(); };
  const btnResetFiltresCaisse = document.getElementById('btn-reset-filtres-caisse');
  if(btnResetFiltresCaisse) btnResetFiltresCaisse.onclick = ()=>{ ctx.caisseFiltreDateDebut=''; ctx.caisseFiltreDateFin=''; ctx.render(); };

  /* ---------------- Journal d'achat ---------------- */
  const btnNewAchat = document.getElementById('btn-new-achat'); if(btnNewAchat) btnNewAchat.onclick = ()=>{
    ctx.achatCart = []; ctx.achatDate = todayISOLocal(); ctx.achatFournisseur = '';
    ctx.editing={type:'achat'}; ctx.render();
  };
  const achatDateDebutInp = document.getElementById('achat-filtre-date-debut');
  if(achatDateDebutInp) achatDateDebutInp.onchange = e=>{ ctx.achatFiltreDateDebut = e.target.value; ctx.render(); };
  const achatDateFinInp = document.getElementById('achat-filtre-date-fin');
  if(achatDateFinInp) achatDateFinInp.onchange = e=>{ ctx.achatFiltreDateFin = e.target.value; ctx.render(); };
  const btnResetFiltresAchats = document.getElementById('btn-reset-filtres-achats');
  if(btnResetFiltresAchats) btnResetFiltresAchats.onclick = ()=>{ ctx.achatFiltreDateDebut=''; ctx.achatFiltreDateFin=''; ctx.render(); };
  const btnExportAchats = document.getElementById('btn-export-achats');
  if(btnExportAchats) btnExportAchats.onclick = ()=>{
    ctx.exportCSV('achats.csv',
      ['Date','Produit','Fournisseur','Quantité','Prix unitaire','Total','Employé'],
      achatsFiltres(ctx).map(a=>[new Date(a.date).toLocaleDateString('fr-FR'), a.nom, a.fournisseur||'', a.quantite, a.quantite>0?(a.prixTotal/a.quantite).toFixed(2):0, a.prixTotal, ctx.empName(a.employeId)])
    );
  };
  document.querySelectorAll('[data-voir-achat]').forEach(b=>b.onclick = ()=>{ ctx.editing={type:'voirAchat', id:b.dataset.voirAchat}; ctx.render(); });
  document.querySelectorAll('[data-del-achat-groupe]').forEach(b=>b.onclick = ()=>{
    const cle = b.dataset.delAchatGroupe;
    ctx.askConfirm("Supprimer cet achat du journal ? (le stock déjà ajouté ne sera pas retiré automatiquement)", async ()=>{
      const { error } = await supabase.from('achats').delete().or(`id.eq.${cle},achat_groupe_id.eq.${cle}`);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      state.achats = state.achats.filter(x=>x.id!==cle && x.achatGroupeId!==cle);
      ctx.render();
    });
  });

  const fAchatDate = document.getElementById('f-achat-date'); if(fAchatDate) fAchatDate.oninput = e=>{ ctx.achatDate = e.target.value; };
  const fAchatFournisseur = document.getElementById('f-achat-fournisseur'); if(fAchatFournisseur) fAchatFournisseur.oninput = e=>{ ctx.achatFournisseur = e.target.value; };
  const btnAddAchatLigne = document.getElementById('btn-add-achat-ligne');
  if(btnAddAchatLigne) btnAddAchatLigne.onclick = ()=>{
    const produitId = document.getElementById('f-achat-ligne-produit').value;
    const p = state.produits.find(x=>x.id===produitId);
    if(!p){ ctx.showToast('Sélectionnez un produit'); return; }
    const quantite = parseInt(document.getElementById('f-achat-ligne-quantite').value)||0;
    const prixTotal = parseFloat(document.getElementById('f-achat-ligne-prixtotal').value)||0;
    if(quantite<=0){ ctx.showToast('Quantité invalide'); return; }
    ctx.achatCart.push({ produitId, nom:p.nom, quantite, prixTotal });
    ctx.render();
  };
  document.querySelectorAll('[data-remove-achat-ligne]').forEach(b=>b.onclick = ()=>{
    ctx.achatCart.splice(+b.dataset.removeAchatLigne, 1);
    ctx.render();
  });
  const btnSaveAchat = document.getElementById('btn-save-achat');
  if(btnSaveAchat) btnSaveAchat.onclick = ()=> ctx.withBusyButton(btnSaveAchat, async ()=>{
    if(ctx.achatCart.length===0){ ctx.showToast('Ajoutez au moins un produit à la liste'); return; }
    const dateVal = document.getElementById('f-achat-date').value || todayISOLocal();
    const fournisseur = document.getElementById('f-achat-fournisseur').value.trim();
    const { data, error } = await supabase.rpc('rpc_add_achats_groupe', {
      p_magasin_id: state.currentMagasinId, p_date: dateVal, p_fournisseur: fournisseur,
      p_items: ctx.achatCart.map(i=>({produit_id:i.produitId, quantite:i.quantite, prix_total:i.prixTotal}))
    });
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    (data||[]).forEach(row=>{
      ctx.upsertRow('achats', row);
      const p = state.produits.find(x=>x.id===row.produit_id);
      if(p) p.quantiteDetail = (p.quantiteDetail||0) + row.quantite;
    });
    ctx.achatCart = [];
    ctx.editing=null; ctx.showToast('Achat enregistré et stock mis à jour'); ctx.render();
  });

  /* ---------------- Transfert entre magasins ---------------- */
  const btnNewTransfert = document.getElementById('btn-new-transfert');
  if(btnNewTransfert) btnNewTransfert.onclick = ()=>{
    ctx.transfertSourceId = state.currentMagasinId;
    const autre = state.magasins.find(m=>m.id!==ctx.transfertSourceId);
    ctx.transfertDestId = autre ? autre.id : '';
    ctx.transfertCart = [];
    ctx.transfertView = 'nouveau';
    ctx.render();
  };
  const btnTransfertRetour = document.getElementById('btn-transfert-retour'); if(btnTransfertRetour) btnTransfertRetour.onclick = ()=>{ ctx.transfertView='liste'; ctx.render(); };
  const transfertSourceSel = document.getElementById('transfert-source');
  if(transfertSourceSel) transfertSourceSel.onchange = e=>{
    ctx.transfertSourceId = e.target.value;
    if(ctx.transfertDestId===ctx.transfertSourceId) ctx.transfertDestId='';
    ctx.transfertCart = [];
    ctx.render();
  };
  const transfertDestSel = document.getElementById('transfert-dest'); if(transfertDestSel) transfertDestSel.onchange = e=>{ ctx.transfertDestId = e.target.value; ctx.render(); };
  document.querySelectorAll('[data-transfert-add]').forEach(b=>b.onclick = ()=> ajouterAuTransfert(ctx, b.dataset.transfertAdd));
  document.querySelectorAll('[data-transfert-remove]').forEach(b=>b.onclick = ()=>{ ctx.transfertCart.splice(+b.dataset.transfertRemove,1); ctx.render(); });
  document.querySelectorAll('[data-transfert-qty]').forEach(inp=>inp.onchange = ()=>{
    const idx = +inp.dataset.transfertQty; const item = ctx.transfertCart[idx];
    const p = state.produits.find(x=>x.id===item.produitId);
    let val = Math.max(1, parseInt(inp.value)||1);
    const autres = ctx.transfertCart.reduce((s,i,ix)=> ix!==idx && i.produitId===item.produitId ? s+i.qte : s, 0);
    const dispo = p ? ctx.stockUnites(p)-autres : val;
    if(val>dispo) val = Math.max(1, dispo);
    item.qte = val; ctx.render();
  });
  const btnOpenConfirmTransfert = document.getElementById('btn-open-confirm-transfert');
  if(btnOpenConfirmTransfert) btnOpenConfirmTransfert.onclick = ()=>{
    if(ctx.transfertCart.length===0 || !ctx.transfertDestId || ctx.transfertDestId===ctx.transfertSourceId) return;
    ctx.editing = {type:'confirmTransfert'}; ctx.render();
  };
  const btnValiderTransfert = document.getElementById('btn-valider-transfert'); if(btnValiderTransfert) btnValiderTransfert.onclick = ()=> executeTransfert(ctx);
  document.querySelectorAll('[data-confirmer-transfert]').forEach(b=>b.onclick = ()=>{
    ctx.askConfirm('Confirmer la réception de ce transfert ? Le stock sera ajouté à ce magasin.', ()=> confirmerTransfert(ctx, b.dataset.confirmerTransfert));
  });
  document.querySelectorAll('[data-annuler-transfert]').forEach(b=>b.onclick = ()=>{
    ctx.askConfirm('Annuler ce transfert ? Le stock sera restitué au magasin source.', ()=> annulerTransfert(ctx, b.dataset.annulerTransfert));
  });

  /* ---------------- Paramètres ---------------- */
  const btnRetryOfflineSync = document.getElementById('btn-retry-offline-sync');
  if(btnRetryOfflineSync) btnRetryOfflineSync.onclick = async ()=>{
    if(!navigator.onLine){ ctx.showToast('Toujours hors-ligne — réessayez une fois la connexion internet rétablie.'); return; }
    await ctx.syncOfflineQueue();
  };

  async function saveTheme(navy, gold){
    const { error } = await supabase.from('settings').update({ couleur_primaire: navy, couleur_accent: gold }).eq('id',1);
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    state.settings.couleurPrimaire = navy; state.settings.couleurAccent = gold;
    ctx.applyTheme(); ctx.showToast('Couleurs appliquées'); ctx.render();
  }
  const btnSaveTheme = document.getElementById('btn-save-theme');
  if(btnSaveTheme) btnSaveTheme.onclick = ()=>{
    const navy = document.getElementById('set-couleur-primaire').value;
    const gold = document.getElementById('set-couleur-accent').value;
    saveTheme(navy, gold);
  };
  document.querySelectorAll('[data-theme-navy]').forEach(b=>b.onclick = ()=> saveTheme(b.dataset.themeNavy, b.dataset.themeGold));

  const btnSaveSettings = document.getElementById('btn-save-settings');
  if(btnSaveSettings) btnSaveSettings.onclick = ()=> ctx.withBusyButton(btnSaveSettings, async ()=>{
    const nom_commerce = document.getElementById('set-nom').value || state.settings.nomCommerce;
    const adresse = document.getElementById('set-adresse').value.trim();
    const telephone = document.getElementById('set-telephone').value.trim();
    const email = document.getElementById('set-email').value.trim();
    const devise = document.getElementById('set-devise').value;
    const { error } = await supabase.from('settings').update({ nom_commerce, adresse, telephone, email, devise }).eq('id',1);
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    Object.assign(state.settings, { nomCommerce:nom_commerce, adresse, telephone, email, devise });
    ctx.logAction('Paramètres modifiés','');
    ctx.showToast('Paramètres enregistrés'); ctx.render();
  });
  const setLogo = document.getElementById('set-logo');
  if(setLogo) setLogo.onchange = e=>{
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = async ()=>{
      const { error } = await supabase.from('settings').update({ logo_url: reader.result }).eq('id',1);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      state.settings.logo = reader.result; ctx.showToast('Logo mis à jour'); ctx.render();
    };
    reader.readAsDataURL(file);
  };
  const btnNewMag = document.getElementById('btn-new-magasin'); if(btnNewMag) btnNewMag.onclick = ()=>{ ctx.magasinLogoDraft=null; ctx.editing={type:'magasin'}; ctx.render(); };
  const btnAddCategorie = document.getElementById('btn-add-categorie');
  if(btnAddCategorie) btnAddCategorie.onclick = async ()=>{
    const input = document.getElementById('new-categorie-nom');
    const nom = input.value.trim();
    if(!nom){ ctx.showToast('Le nom de la catégorie est requis'); return; }
    const { data, error } = await supabase.from('categories').insert({nom}).select().single();
    if(error){ ctx.showToast(error.code==='23505' ? 'Cette catégorie existe déjà' : ctx.friendlyError(error)); return; }
    ctx.upsertRow('categories', data);
    input.value = '';
    ctx.render();
  };
  document.querySelectorAll('[data-del-categorie]').forEach(b=>b.onclick = ()=>{
    const cat = state.categories.find(x=>x.id===b.dataset.delCategorie);
    ctx.askConfirm(`Supprimer la catégorie "${cat.nom}" ? Les produits qui l'utilisent déjà ne seront pas modifiés.`, async ()=>{
      const { error } = await supabase.from('categories').delete().eq('id', cat.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      state.categories = state.categories.filter(x=>x.id!==cat.id);
      ctx.render();
    });
  });
  const btnExportData = document.getElementById('btn-export-data');
  if(btnExportData) btnExportData.onclick = ()=>{
    const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sauvegarde-pos-${todayISOLocal()}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    ctx.logAction('Sauvegarde exportée', '');
  };
  document.querySelectorAll('[data-edit-magasin]').forEach(b=>b.onclick = ()=>{ ctx.magasinLogoDraft=null; ctx.editing={type:'magasin', id:b.dataset.editMagasin}; ctx.render(); });
  const magasinLogoInp = document.getElementById('magasin-logo');
  if(magasinLogoInp) magasinLogoInp.onchange = e=>{
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{ ctx.magasinLogoDraft = reader.result; ctx.render(); };
    reader.readAsDataURL(file);
  };
  document.querySelectorAll('[data-del-magasin]').forEach(b=>b.onclick = ()=>{
    if(state.magasins.length<=1) return;
    const m = state.magasins.find(x=>x.id===b.dataset.delMagasin);
    ctx.askConfirm(`Supprimer le magasin "${m.nom}" et toutes ses données ?`, async ()=>{
      const { error } = await supabase.from('magasins').delete().eq('id', m.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      state.magasins = state.magasins.filter(x=>x.id!==m.id);
      if(state.currentMagasinId===m.id) state.currentMagasinId = state.magasins[0]?.id||'';
      ctx.logAction('Magasin supprimé', m.nom); ctx.render();
    });
  });

  /* ---------------- Proforma ---------------- */
  const btnNewProforma = document.getElementById('btn-new-proforma'); if(btnNewProforma) btnNewProforma.onclick = ()=>{ ctx.proformaCart=[]; ctx.proformaClientId=''; ctx.proformaClientNomLibre=''; ctx.proformaNotes=''; ctx.proformaView='nouvelle'; ctx.render(); };
  const btnProformaRetour = document.getElementById('btn-proforma-retour'); if(btnProformaRetour) btnProformaRetour.onclick = ()=>{ ctx.proformaView='liste'; ctx.render(); };
  document.querySelectorAll('[data-pf-add-detail]').forEach(b=>b.onclick = ()=>{
    const p = state.produits.find(x=>x.id===b.dataset.pfAddDetail);
    const existing = ctx.proformaCart.find(i=>i.produitId===p.id && i.mode==='detail');
    if(existing) existing.qte++; else ctx.proformaCart.push({produitId:p.id, nom:p.nom, mode:'detail', qte:1, prixVente:p.prixVenteDetail, coutUnitaire:ctx.coutUnitaire(p), uniteParLot:1});
    ctx.render();
  });
  document.querySelectorAll('[data-pf-lot-add]').forEach(sel=>sel.onchange = ()=>{
    if(!sel.value){ return; }
    const p = state.produits.find(x=>x.id===sel.dataset.pfLotAdd);
    const lot = (p.lots||[]).find(l=>l.id===sel.value);
    if(lot){
      const existing = ctx.proformaCart.find(i=>i.produitId===p.id && i.mode==='gros' && i.lotId===lot.id);
      if(existing) existing.qte++; else ctx.proformaCart.push({produitId:p.id, nom:`${p.nom} — Lot de ${lot.taille}`, mode:'gros', lotId:lot.id, qte:1, prixVente:lot.prix, coutUnitaire:ctx.coutUnitaire(p)*lot.taille, uniteParLot:lot.taille});
    }
    sel.value=''; ctx.render();
  });
  document.querySelectorAll('[data-pf-remove]').forEach(b=>b.onclick = ()=>{ ctx.proformaCart.splice(+b.dataset.pfRemove,1); ctx.render(); });
  document.querySelectorAll('[data-pf-qty]').forEach(inp=>inp.onchange = ()=>{ ctx.proformaCart[+inp.dataset.pfQty].qte = Math.max(1, parseInt(inp.value)||1); ctx.render(); });
  const pfClient = document.getElementById('pf-client'); if(pfClient) pfClient.onchange = e=>ctx.proformaClientId = e.target.value;
  const pfClientLibre = document.getElementById('pf-client-libre'); if(pfClientLibre) pfClientLibre.oninput = e=>ctx.proformaClientNomLibre = e.target.value;
  const pfNotes = document.getElementById('pf-notes'); if(pfNotes) pfNotes.oninput = e=>ctx.proformaNotes = e.target.value;
  const btnSaveProforma = document.getElementById('btn-save-proforma');
  if(btnSaveProforma) btnSaveProforma.onclick = async ()=>{
    if(ctx.proformaCart.length===0) return;
    const numero = 'PF'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,6).toUpperCase();
    const row = {
      numero, magasin_id: state.currentMagasinId, date: new Date().toISOString(),
      client_id: ctx.proformaClientId||null, client_nom_libre: ctx.proformaClientNomLibre,
      items: ctx.proformaCart.map(i=>({...i})), total: ctx.cartTotal(ctx.proformaCart),
      employe_id: ctx.currentUser().id, notes: ctx.proformaNotes
    };
    const { data, error } = await supabase.from('proformas').insert(row).select().single();
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    const pf = ctx.upsertRow('proformas', data);
    ctx.logAction(`Proforma ${pf.numero} créée`, ctx.money(pf.total));
    ctx.printProforma(pf);
    ctx.proformaView='liste'; ctx.showToast('Proforma enregistrée'); ctx.render();
  };
  document.querySelectorAll('[data-voir-proforma]').forEach(b=>b.onclick = ()=>{ ctx.editing={type:'voirProforma', id:b.dataset.voirProforma}; ctx.render(); });
  document.querySelectorAll('[data-print-proforma]').forEach(b=>b.onclick = ()=> ctx.printProforma(state.proformas.find(x=>x.id===b.dataset.printProforma)));
  document.querySelectorAll('[data-del-proforma]').forEach(b=>b.onclick = ()=>{
    ctx.askConfirm('Supprimer cette proforma ?', async ()=>{
      const { error } = await supabase.from('proformas').delete().eq('id', b.dataset.delProforma);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      state.proformas = state.proformas.filter(x=>x.id!==b.dataset.delProforma);
      ctx.editing=null; ctx.render();
    });
  });
  function convertProformaToVente(pf){
    ctx.cart = pf.items.map(i=>({...i}));
    ctx.posClientId = pf.clientId||''; ctx.posPayMode = pf.clientId? 'credit' : 'cash'; ctx.posMontantRecu=0; ctx.posDepositMode='cash';
    ctx.view='vente'; ctx.editing=null; ctx.showToast('Proforma chargée dans le panier de vente'); ctx.render();
  }
  document.querySelectorAll('[data-convert-proforma]').forEach(b=>b.onclick = ()=> convertProformaToVente(state.proformas.find(x=>x.id===b.dataset.convertProforma)));
  const btnReprintProforma = document.getElementById('btn-reprint-proforma'); if(btnReprintProforma) btnReprintProforma.onclick = ()=> ctx.printProforma(state.proformas.find(x=>x.id===ctx.editing.id));
  const btnConvertProformaModal = document.getElementById('btn-convert-proforma-modal'); if(btnConvertProformaModal) btnConvertProformaModal.onclick = ()=> convertProformaToVente(state.proformas.find(x=>x.id===ctx.editing.id));

  /* ---------------- Générique modale ---------------- */
  const overlay = document.getElementById('overlay');
  if(overlay) overlay.onclick = (e)=>{ if(e.target.id==='overlay'){ ctx.editing=null; ctx.render(); } };
  const btnCancel = document.getElementById('btn-cancel'); if(btnCancel) btnCancel.onclick = ()=>{ ctx.editing=null; ctx.render(); };
  const btnDoPrint = document.getElementById('btn-do-print');
  if(btnDoPrint) btnDoPrint.onclick = ()=>{
    document.getElementById('receipt').innerHTML = ctx.editing.html;
    setTimeout(()=>window.print(), 100);
  };

  /* Aperçu en direct du produit (stock total + marge détail) */
  const liveInfoBox = document.getElementById('live-info-box');
  if(liveInfoBox){
    const qdFixe = ctx.editing.id ? (state.produits.find(x=>x.id===ctx.editing.id).quantiteDetail||0) : 0;
    const updateLive = ()=>{
      const qpc = Math.max(1, parseInt(document.getElementById('f-quantiteParCaisse').value)||1);
      const qc = parseInt(document.getElementById('f-quantiteCaisse').value)||0;
      const pa = parseFloat(document.getElementById('f-prixAchat').value)||0;
      const pvd = parseFloat(document.getElementById('f-prixVenteDetail').value)||0;
      liveInfoBox.innerHTML = produitLiveInfoHTML(ctx, qpc, qc, qdFixe, pa, pvd);
      const grosLabel = document.getElementById('gros-qty-label');
      if(grosLabel) grosLabel.textContent = qpc;
    };
    ['f-quantiteParCaisse','f-quantiteCaisse','f-prixAchat','f-prixVenteDetail'].forEach(id=>{
      const el = document.getElementById(id); if(el) el.oninput = updateLive;
    });
  }
  const btnRecalc = document.getElementById('btn-recalc-stock-initial');
  if(btnRecalc) btnRecalc.onclick = async ()=>{
    const p = state.produits.find(x=>x.id===ctx.editing.id);
    const nouveau = ctx.stockUnites(p);
    const { error } = await supabase.from('produits').update({ stock_initial: nouveau }).eq('id', p.id);
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    p.stockInitial = nouveau;
    ctx.logAction('Stock initial recalculé', `${p.nom} · ${ctx.fmt(nouveau)} unité(s)`);
    ctx.showToast('Stock initial mis à jour'); ctx.render();
  };

  function currentProduitDraft(){
    return (ctx.editing && ctx.editing.id) ? state.produits.find(x=>x.id===ctx.editing.id) : {prixAchat:0, quantiteParCaisse:1};
  }
  if(ctx.editing && ctx.editing.type==='produit'){
    attachLotsEditorEvents(ctx, currentProduitDraft());
    const btnAddLotRow = document.getElementById('btn-add-lot-row');
    if(btnAddLotRow) btnAddLotRow.onclick = ()=>{
      ctx.productLotsDraft.push({id:ctx.uid(), taille:0, prix:0});
      const editor = document.getElementById('lots-editor');
      if(editor){ editor.innerHTML = lotsEditorHTML(ctx, currentProduitDraft()); attachLotsEditorEvents(ctx, currentProduitDraft()); }
    };
    const catSelect = document.getElementById('f-categorie-select');
    const promptNewCategorie = ()=>{
      const nom = (prompt('Nom de la nouvelle catégorie :')||'').trim();
      if(!nom){ catSelect.value = ''; return; }
      const dejaLa = Array.from(catSelect.options).find(o=>o.value.toLowerCase()===nom.toLowerCase());
      if(dejaLa){ catSelect.value = dejaLa.value; return; }
      const option = document.createElement('option');
      option.value = nom; option.textContent = nom;
      catSelect.insertBefore(option, catSelect.querySelector('option[value="__new__"]'));
      catSelect.value = nom;
    };
    if(catSelect){
      catSelect.onchange = ()=>{ if(catSelect.value === '__new__') promptNewCategorie(); };
    }
    const btnCatNewInline = document.getElementById('btn-cat-new-inline');
    if(btnCatNewInline && catSelect){
      btnCatNewInline.onclick = promptNewCategorie;
    }
  }

  const btnSaveProduit = document.getElementById('btn-save-produit');
  if(btnSaveProduit) btnSaveProduit.onclick = ()=> ctx.withBusyButton(btnSaveProduit, async ()=>{
    const nom = document.getElementById('f-nom').value.trim();
    if(!nom){ ctx.showToast('Le nom du produit est requis'); return; }
    const categorie = document.getElementById('f-categorie-select').value === '__new__' ? '' : document.getElementById('f-categorie-select').value;
    const qpc = Math.max(1, parseInt(document.getElementById('f-quantiteParCaisse').value)||1);
    const qcSaisie = Math.max(0, parseFloat(document.getElementById('f-quantiteCaisse').value)||0);
    const quantiteCaisseEntiere = Math.floor(qcSaisie);
    const detailDepuisFraction = Math.round((qcSaisie - quantiteCaisseEntiere) * qpc);
    const data = {
      nom,
      categorie,
      quantite_par_caisse: qpc,
      prix_achat: parseFloat(document.getElementById('f-prixAchat').value)||0,
      quantite_caisse: quantiteCaisseEntiere,
      prix_vente_detail: parseFloat(document.getElementById('f-prixVenteDetail').value)||0,
      stock_minimum: parseInt(document.getElementById('f-stockMinimum').value)||0,
      lots: ctx.productLotsDraft.filter(l=>l.taille>0 && l.prix>=0).map(l=>({id:l.id||ctx.uid(), taille:l.taille, prix:l.prix})),
    };
    if(data.categorie && !state.categories.some(c=>c.nom.toLowerCase()===data.categorie.toLowerCase())){
      const { data: newCat, error: catErr } = await supabase.from('categories').insert({nom:data.categorie}).select().single();
      if(!catErr) ctx.upsertRow('categories', newCat);
    }
    const prixVenteGros = parseFloat(document.getElementById('f-prixVenteGros').value)||0;
    if(prixVenteGros > 0){
      data.lots.push({id:ctx.uid(), taille:data.quantite_par_caisse, prix:prixVenteGros});
    }
    if(ctx.editing.id){
      const produitActuel = state.produits.find(x=>x.id===ctx.editing.id);
      if(detailDepuisFraction>0) data.quantite_detail = (produitActuel.quantiteDetail||0) + detailDepuisFraction;
      const { error } = await supabase.from('produits').update(data).eq('id', ctx.editing.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      Object.assign(produitActuel, {
        nom:data.nom, categorie:data.categorie, quantiteParCaisse:data.quantite_par_caisse, prixAchat:data.prix_achat,
        quantiteCaisse:data.quantite_caisse, prixVenteDetail:data.prix_vente_detail, stockMinimum:data.stock_minimum, lots:data.lots,
        ...(data.quantite_detail!==undefined ? {quantiteDetail:data.quantite_detail} : {})
      });
      ctx.logAction('Produit modifié', data.nom);
    } else {
      data.magasin_id = state.currentMagasinId;
      data.quantite_detail = detailDepuisFraction;
      data.stock_initial = data.quantite_caisse*data.quantite_par_caisse + data.quantite_detail;
      data.archive = false;
      const { data: inserted, error } = await supabase.from('produits').insert(data).select().single();
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      ctx.upsertRow('produits', inserted);
      ctx.logAction('Produit ajouté', data.nom);
    }
    ctx.editing=null; ctx.render();
  });

  const btnSaveClient = document.getElementById('btn-save-client');
  if(btnSaveClient) btnSaveClient.onclick = ()=> ctx.withBusyButton(btnSaveClient, async ()=>{
    const nom = document.getElementById('f-nom').value.trim();
    const telephone = document.getElementById('f-telephone').value.trim();
    if(!nom){ ctx.showToast('Le nom du client est requis'); return; }
    if(ctx.editing.id){
      const { error } = await supabase.from('clients').update({nom, telephone}).eq('id', ctx.editing.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      Object.assign(state.clients.find(x=>x.id===ctx.editing.id), {nom, telephone});
      ctx.logAction('Client modifié', nom);
    } else {
      const { data, error } = await supabase.from('clients').insert({ magasin_id: state.currentMagasinId, nom, telephone }).select().single();
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      ctx.upsertRow('clients', data);
      ctx.logAction('Client ajouté', nom);
    }
    ctx.editing=null; ctx.render();
  });

  document.querySelectorAll('[data-perm]').forEach(cb=>cb.onchange = ()=>{
    const key = cb.dataset.perm;
    if(cb.checked){ if(!ctx.permissionsDraft.includes(key)) ctx.permissionsDraft.push(key); }
    else{ ctx.permissionsDraft = ctx.permissionsDraft.filter(k=>k!==key); }
  });
  const applyPreset = (role)=>{
    ctx.permissionsDraft = ctx.PERMS_PRESETS[role].slice();
    document.querySelectorAll('[data-perm]').forEach(cb=>{ cb.checked = ctx.permissionsDraft.includes(cb.dataset.perm); });
  };
  const btnPresetAdmin = document.getElementById('btn-preset-admin'); if(btnPresetAdmin) btnPresetAdmin.onclick = ()=>applyPreset('Admin');
  const btnPresetGerant = document.getElementById('btn-preset-gerant'); if(btnPresetGerant) btnPresetGerant.onclick = ()=>applyPreset('Gerant');
  const btnPresetCaissier = document.getElementById('btn-preset-caissier'); if(btnPresetCaissier) btnPresetCaissier.onclick = ()=>applyPreset('Caissier');

  const btnGenPw = document.getElementById('btn-generate-password');
  if(btnGenPw) btnGenPw.onclick = async ()=>{
    if(!ctx.isAdminConnecte()){ ctx.showToast('Seul un administrateur peut gérer les mots de passe'); return; }
    const emailVal = document.getElementById('f-email').value.trim();
    if(!emailVal){ ctx.showToast("Renseignez d'abord l'email de l'agent"); return; }
    const { data, error } = await supabase.functions.invoke('admin-employee', { body:{ action:'set_password', employe_id: ctx.editing.id, email: emailVal } });
    if(error || data?.error){ alert(data?.error || await ctx.edgeFunctionErrorMessage(error)); return; }
    ctx.generatedPasswordPreview = data.password;
    const emp = state.employes.find(x=>x.id===ctx.editing.id);
    if(emp) emp.email = emailVal.toLowerCase();
    ctx.render();
  };

  const btnSaveEmploye = document.getElementById('btn-save-employe');
  if(btnSaveEmploye) btnSaveEmploye.onclick = async ()=>{
    const nom = document.getElementById('f-nom').value.trim();
    if(!nom){ ctx.showToast('Le nom est requis'); return; }
    const data = {
      nom,
      role: document.getElementById('f-role').value,
      telephone: document.getElementById('f-telephone').value.trim(),
      email: document.getElementById('f-email').value.trim().toLowerCase(),
      salaire: parseFloat(document.getElementById('f-salaire').value)||0,
      actif: document.getElementById('f-actif').value==='true',
      permissions: ctx.permissionsDraft.slice(),
    };
    if(ctx.editing.id){
      const { error } = await supabase.from('employes').update(data).eq('id', ctx.editing.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      Object.assign(state.employes.find(x=>x.id===ctx.editing.id), data);
      ctx.logAction('Employé modifié', data.nom);
    } else {
      data.magasin_id = state.currentMagasinId;
      const { data: inserted, error } = await supabase.from('employes').insert(data).select().single();
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      ctx.upsertRow('employes', inserted);
      ctx.logAction('Employé ajouté', data.nom);
    }
    ctx.generatedPasswordPreview='';
    ctx.editing=null; ctx.render();
  };

  const btnSavePaydette = document.getElementById('btn-save-paydette');
  if(btnSavePaydette) btnSavePaydette.onclick = ()=> ctx.withBusyButton(btnSavePaydette, async ()=>{
    const montant = parseFloat(document.getElementById('f-montant').value)||0;
    const mode = document.getElementById('f-mode').value;
    if(montant<=0){ ctx.showToast('Montant invalide'); return; }
    const { error } = await supabase.rpc('rpc_pay_client_debt', { p_client_id: ctx.editing.id, p_montant: montant, p_mode: mode });
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    ctx.editing=null; ctx.showToast('Paiement enregistré'); ctx.render();
  });

  const btnSavePaysalaire = document.getElementById('btn-save-paysalaire');
  if(btnSavePaysalaire) btnSavePaysalaire.onclick = async ()=>{
    const montant = parseFloat(document.getElementById('f-montant').value)||0;
    const periode = document.getElementById('f-periode').value.trim();
    const mode = document.getElementById('f-mode').value;
    if(montant<=0){ ctx.showToast('Montant invalide'); return; }
    const { error } = await supabase.rpc('rpc_pay_salaire', { p_magasin_id: state.currentMagasinId, p_employe_id: ctx.editing.id, p_montant: montant, p_periode: periode, p_mode: mode });
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    ctx.editing=null; ctx.showToast('Salaire payé'); ctx.render();
  };

  const btnSaveCaisse = document.getElementById('btn-save-caisse');
  if(btnSaveCaisse) btnSaveCaisse.onclick = async ()=>{
    const motif = document.getElementById('f-motif').value.trim();
    const montant = parseFloat(document.getElementById('f-montant').value)||0;
    if(!motif || montant<=0){ ctx.showToast('Motif et montant requis'); return; }
    const { data, error } = await supabase.from('caisse_movements').insert({
      magasin_id: state.currentMagasinId, type: ctx.editing.mode, montant, motif,
      employe_id: ctx.currentUser().id, source:'manuel'
    }).select().single();
    if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
    ctx.upsertRow('caisse_movements', data);
    ctx.logAction(ctx.editing.mode==='entree'?'Entrée de caisse manuelle':'Sortie de caisse manuelle', `${motif} · ${ctx.money(montant)}`);
    ctx.editing=null; ctx.render();
  };

  const btnSaveMagasin = document.getElementById('btn-save-magasin');
  if(btnSaveMagasin) btnSaveMagasin.onclick = async ()=>{
    const nom = document.getElementById('f-nom').value.trim();
    const adresse = document.getElementById('f-adresse').value.trim();
    const telephone = document.getElementById('f-telephone').value.trim();
    const email = document.getElementById('f-email').value.trim();
    if(!nom){ ctx.showToast('Le nom du magasin est requis'); return; }
    if(ctx.editing.id){
      const m = state.magasins.find(x=>x.id===ctx.editing.id);
      const logo = ctx.magasinLogoDraft!=null ? ctx.magasinLogoDraft : (m.logo||'');
      const { error } = await supabase.from('magasins').update({nom, adresse, telephone, email, logo_url:logo}).eq('id', m.id);
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      Object.assign(m, {nom, adresse, telephone, email, logo});
      ctx.logAction('Magasin modifié', nom);
    } else {
      const logo = ctx.magasinLogoDraft!=null ? ctx.magasinLogoDraft : '';
      const { data, error } = await supabase.from('magasins').insert({nom, adresse, telephone, email, logo_url:logo}).select().single();
      if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
      const mag = ctx.upsertRow('magasins', data);
      state.currentMagasinId = mag.id;
      ctx.logAction('Magasin créé', nom);
    }
    ctx.magasinLogoDraft = null;
    ctx.editing=null; ctx.render();
  };
}

/* =========================================================
   HELPERS D'ÉVÉNEMENTS RE-BRANCHÉS APRÈS UN RE-RENDU PARTIEL
========================================================= */
function attachFichesTableEvents(ctx){
  document.querySelectorAll('[data-voir-vente]').forEach(b=>b.onclick = ()=>{ ctx.editing={type:'voirVente', id:b.dataset.voirVente}; ctx.render(); });
}
function attachCvDynamicEvents(ctx){
  const fCvClient = document.getElementById('f-cv-client');
  if(fCvClient) fCvClient.onchange = e=>{
    ctx.posClientId = e.target.value;
    const dyn = document.getElementById('cv-dynamic'); if(dyn) dyn.innerHTML = cvDynamicHTML(ctx);
    attachCvDynamicEvents(ctx);
    const btn = document.getElementById('btn-valider-vente'); if(btn) btn.disabled = cvValiderDisabled(ctx);
  };
}
function attachLotsEditorEvents(ctx, p){
  document.querySelectorAll('[data-lot-taille]').forEach(inp=>inp.oninput = ()=>{
    const idx = +inp.dataset.lotTaille;
    ctx.productLotsDraft[idx].taille = parseInt(inp.value)||0;
    const span = document.getElementById('lot-margin-'+idx);
    if(span) span.textContent = lotMarginText(ctx, p, ctx.productLotsDraft[idx].taille, ctx.productLotsDraft[idx].prix);
  });
  document.querySelectorAll('[data-lot-fraction]').forEach(inp=>inp.oninput = ()=>{
    const idx = +inp.dataset.lotFraction;
    const fraction = parseFloat(inp.value)||0;
    if(fraction<=0) return;
    const qpcChamp = document.getElementById('f-quantiteParCaisse');
    const qpc = Math.max(1, parseInt(qpcChamp?.value)||p.quantiteParCaisse||1);
    const taille = Math.round(fraction * qpc);
    ctx.productLotsDraft[idx].taille = taille;
    const tailleInput = document.querySelector(`[data-lot-taille="${idx}"]`);
    if(tailleInput) tailleInput.value = taille;
    const span = document.getElementById('lot-margin-'+idx);
    if(span) span.textContent = lotMarginText(ctx, p, taille, ctx.productLotsDraft[idx].prix);
  });
  document.querySelectorAll('[data-lot-prix]').forEach(inp=>inp.oninput = ()=>{
    const idx = +inp.dataset.lotPrix;
    ctx.productLotsDraft[idx].prix = parseFloat(inp.value)||0;
    const span = document.getElementById('lot-margin-'+idx);
    if(span) span.textContent = lotMarginText(ctx, p, ctx.productLotsDraft[idx].taille, ctx.productLotsDraft[idx].prix);
  });
  document.querySelectorAll('[data-remove-lot]').forEach(b=>b.onclick = ()=>{
    ctx.productLotsDraft.splice(+b.dataset.removeLot,1);
    const editor = document.getElementById('lots-editor');
    if(editor){ editor.innerHTML = lotsEditorHTML(ctx, p); attachLotsEditorEvents(ctx, p); }
  });
}

/* =========================================================
   ACTIONS MÉTIER (appels RPC)
========================================================= */
// Un prix peut avoir changé (par un autre employé, sur un autre appareil)
// entre le moment où le produit est ajouté au panier et l'encaissement.
// Le serveur recalcule toujours le total à partir des prix actuels ; on
// resynchronise donc le panier juste avant d'afficher le total à
// encaisser, pour que le montant demandé au client soit le bon dès le
// départ plutôt que de découvrir l'écart après coup ("Montant insuffisant").
function syncCartPrices(ctx){
  ctx.cart.forEach(i=>{
    const p = ctx.state.produits.find(x=>x.id===i.produitId);
    if(!p) return;
    if(i.mode==='gros'){
      const lot = (p.lots||[]).find(l=>l.id===i.lotId);
      if(lot){ i.prixVente = lot.prix; i.uniteParLot = lot.taille; i.coutUnitaire = ctx.coutUnitaire(p)*lot.taille; }
    } else {
      i.prixVente = p.prixVenteDetail;
      i.coutUnitaire = ctx.coutUnitaire(p);
    }
  });
}
function addToCart(ctx, prodId){
  const p = ctx.state.produits.find(x=>x.id===prodId);
  if(!p) return;
  const stock = ctx.stockUnites(p);
  const dejaUnites = ctx.cart.filter(i=>i.produitId===prodId).reduce((s,i)=>s+ctx.unitsConsumed(i),0);
  if(dejaUnites + 1 > stock){ ctx.showToast('Stock insuffisant'); return; }
  const existing = ctx.cart.find(i=>i.produitId===prodId && i.mode==='detail');
  if(existing){ existing.qte += 1; }
  else{ ctx.cart.push({produitId:p.id, nom:p.nom, mode:'detail', qte:1, prixVente:p.prixVenteDetail, coutUnitaire:ctx.coutUnitaire(p), uniteParLot:1}); }
  ctx.render();
}
function addLotToCart(ctx, prodId, lotId){
  const p = ctx.state.produits.find(x=>x.id===prodId);
  if(!p) return;
  const lot = (p.lots||[]).find(l=>l.id===lotId);
  if(!lot) return;
  const stock = ctx.stockUnites(p);
  const dejaUnites = ctx.cart.filter(i=>i.produitId===prodId).reduce((s,i)=>s+ctx.unitsConsumed(i),0);
  if(dejaUnites + lot.taille > stock){ ctx.showToast('Stock insuffisant'); return; }
  const existing = ctx.cart.find(i=>i.produitId===prodId && i.mode==='gros' && i.lotId===lotId);
  if(existing){ existing.qte += 1; }
  else{ ctx.cart.push({produitId:p.id, nom:`${p.nom} — Lot de ${lot.taille}`, mode:'gros', lotId:lot.id, qte:1, prixVente:lot.prix, coutUnitaire:ctx.coutUnitaire(p)*lot.taille, uniteParLot:lot.taille}); }
  ctx.render();
}

async function finalizeSale(ctx, montantRecuConfirme){
  if(ctx.cart.length===0 || ctx.busy) return;
  ctx.busy = true; ctx.render();
  const cartSnapshot = ctx.cart.map(i=>({...i}));
  const items = cartSnapshot.map(i=>({ produit_id: i.produitId, mode: i.mode, lot_id: i.lotId||null, qte: i.qte }));
  const params = {
    p_items: items, p_remise_type: ctx.posRemiseType, p_remise_valeur: ctx.posRemiseValeur,
    p_mode_paiement: ctx.posDepositMode, p_montant_recu: Math.max(0, montantRecuConfirme||0),
    p_encaissement_partiel: ctx.posEncaissementPartiel, p_client_id: ctx.posClientId || null,
  };

  // La modification d'une fiche existante nécessite toujours une connexion :
  // trop risqué de la rejouer hors-ligne sans savoir si elle a déjà changé
  // ailleurs entre-temps (paiement partiel reçu, correction par un admin...).
  if(ctx.editingVenteId){
    const result = await ctx.supabase.rpc('rpc_modifier_vente', { p_vente_id: ctx.editingVenteId, ...params });
    ctx.busy = false;
    if(result.error){ alert(ctx.friendlyError(result.error)); ctx.render(); return; }
    const vente = ctx.upsertRow('ventes', result.data);
    ctx.editingVenteId = null; ctx.editingVenteNumero = null;
    ctx.cart = []; ctx.posPayMode='cash'; ctx.posClientId=''; ctx.posDepositMode='cash'; ctx.posMontantRecu=0; ctx.posRemiseType='montant'; ctx.posRemiseValeur=0;
    ctx.showToast('Fiche modifiée avec succès');
    ctx.printReceipt(vente);
    return;
  }

  const clientRef = ctx.uid() + '-' + Date.now();
  const finalizeParams = { p_magasin_id: ctx.state.currentMagasinId, ...params, p_client_ref: clientRef };
  const tryOnline = navigator.onLine;
  const result = tryOnline
    ? await ctx.supabase.rpc('rpc_finalize_sale', finalizeParams)
    : { error: { message: 'Hors ligne' } };

  if(!tryOnline || ctx.isNetworkError(result.error)){
    ctx.busy = false;
    const vente = registerOfflineSale(ctx, clientRef, finalizeParams, cartSnapshot, params);
    ctx.cart = []; ctx.posPayMode='cash'; ctx.posClientId=''; ctx.posDepositMode='cash'; ctx.posMontantRecu=0; ctx.posRemiseType='montant'; ctx.posRemiseValeur=0;
    ctx.showToast("Pas de connexion — vente enregistrée hors-ligne, elle sera envoyée automatiquement au retour d'internet.");
    ctx.printReceipt(vente);
    return;
  }

  ctx.busy = false;
  if(result.error){ alert(ctx.friendlyError(result.error)); ctx.render(); return; }
  const vente = ctx.upsertRow('ventes', result.data);
  ctx.cart = []; ctx.posPayMode='cash'; ctx.posClientId=''; ctx.posDepositMode='cash'; ctx.posMontantRecu=0; ctx.posRemiseType='montant'; ctx.posRemiseValeur=0;
  ctx.showToast('Vente enregistrée avec succès');
  ctx.printReceipt(vente);
}

// Construit une vente "locale" optimiste pendant une coupure internet, et la
// place dans la file d'attente hors-ligne pour un envoi automatique dès que
// la connexion revient (voir syncOfflineQueue dans app.js).
function registerOfflineSale(ctx, clientRef, finalizeParams, cartSnapshot, params){
  const totalBrut = ctx.cartTotal(cartSnapshot);
  const remise = ctx.remiseMontant(totalBrut);
  const total = Math.max(0, totalBrut - remise);
  const coutTotal = ctx.cartCost(cartSnapshot);
  const montantRecu = params.p_montant_recu;
  const reste = params.p_encaissement_partiel ? Math.max(0, total - montantRecu) : 0;
  const montantPaye = total - reste;
  const monnaieRendue = Math.max(0, montantRecu - total);
  const modeFinal = reste > 0 ? 'credit' : params.p_mode_paiement;
  const u = ctx.currentUser();
  const venteLocale = {
    id: clientRef,
    numero: 'HL-' + clientRef.slice(-8).toUpperCase(),
    magasinId: ctx.state.currentMagasinId,
    date: new Date().toISOString(),
    items: cartSnapshot.map(i=>({ produitId:i.produitId, nom:i.nom, mode:i.mode, qte:i.qte, uniteParLot:i.uniteParLot||1, prixVente:i.prixVente, coutUnitaire:i.coutUnitaire })),
    totalBrut, remise, total, coutTotal,
    modePaiement: modeFinal, montantRecu, monnaieRendue, montantPaye, reste,
    clientId: params.p_client_id || null,
    employeId: u ? u.id : null,
    paiements: [],
    clientRef,
    pendingSync: true,
  };
  ctx.state.ventes.unshift(venteLocale);
  decrementStockLocalement(ctx, cartSnapshot);
  ctx.queueOfflineSale(clientRef, finalizeParams);
  return venteLocale;
}

// Déduit le stock localement, en reproduisant la même logique caisse/détail
// que la fonction serveur rpc_finalize_sale, pour éviter de survendre le
// même produit deux fois sur cet appareil pendant la coupure.
function decrementStockLocalement(ctx, cartItems){
  for(const item of cartItems){
    const p = ctx.state.produits.find(x=>x.id===item.produitId);
    if(!p) continue;
    const unitsNeeded = item.qte * (item.uniteParLot||1);
    if((p.quantiteDetail||0) >= unitsNeeded){
      p.quantiteDetail -= unitsNeeded;
    } else {
      const resteU = unitsNeeded - (p.quantiteDetail||0);
      const qpc = Math.max(p.quantiteParCaisse||1, 1);
      const caissesNeeded = Math.ceil(resteU / qpc);
      p.quantiteCaisse = (p.quantiteCaisse||0) - caissesNeeded;
      p.quantiteDetail = (caissesNeeded * qpc) - resteU;
    }
  }
}

function commencerModificationVente(ctx, venteId){
  const v = ctx.state.ventes.find(x=>x.id===venteId);
  if(!v) return;
  const proceder = ()=>{
    ctx.editingVenteId = v.id;
    ctx.editingVenteNumero = v.numero;
    ctx.cart = v.items.map(i=>({...i}));
    ctx.posPayMode = (v.modePaiement==='credit') ? 'credit' : v.modePaiement;
    ctx.posClientId = v.clientId||'';
    ctx.posRemiseType = 'montant';
    ctx.posRemiseValeur = v.remise||0;
    ctx.posDepositMode = 'cash';
    ctx.posMontantRecu = 0;
    ctx.posEncaissementPartiel = false;
    ctx.editing = null;
    ctx.view = 'vente';
    ctx.showToast(`Modification de la fiche ${v.numero} — ajustez le panier puis encaissez pour valider. Rien n'est enregistré tant que vous n'avez pas validé.`);
    ctx.render();
  };
  if(v.paiements && v.paiements.length>0){
    ctx.askConfirm("Cette fiche a déjà reçu des paiements partiels. Les modifier effacera cet historique de paiement sur la fiche. Continuer ?", proceder);
  } else {
    proceder();
  }
}

async function deleteVente(ctx, venteId){
  const { error } = await ctx.supabase.rpc('rpc_delete_vente', { p_vente_id: venteId });
  if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
  ctx.removeRow('ventes', venteId);
  ctx.editing = null;
  ctx.showToast('Vente supprimée');
  ctx.render();
}

function ajouterAuTransfert(ctx, prodId){
  const p = ctx.state.produits.find(x=>x.id===prodId);
  if(!p) return;
  const stock = ctx.stockUnites(p);
  const deja = ctx.transfertCart.filter(i=>i.produitId===prodId).reduce((s,i)=>s+i.qte,0);
  if(deja+1 > stock){ ctx.showToast('Stock insuffisant dans le magasin source'); return; }
  const existing = ctx.transfertCart.find(i=>i.produitId===prodId);
  if(existing){ existing.qte += 1; } else { ctx.transfertCart.push({produitId:p.id, nom:p.nom, qte:1}); }
  ctx.render();
}
async function executeTransfert(ctx){
  const src = ctx.transfertSourceId, dst = ctx.transfertDestId;
  if(!src || !dst || src===dst || ctx.transfertCart.length===0) return;
  const items = ctx.transfertCart.map(i=>({ produit_id: i.produitId, qte: i.qte }));
  const { data, error } = await ctx.supabase.rpc('rpc_creer_transfert', { p_source_id: src, p_dest_id: dst, p_items: items });
  if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
  ctx.upsertRow('transferts', data);
  ctx.transfertCart=[]; ctx.transfertView='liste'; ctx.editing=null;
  ctx.showToast('Transfert envoyé — en attente de confirmation de réception par le magasin destinataire');
  ctx.render();
}

async function confirmerTransfert(ctx, transfertId){
  const { data, error } = await ctx.supabase.rpc('rpc_confirmer_transfert', { p_transfert_id: transfertId });
  if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
  ctx.upsertRow('transferts', data);
  ctx.showToast('Réception confirmée — stock ajouté au magasin');
  ctx.render();
}

async function annulerTransfert(ctx, transfertId){
  const { error } = await ctx.supabase.rpc('rpc_annuler_transfert', { p_transfert_id: transfertId });
  if(error){ ctx.showToast(ctx.friendlyError(error)); return; }
  const t = ctx.state.transferts.find(x=>x.id===transfertId);
  if(t) t.statut = 'annule';
  ctx.showToast('Transfert annulé — stock restitué au magasin source');
  ctx.render();
}
