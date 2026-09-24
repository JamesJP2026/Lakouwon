/* =========================================================
   VUES — portées de l'application d'origine (localStorage) vers
   l'état partagé Supabase. Chaque fonction reçoit `ctx`, l'objet
   de contexte construit par app.js (état + helpers).
========================================================= */

// Petite bulle d'aide (?) au survol, pour expliquer un champ sans
// alourdir l'écran — utile pour former un nouvel employé.
function aide(texte){
  return `<span class="help-ic" title="${texte.replace(/"/g,'&quot;')}">?</span>`;
}

/* ---------- TABLEAU DE BORD ---------- */
function ventesParMode(ctx){
  const groups = {};
  ctx.ventesPeriode().forEach(v=>{ groups[v.modePaiement] = (groups[v.modePaiement]||0) + v.total; });
  const labels = {cash:'Espèces',banque:'Banque',moncash:'MonCash',credit:'Crédit'};
  const colors = {cash:'#2f7d5a',banque:'#2b52a3',moncash:'#7c3aa8',credit:'#b7791f'};
  return Object.keys(groups).filter(k=>groups[k]>0).map(k=>({label:labels[k]||k, value:groups[k], color:colors[k]||'#5b6577'}));
}
function stockParCategorie(ctx){
  const groups = {};
  ctx.magasinProduits().forEach(p=>{ const cat = p.categorie||'Sans catégorie'; groups[cat] = (groups[cat]||0) + ctx.stockUnites(p)*ctx.coutUnitaire(p); });
  const palette = ['#132340','#c8973f','#2f7d5a','#b8433a','#7c3aa8','#2b52a3','#b7791f','#5b6577'];
  return Object.keys(groups).filter(k=>groups[k]>0).map((k,i)=>({label:k, value:groups[k], color:palette[i%palette.length]}));
}
function renderPieChart(data){
  const total = data.reduce((s,d)=>s+d.value,0);
  if(total<=0) return `<div class="muted">Pas assez de données pour ce graphique.</div>`;
  let acc = 0;
  const stops = data.map(d=>{ const start=acc/total*360; acc+=d.value; const end=acc/total*360; return `${d.color} ${start}deg ${end}deg`; }).join(', ');
  return `<div style="display:flex; align-items:center; gap:20px; flex-wrap:wrap;">
    <div style="width:130px; height:130px; border-radius:50%; background:conic-gradient(${stops}); flex-shrink:0; box-shadow:inset 0 0 0 30px var(--card), var(--shadow);"></div>
    <div style="flex:1; min-width:160px;">
      ${data.map(d=>`<div style="display:flex; align-items:center; gap:8px; font-size:12.5px; margin-bottom:6px;">
        <span style="width:11px;height:11px;border-radius:3px;background:${d.color};display:inline-block; flex-shrink:0;"></span>
        <span>${d.label}</span><span class="muted num" style="margin-left:auto; white-space:nowrap;">${(d.value/total*100).toFixed(0)}%</span>
      </div>`).join('')}
    </div>
  </div>`;
}
export function searchFichesEtProformas(ctx, q){
  q = (q||'').toLowerCase().trim();
  if(!q) return [];
  const ventes = ctx.magasinVentes().filter(v=> v.numero.toLowerCase().includes(q) || ctx.clientName(v.clientId).toLowerCase().includes(q))
    .map(v=>({type:'vente', id:v.id, numero:v.numero, client: v.clientId? ctx.clientName(v.clientId) : 'Comptant', total:v.total, date:v.date}));
  const pfs = ctx.magasinProformas().filter(p=> p.numero.toLowerCase().includes(q) || (p.clientId? ctx.clientName(p.clientId) : (p.clientNomLibre||'')).toLowerCase().includes(q))
    .map(p=>({type:'proforma', id:p.id, numero:p.numero, client: p.clientId? ctx.clientName(p.clientId) : (p.clientNomLibre||'—'), total:p.total, date:p.date}));
  return [...ventes, ...pfs].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,20);
}
export function renderSearchResults(ctx, results, query){
  if(!query) return '';
  if(results.length===0) return `<div class="muted" style="margin-top:10px;">Aucun résultat pour "${query}".</div>`;
  return `<div class="table-wrap" style="margin-top:10px;"><table><thead><tr><th>Type</th><th>N°</th><th>Client</th><th class="right">Total</th><th></th></tr></thead><tbody>
    ${results.map(r=>`<tr><td><span class="badge ${r.type==='vente'?'cash':'credit'}">${r.type==='vente'?'Vente':'Proforma'}</span></td><td><b>${r.numero}</b></td><td>${r.client}</td><td class="right num">${ctx.money(r.total)}</td><td class="right"><button class="btn btn-sm" data-search-open="${r.type}:${r.id}">Voir</button></td></tr>`).join('')}
  </tbody></table></div>`;
}
function pronosticStock(ctx){
  const produits = ctx.magasinProduits().filter(p=>!p.archive);
  let valeurAchat=0, valeurVenteDetail=0;
  produits.forEach(p=>{
    const stock = ctx.stockUnites(p);
    valeurAchat += stock*ctx.coutUnitaire(p);
    valeurVenteDetail += stock*(p.prixVenteDetail||0);
  });
  const beneficePotentiel = valeurVenteDetail - valeurAchat;
  const margePotentiellePct = valeurAchat>0 ? (beneficePotentiel/valeurAchat*100) : 0;
  return {valeurAchat, valeurVenteDetail, beneficePotentiel, margePotentiellePct};
}
export function renderDashboard(ctx){
  const { state, money, period } = ctx;
  const k = ctx.kpisPeriode();
  const pronosticData = pronosticStock(ctx);
  const stockBas = ctx.magasinProduits().filter(p=>ctx.stockUnites(p) <= (p.stockMinimum||0));
  const journalMag = state.journal.filter(j=>j.magasinId===state.currentMagasinId).slice(0,12);
  const dettes = ctx.totalDettesMagasin();
  return `
  <div class="topbar">
    <div><h1>Tableau de bord</h1><p>Vue d'ensemble en temps réel de votre business</p></div>
    <div class="period-tabs">
      ${[['today',"Aujourd'hui"],['week','7 jours'],['month','Ce mois'],['all','Tout']].map(([id,l])=>`<button class="period-tab ${period===id?'active':''}" data-period="${id}">${l}</button>`).join('')}
    </div>
  </div>
  <div class="panel">
    <h3>Recherche rapide — Fiches & Proforma</h3>
    <input class="search" id="global-search" placeholder="🔎 Numéro de fiche, de proforma, ou nom du client..." style="width:100%; max-width:440px;" value="${ctx.dashboardSearchQuery}">
    <div id="global-search-results">${renderSearchResults(ctx, searchFichesEtProformas(ctx, ctx.dashboardSearchQuery), ctx.dashboardSearchQuery)}</div>
  </div>
  <div class="kpi-row">
    <div class="kpi pos"><div class="lbl">Bénéfice net</div><div class="val num">${money(k.beneficeNet)}</div><div class="sub">Marge − dépenses de la période</div></div>
    <div class="kpi"><div class="lbl">Chiffre d'affaires</div><div class="val num">${money(k.ca)}</div><div class="sub">${ctx.ventesPeriode().length} vente(s)</div></div>
    <div class="kpi gold"><div class="lbl">Marge brute</div><div class="val num">${money(k.margeBrute)}</div><div class="sub">${k.margePct.toFixed(1)}% de marge</div></div>
    <div class="kpi neg"><div class="lbl">Dépenses</div><div class="val num">${money(k.depenses)}</div><div class="sub">Sorties de caisse hors ventes</div></div>
    <div class="kpi white"><div class="lbl">Dettes clients</div><div class="val num">${money(dettes)}</div><div class="sub">Crédits non soldés</div></div>
    <div class="kpi lime"><div class="lbl">Valeur du stock</div><div class="val num">${money(ctx.valeurStock())}</div><div class="sub">Au prix d'achat</div></div>
    <div class="kpi ${ctx.soldeCaisse()<0?'neg':'lemon'}"><div class="lbl">Solde caisse</div><div class="val num">${money(ctx.soldeCaisse())}</div><div class="sub">Espèces disponibles</div></div>
  </div>
  <div class="panel">
    <h3>Pronostic — si tout le stock actuel était vendu au détail</h3>
    <div class="kpi-row" style="margin-bottom:0;">
      <div class="kpi"><div class="lbl">Valeur d'achat du stock</div><div class="val num">${money(pronosticData.valeurAchat)}</div></div>
      <div class="kpi gold"><div class="lbl">Valeur de vente potentielle</div><div class="val num">${money(pronosticData.valeurVenteDetail)}</div></div>
      <div class="kpi pos"><div class="lbl">Bénéfice potentiel</div><div class="val num">${money(pronosticData.beneficePotentiel)}</div></div>
      <div class="kpi"><div class="lbl">Marge potentielle</div><div class="val num">${pronosticData.margePotentiellePct.toFixed(1)}%</div></div>
    </div>
    <div class="muted" style="font-size:11.5px; margin-top:10px;">Estimation basée sur le stock actuel (hors produits archivés) aux prix de vente en détail. Ne tient pas compte des invendus, pertes ou changements de prix.</div>
  </div>
  <div class="grid-2">
    <div class="panel"><h3>Répartition du CA par mode de paiement</h3>${renderPieChart(ventesParMode(ctx))}</div>
    <div class="panel"><h3>Valeur du stock par catégorie</h3>${renderPieChart(stockParCategorie(ctx))}</div>
  </div>
  <div class="grid-2">
    <div class="panel"><h3>Alertes stock bas <span class="n">${stockBas.length} article(s)</span></h3>
      ${stockBas.length? stockBas.map(p=>`<div class="alert-item"><span>${p.nom}</span><span class="tag low">${ctx.stockUnites(p)} unité(s)</span></div>`).join('') : `<div class="muted">Aucune alerte pour le moment.</div>`}
    </div>
    <div class="panel"><h3>Activité récente</h3>
      ${journalMag.length? journalMag.map(j=>`<div class="log-item"><div>${j.action}</div><div class="log-time">${new Date(j.date).toLocaleString('fr-FR')} · ${ctx.empName(j.employeId)}</div></div>`).join('') : `<div class="muted">Aucune activité récente.</div>`}
    </div>
  </div>`;
}

/* ---------- VENTE / POS ---------- */
export function renderVente(ctx){
  const { cart, money } = ctx;
  const produits = ctx.magasinProduitsActifs();
  return `
  <div class="topbar"><div><h1>${ctx.editingVenteId? 'Modification de la fiche '+ctx.editingVenteNumero : 'Nouvelle vente'}</h1><p>${ctx.editingVenteId? "Ajustez le panier puis validez l'encaissement pour enregistrer la modification" : 'Sélectionnez les produits puis encaissez'}</p></div>
    ${ctx.editingVenteId? `<div class="topbar-actions"><button class="btn btn-danger" id="btn-annuler-modif-vente">✕ Annuler la modification</button></div>` : ''}
  </div>
  <div class="pos-grid">
    <div>
      <input class="search" id="prod-search" placeholder="🔎 Rechercher un produit..." style="width:100%; margin-bottom:12px;">
      <div class="prod-pick" id="prod-pick">
        ${produits.length? produits.map(p=>{
          const stock = ctx.stockUnites(p);
          const reserve = cart.filter(i=>i.produitId===p.id).reduce((s,i)=>s+ctx.unitsConsumed(i),0);
          const dispo = stock - reserve;
          const lots = p.lots||[];
          return `<div class="prod-card ${dispo<=0?'out':''}" data-name="${p.nom.toLowerCase()}">
            <div class="pn">${p.nom}</div>
            <div class="pp">${money(p.prixVenteDetail)} <span class="muted" style="font-weight:500;font-size:11px;">/ unité</span></div>
            <div class="pq">${dispo<=0? '<span style="color:var(--red);font-weight:700;">Rupture de stock</span>' : (dispo!==stock? `Disponible: ${dispo} (sur ${stock})` : `Stock: ${stock} unité(s)`)}</div>
            <button class="btn btn-sm btn-primary" data-add-detail="${p.id}" ${dispo<=0?'disabled':''} style="width:100%; margin-top:7px;">+ Détail</button>
            ${lots.length? `<select data-lot-add="${p.id}" ${dispo<=0?'disabled':''} style="width:100%; margin-top:5px; padding:6px; border:1px solid var(--line); border-radius:6px; font-size:12px;">
              <option value="">+ Ajouter un lot...</option>
              ${lots.map(l=>`<option value="${l.id}" ${dispo<l.taille?'disabled':''}>Lot de ${l.taille} — ${money(l.prix)}${dispo<l.taille?' (stock insuffisant)':''}</option>`).join('')}
            </select>` : ''}
          </div>`;
        }).join('') : `<div class="empty" style="grid-column:1/-1;">Aucun produit. Ajoutez des produits d'abord.</div>`}
      </div>
    </div>
    <div class="panel" style="margin-bottom:0;">
      <h3>Panier</h3>
      ${cart.length? cart.map((i,idx)=>`
        <div class="cart-item">
          <span class="ci-name">${i.nom} <span class="badge ${i.mode==='gros'?'credit':'cash'}" style="font-size:9.5px;">${i.mode==='gros'?'Lot':'Détail'}</span></span>
          <input type="number" min="1" data-qty="${idx}" value="${i.qte}">
          <span class="num" style="width:80px;text-align:right;">${money(i.qte*i.prixVente)}</span>
          <button class="btn btn-sm btn-danger" data-remove="${idx}">✕</button>
        </div>`).join('') : `<div class="muted" style="padding:10px 0;">Le panier est vide.</div>`}

      <div class="field" style="margin-top:12px;"><label>Remise / Rabais (optionnel)${aide("Réduit le total de la vente. Choisissez un montant fixe (ex: 50 HTG) ou un pourcentage (ex: 10%).")}</label>
        <div class="row2">
          <select id="remise-type">
            <option value="montant" ${ctx.posRemiseType==='montant'?'selected':''}>Montant fixe</option>
            <option value="pourcentage" ${ctx.posRemiseType==='pourcentage'?'selected':''}>Pourcentage (%)</option>
          </select>
          <input type="number" id="remise-valeur" min="0" value="${ctx.posRemiseValeur}">
        </div>
      </div>
      <div id="remise-summary">${ctx.remiseSummaryHTML()}</div>

      <div class="field" style="margin-top:14px;"><label>Mode de paiement</label>
        <div class="pay-modes">
          ${[['cash','Espèces'],['banque','Banque'],['moncash','MonCash'],['credit','Crédit']].map(([id,l])=>`<button class="pay-mode ${ctx.posPayMode===id?'active':''}" data-mode="${id}">${l}</button>`).join('')}
        </div>
        <div class="muted" style="font-size:12px; margin-top:4px;">Vous pourrez encaisser un montant partiel et enregistrer le reste comme dette à l'étape suivante, quel que soit le mode choisi.</div>
      </div>

      <button class="btn btn-primary" id="btn-encaisser" style="width:100%; justify-content:center; margin-top:16px; padding:12px;" ${cart.length===0?'disabled':''}>✔ Encaisser la vente</button>
    </div>
  </div>`;
}

export function generateReceiptHTML(ctx, vente){
  const { state, money, fmt } = ctx;
  const magasin = state.magasins.find(m=>m.id===vente.magasinId);
  const s = state.settings;
  const logo = (magasin && magasin.logo) || s.logo;
  const adresse = (magasin && magasin.adresse) || s.adresse;
  const telephone = (magasin && magasin.telephone) || s.telephone;
  const email = (magasin && magasin.email) || s.email;
  return `
    <div style="font-family:'Inter',Arial,sans-serif; max-width:320px; margin:0 auto;">
      <div style="text-align:center; margin-bottom:10px;">
        ${logo? `<img src="${logo}" style="max-width:70px; max-height:70px; margin-bottom:6px;">` : ''}
        <div style="font-weight:800; font-size:16px;">${s.nomCommerce}</div>
        <div style="font-size:11px;">${magasin?magasin.nom:''}</div>
        ${adresse? `<div style="font-size:11px;">${adresse}</div>`:''}
        ${telephone? `<div style="font-size:11px;">Tél: ${telephone}</div>`:''}
        ${email? `<div style="font-size:11px;">${email}</div>`:''}
      </div>
      <div style="border-top:1px dashed #000; border-bottom:1px dashed #000; padding:6px 0; font-size:12px;">
        Fiche N° ${vente.numero}<br>Date : ${new Date(vente.date).toLocaleString('fr-FR')}<br>Caissier : ${ctx.empName(vente.employeId)}<br>
        ${vente.clientId? 'Client : '+ctx.clientName(vente.clientId)+'<br>' : ''}
      </div>
      <table style="width:100%; font-size:12px; margin-top:6px;">
        ${vente.items.map(i=>`<tr><td>${i.nom}${i.mode==='gros'?' (lot)':''}</td><td style="text-align:center;">x${i.qte}</td><td style="text-align:right;">${fmt(i.qte*i.prixVente)}</td></tr>`).join('')}
      </table>
      <div style="border-top:1px dashed #000; margin-top:8px; padding-top:6px; font-size:13px;">
        ${vente.remise>0?`<div style="display:flex; justify-content:space-between;"><span>Sous-total</span><span>${money(vente.totalBrut)}</span></div>
        <div style="display:flex; justify-content:space-between;"><span>Remise</span><span>-${money(vente.remise)}</span></div>`:''}
        <div style="display:flex; justify-content:space-between;"><b>TOTAL</b><b>${money(vente.total)}</b></div>
        <div style="display:flex; justify-content:space-between;"><span>Montant reçu</span><span>${money(vente.montantRecu)}</span></div>
        ${vente.monnaieRendue>0?`<div style="display:flex; justify-content:space-between;"><span>Monnaie rendue</span><span>${money(vente.monnaieRendue)}</span></div>`:''}
        ${vente.reste>0?`<div style="display:flex; justify-content:space-between;"><span>Reste dû</span><span>${money(vente.reste)}</span></div>`:''}
        <div style="display:flex; justify-content:space-between;"><span>Mode</span><span>${vente.modePaiement}</span></div>
      </div>
      <div style="text-align:center; margin-top:14px; font-size:11px;">Merci de votre confiance</div>
    </div>`;
}

/* ---------- FICHES DE VENTE ---------- */
export function fichesFiltrees(ctx){
  let ventes = ctx.magasinVentes().slice().sort((a,b)=>new Date(b.date)-new Date(a.date));
  if(ctx.ficheSearch){
    const q = ctx.ficheSearch.toLowerCase();
    ventes = ventes.filter(v=> v.numero.toLowerCase().includes(q) || ctx.clientName(v.clientId).toLowerCase().includes(q));
  }
  if(ctx.ficheFiltreDateDebut){
    const debut = new Date(ctx.ficheFiltreDateDebut); debut.setHours(0,0,0,0);
    ventes = ventes.filter(v=> new Date(v.date) >= debut);
  }
  if(ctx.ficheFiltreDateFin){
    const fin = new Date(ctx.ficheFiltreDateFin); fin.setHours(23,59,59,999);
    ventes = ventes.filter(v=> new Date(v.date) <= fin);
  }
  if(ctx.ficheFiltreMode) ventes = ventes.filter(v=> v.modePaiement === ctx.ficheFiltreMode);
  if(ctx.ficheFiltreEmployeId) ventes = ventes.filter(v=> v.employeId === ctx.ficheFiltreEmployeId);
  return ventes;
}
export function fichesTableHTML(ctx){
  const { money } = ctx;
  const ventes = fichesFiltrees(ctx);
  return `
    <table>
      <thead><tr><th>N° Fiche</th><th>Date</th><th>Client</th><th>Mode</th><th class="right">Total</th><th class="right">Payé</th><th class="right">Reste</th><th></th></tr></thead>
      <tbody>
        ${ventes.length? ventes.map(v=>`
          <tr>
            <td><b>${v.numero}</b>${v.pendingSync? ' <span class="tag low" title="Faite hors-ligne, en attente d\'envoi au serveur">⏳ hors-ligne</span>' : ''}</td>
            <td class="muted">${new Date(v.date).toLocaleString('fr-FR')}</td>
            <td>${v.clientId? ctx.clientName(v.clientId) : '<span class="muted">Comptant</span>'}</td>
            <td><span class="badge ${v.modePaiement}">${v.modePaiement}</span></td>
            <td class="right num">${money(v.total)}</td>
            <td class="right num">${money(v.montantPaye)}</td>
            <td class="right num" style="${v.reste>0?'color:var(--red);font-weight:700;':''}">${money(v.reste)}</td>
            <td class="right">
              <button class="btn btn-sm" data-voir-vente="${v.id}">Voir</button>
              ${ctx.isAdminConnecte() && !v.pendingSync? `<button class="btn btn-sm btn-gold" data-modifier-vente="${v.id}">Modifier</button><button class="btn btn-sm btn-danger" data-suppr-vente="${v.id}">Suppr.</button>` : ''}
            </td>
          </tr>`).join('') : `<tr><td colspan="8" class="empty">Aucune vente enregistrée.</td></tr>`}
      </tbody>
    </table>`;
}
export function renderFiches(ctx){
  const employes = ctx.magasinEmployes();
  return `
  <div class="topbar"><div><h1>Fiches de vente</h1><p>Consultez et vérifiez le détail de chaque vente</p></div></div>
  <div class="panel" style="padding:14px 16px; margin-bottom:14px;">
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
      <div class="field" style="margin:0; min-width:200px; flex:1;"><label>Recherche</label>
        <input class="search" id="fiche-search" placeholder="🔎 Numéro ou client..." value="${ctx.ficheSearch}" style="width:100%;">
      </div>
      <div class="field" style="margin:0;"><label>Du</label><input type="date" id="fiche-filtre-date-debut" value="${ctx.ficheFiltreDateDebut}"></div>
      <div class="field" style="margin:0;"><label>Au</label><input type="date" id="fiche-filtre-date-fin" value="${ctx.ficheFiltreDateFin}"></div>
      <div class="field" style="margin:0;"><label>Mode de paiement</label>
        <select id="fiche-filtre-mode">
          <option value="">Tous</option>
          <option value="cash" ${ctx.ficheFiltreMode==='cash'?'selected':''}>Cash</option>
          <option value="banque" ${ctx.ficheFiltreMode==='banque'?'selected':''}>Banque</option>
          <option value="moncash" ${ctx.ficheFiltreMode==='moncash'?'selected':''}>MonCash</option>
          <option value="credit" ${ctx.ficheFiltreMode==='credit'?'selected':''}>Crédit</option>
        </select>
      </div>
      <div class="field" style="margin:0;"><label>Employé</label>
        <select id="fiche-filtre-employe">
          <option value="">Tous</option>
          ${employes.map(e=>`<option value="${e.id}" ${ctx.ficheFiltreEmployeId===e.id?'selected':''}>${e.nom}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-sm" id="btn-reset-filtres-fiches">✕ Réinitialiser</button>
      <button class="btn btn-sm btn-gold" id="btn-export-fiches">📤 Exporter CSV</button>
    </div>
  </div>
  <div class="table-wrap" id="fiches-table-wrap">
    ${fichesTableHTML(ctx)}
  </div>`;
}

/* ---------- PRODUITS & STOCK ---------- */
export function renderProduits(ctx){
  const { money, fmt } = ctx;
  const tousProduits = ctx.magasinProduits();
  const produits = tousProduits.filter(p => ctx.produitsFiltre==='tous' ? true : ctx.produitsFiltre==='archives' ? p.archive : !p.archive);
  const nbArchives = tousProduits.filter(p=>p.archive).length;
  const parCategorie = {};
  produits.forEach(p=>{ const c = p.categorie || 'Sans catégorie'; parCategorie[c] = (parCategorie[c]||0)+1; });
  const categoriesTriees = Object.entries(parCategorie).sort((a,b)=>b[1]-a[1]);
  return `
  <div class="topbar">
    <div><h1>Produits & Stock</h1><p>Gérez votre inventaire, vos prix détail et gros</p></div>
    <div class="topbar-actions">
      <button class="btn btn-sm btn-gold" id="btn-export-stock-csv">📤 Excel (sauvegarde)</button>
      <button class="btn btn-sm btn-gold" id="btn-export-stock-pdf">📄 PDF</button>
      <button class="btn btn-primary" id="btn-new-produit">+ Nouveau produit</button>
    </div>
  </div>
  <div class="period-tabs">
    <button class="period-tab ${ctx.produitsFiltre==='actifs'?'active':''}" data-produits-filtre="actifs">Actifs</button>
    <button class="period-tab ${ctx.produitsFiltre==='archives'?'active':''}" data-produits-filtre="archives">Archivés (${nbArchives})</button>
    <button class="period-tab ${ctx.produitsFiltre==='tous'?'active':''}" data-produits-filtre="tous">Tous</button>
  </div>
  <div class="muted" style="font-size:12px; margin-bottom:14px;">Un produit sans vente depuis ${ctx.SEUIL_ARCHIVAGE_JOURS} jours est archivé automatiquement et retiré du point de vente. Vous pouvez le réactiver à tout moment.</div>
  <div class="panel" style="padding:12px 16px; margin-bottom:16px; display:flex; flex-wrap:wrap; align-items:center; gap:10px 18px;">
    <button type="button" class="btn btn-sm" id="btn-cat-filter-tous" style="font-weight:700;"><b style="font-size:18px;">${fmt(produits.length)}</b> produit${produits.length>1?'s':''} enregistré${produits.length>1?'s':''}</button>
    ${categoriesTriees.length? `<div style="display:flex; flex-wrap:wrap; gap:6px 10px; border-left:1px solid var(--line); padding-left:14px;">
      ${categoriesTriees.map(([cat,n])=>`<button type="button" class="badge cash" data-cat-filter="${cat==='Sans catégorie'?'__none__':cat}" title="Voir les produits de ${cat}" style="border:none; cursor:pointer; font:inherit;">${cat} : ${fmt(n)}</button>`).join('')}
    </div>` : ''}
  </div>
  <input class="search" id="produits-search" placeholder="🔎 Rechercher un produit ou une catégorie..." style="width:100%; max-width:340px; margin-bottom:16px;">
  <div class="product-grid" id="product-grid">
    ${produits.length? produits.map(p=>{
      const total = ctx.stockUnites(p);
      const bas = total <= (p.stockMinimum||0);
      const lots = p.lots||[];
      return `<div class="product-card" data-name="${(p.nom+' '+(p.categorie||'')).toLowerCase()}" data-cat="${p.categorie||'__none__'}" style="${p.archive?'opacity:.6;':''}">
        <div class="pc-head">
          <div class="pc-name">${p.nom} ${p.archive?'<span class="badge role-Caissier">Archivé</span>':''}</div>
          <span class="badge ${bas?'credit':'cash'}">${fmt(total)} u.</span>
        </div>
        <div class="pc-cat muted">${p.categorie||'Sans catégorie'}</div>
        <div class="cc-stats">
          <div><span class="muted">Achat (caisse)</span><br><b class="num">${money(p.prixAchat)}</b></div>
          <div style="text-align:right;"><span class="muted">Détail</span><br><b class="num">${money(p.prixVenteDetail)}</b></div>
        </div>
        <div class="pc-lots">
          <span class="muted" style="font-size:11.5px;">Prix de gros :</span><br>
          ${lots.length? lots.map(l=>`<span class="badge cash" style="margin:3px 3px 0 0;">${l.taille}u — ${money(l.prix)}</span>`).join('') : '<span class="muted" style="font-size:12px;">Non configuré</span>'}
        </div>
        <div class="pc-meta muted">${fmt(p.quantiteCaisse||0)}×${fmt(p.quantiteParCaisse||0)} + ${fmt(p.quantiteDetail||0)} détail · Seuil min ${fmt(p.stockMinimum||0)}</div>
        <div class="cc-actions">
          <button class="btn btn-sm" data-edit-produit="${p.id}">Modifier</button>
          ${p.archive?
            `<button class="btn btn-sm btn-gold" data-unarchive-produit="${p.id}">↻ Réactiver</button>`
            : `<button class="btn btn-sm" data-archive-produit="${p.id}">Archiver</button>`}
          <button class="btn btn-sm btn-danger" data-del-produit="${p.id}">Suppr.</button>
        </div>
      </div>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1;">Aucun produit dans cette catégorie.</div>`}
  </div>`;
}

// Page imprimable (utilisée aussi pour "Enregistrer en PDF" via l'impression
// du navigateur) listant tout le stock actuel — pour une sauvegarde papier
// ou numérique indépendante de l'application.
export function generateStockPrintHTML(ctx){
  const { money, fmt, state } = ctx;
  const magasin = state.magasins.find(m=>m.id===state.currentMagasinId);
  const produits = ctx.magasinProduitsActifs().slice().sort((a,b)=>a.nom.localeCompare(b.nom));
  const valeurTotale = produits.reduce((s,p)=>s+(ctx.stockUnites(p)*ctx.coutUnitaire(p)),0);
  return `
    <div style="font-family:'Inter',Arial,sans-serif;">
      <h2 style="margin-bottom:2px;">${state.settings.nomCommerce} — État du stock</h2>
      <div style="color:#666; font-size:12px; margin-bottom:14px;">${magasin?magasin.nom:''} — ${new Date().toLocaleString('fr-FR')}</div>
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead><tr>
          <th style="text-align:left; border-bottom:2px solid #333; padding:5px;">Produit</th>
          <th style="text-align:left; border-bottom:2px solid #333; padding:5px;">Catégorie</th>
          <th style="text-align:right; border-bottom:2px solid #333; padding:5px;">Stock (unités)</th>
          <th style="text-align:right; border-bottom:2px solid #333; padding:5px;">Prix d'achat (caisse)</th>
          <th style="text-align:right; border-bottom:2px solid #333; padding:5px;">Valeur (achat)</th>
        </tr></thead>
        <tbody>
          ${produits.map(p=>`<tr>
            <td style="padding:5px; border-bottom:1px solid #ddd;">${p.nom}</td>
            <td style="padding:5px; border-bottom:1px solid #ddd;">${p.categorie||'—'}</td>
            <td style="padding:5px; border-bottom:1px solid #ddd; text-align:right;">${fmt(ctx.stockUnites(p))}</td>
            <td style="padding:5px; border-bottom:1px solid #ddd; text-align:right;">${money(p.prixAchat)}</td>
            <td style="padding:5px; border-bottom:1px solid #ddd; text-align:right;">${money(ctx.stockUnites(p)*ctx.coutUnitaire(p))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="text-align:right; font-weight:800; margin-top:10px; font-size:13px;">Valeur totale du stock : ${money(valeurTotale)}</div>
    </div>`;
}

/* ---------- INVENTAIRE PHYSIQUE ---------- */
function inventaireProduits(ctx){
  let produits = ctx.magasinProduitsActifs().slice().sort((a,b)=>a.nom.localeCompare(b.nom));
  if(ctx.inventaireSearch){
    const q = ctx.inventaireSearch.toLowerCase();
    produits = produits.filter(p=> p.nom.toLowerCase().includes(q) || (p.categorie||'').toLowerCase().includes(q));
  }
  return produits;
}

function inventaireRowHTML(ctx, p){
  const { fmt } = ctx;
  const systeme = ctx.stockUnites(p);
  const compteRaw = ctx.inventaireComptages[p.id];
  const compte = (compteRaw===''||compteRaw===undefined||compteRaw===null) ? null : parseInt(compteRaw)||0;
  const ecart = compte===null ? null : compte - systeme;
  return `<tr data-inv-row="${p.id}">
    <td><b>${p.nom}</b></td>
    <td class="muted">${p.categorie||'—'}</td>
    <td class="right num">${fmt(systeme)}</td>
    <td class="right"><input type="number" min="0" style="width:90px; text-align:right;" data-inv-input="${p.id}" value="${compteRaw??''}" placeholder="—"></td>
    <td class="right num" data-inv-ecart="${p.id}" style="${ecart>0?'color:var(--green);font-weight:700;':ecart<0?'color:var(--red);font-weight:700;':''}">${ecart===null?'—':(ecart>0?'+':'')+fmt(ecart)}</td>
  </tr>`;
}

export function renderInventaire(ctx){
  const produits = inventaireProduits(ctx);
  const comptages = ctx.inventaireComptages;
  const nbComptes = Object.keys(comptages).filter(id=>comptages[id]!==''&&comptages[id]!==undefined&&comptages[id]!==null).length;
  return `
  <div class="topbar">
    <div><h1>Inventaire physique</h1><p>Comptez le stock réel de chaque produit et comparez-le au stock système</p></div>
    <div class="topbar-actions">
      <button class="btn btn-sm" id="btn-export-inventaire-csv">📤 Excel</button>
      <button class="btn btn-sm" id="btn-export-inventaire-pdf">📄 PDF</button>
      ${ctx.isAdminConnecte()? `<button class="btn btn-primary" id="btn-appliquer-inventaire">✔ Appliquer au stock</button>` : ''}
    </div>
  </div>
  <div class="info-box">Entrez la quantité réellement comptée pour chaque produit (en unités, pas en caisses). L'écart s'affiche automatiquement. ${nbComptes>0?`<b>${nbComptes} produit(s) compté(s)</b> — sauvegardé automatiquement si la page se ferme.`:''}</div>
  <div class="toolbar">
    <input class="search" id="inventaire-search" placeholder="🔎 Rechercher un produit ou une catégorie..." value="${ctx.inventaireSearch}">
    <button class="btn btn-sm" id="btn-reset-inventaire">✕ Réinitialiser le comptage</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Produit</th><th>Catégorie</th><th class="right">Stock système</th><th class="right">Quantité comptée</th><th class="right">Écart</th></tr></thead>
      <tbody id="inventaire-tbody">
        ${produits.length? produits.map(p=>inventaireRowHTML(ctx,p)).join('') : `<tr><td colspan="5" class="empty">Aucun produit.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// Page imprimable de la feuille d'inventaire (avec les quantités comptées
// jusqu'à présent), pour "Enregistrer en PDF" via l'impression du navigateur.
export function generateInventairePrintHTML(ctx){
  const { fmt, state } = ctx;
  const magasin = state.magasins.find(m=>m.id===state.currentMagasinId);
  const produits = inventaireProduits(ctx);
  return `
    <div style="font-family:'Inter',Arial,sans-serif;">
      <h2 style="margin-bottom:2px;">${state.settings.nomCommerce} — Inventaire physique</h2>
      <div style="color:#666; font-size:12px; margin-bottom:14px;">${magasin?magasin.nom:''} — ${new Date().toLocaleString('fr-FR')}</div>
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead><tr>
          <th style="text-align:left; border-bottom:2px solid #333; padding:5px;">Produit</th>
          <th style="text-align:left; border-bottom:2px solid #333; padding:5px;">Catégorie</th>
          <th style="text-align:right; border-bottom:2px solid #333; padding:5px;">Stock système</th>
          <th style="text-align:right; border-bottom:2px solid #333; padding:5px;">Compté</th>
          <th style="text-align:right; border-bottom:2px solid #333; padding:5px;">Écart</th>
        </tr></thead>
        <tbody>
          ${produits.map(p=>{
            const systeme = ctx.stockUnites(p);
            const compteRaw = ctx.inventaireComptages[p.id];
            const compte = (compteRaw===''||compteRaw===undefined||compteRaw===null) ? null : parseInt(compteRaw)||0;
            const ecart = compte===null ? null : compte - systeme;
            return `<tr>
              <td style="padding:5px; border-bottom:1px solid #ddd;">${p.nom}</td>
              <td style="padding:5px; border-bottom:1px solid #ddd;">${p.categorie||'—'}</td>
              <td style="padding:5px; border-bottom:1px solid #ddd; text-align:right;">${fmt(systeme)}</td>
              <td style="padding:5px; border-bottom:1px solid #ddd; text-align:right;">${compte===null?'________':fmt(compte)}</td>
              <td style="padding:5px; border-bottom:1px solid #ddd; text-align:right;">${ecart===null?'':(ecart>0?'+':'')+fmt(ecart)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <div style="margin-top:30px; font-size:12px; display:flex; justify-content:space-between;">
        <div>Compté par : ________________________</div>
        <div>Signature : ________________________</div>
      </div>
    </div>`;
}

/* ---------- CLIENTS & DETTES ---------- */
export function renderClients(ctx){
  const { money } = ctx;
  const clients = ctx.magasinClients();
  return `
  <div class="topbar">
    <div><h1>Clients & Dettes</h1><p>Suivi des crédits et paiements partiels</p></div>
    <div class="topbar-actions"><button class="btn btn-primary" id="btn-new-client">+ Nouveau client</button></div>
  </div>
  <div class="client-grid">
    ${clients.length? clients.map(c=>{
      const dette = ctx.clientDette(c.id);
      const ventesClient = ctx.state.ventes.filter(v=>v.clientId===c.id);
      const totalAchats = ventesClient.reduce((s,v)=>s+v.total,0);
      const initiale = (c.nom||'?').trim().charAt(0).toUpperCase();
      return `<div class="client-card">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="cc-avatar">${initiale}</div>
          <div>
            <div class="cc-name">${c.nom}</div>
            <div class="cc-phone muted">${c.telephone||'Pas de téléphone'}</div>
          </div>
        </div>
        <div class="cc-stats">
          <div><span class="muted">Achats</span><br><b class="num">${ventesClient.length}</b></div>
          <div style="text-align:right;"><span class="muted">Total acheté</span><br><b class="num">${money(totalAchats)}</b></div>
        </div>
        <div class="cc-debt ${dette>0?'debt-pos':''}">${dette>0? '⚠ Dette : '+money(dette) : '✓ Aucune dette'}</div>
        <div class="cc-actions">
          ${dette>0?`<button class="btn btn-sm btn-gold" data-pay-dette="${c.id}">Paiement</button>`:''}
          <button class="btn btn-sm" data-edit-client="${c.id}">Modifier</button>
          <button class="btn btn-sm btn-danger" data-del-client="${c.id}">Suppr.</button>
        </div>
      </div>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1;">Aucun client pour ce magasin.</div>`}
  </div>`;
}

/* ---------- CAISSE ---------- */
export function renderCaisse(ctx){
  const { money } = ctx;
  const movs = ctx.magasinCaisse().slice().sort((a,b)=>new Date(b.date)-new Date(a.date));
  const entrees = movs.filter(m=>m.type==='entree').reduce((s,m)=>s+m.montant,0);
  const sorties = movs.filter(m=>m.type==='sortie').reduce((s,m)=>s+m.montant,0);
  return `
  <div class="topbar">
    <div><h1>Caisse</h1><p>Suivi des entrées et sorties d'espèces</p></div>
    <div class="topbar-actions">
      <button class="btn" id="btn-caisse-entree">+ Entrée manuelle</button>
      <button class="btn btn-danger" id="btn-caisse-sortie">+ Sortie / Dépense</button>
    </div>
  </div>
  <div class="kpi-row">
    <div class="kpi pos"><div class="lbl">Total entrées</div><div class="val num">${money(entrees)}</div></div>
    <div class="kpi neg"><div class="lbl">Total sorties</div><div class="val num">${money(sorties)}</div></div>
    <div class="kpi"><div class="lbl">Solde de caisse</div><div class="val num">${money(entrees-sorties)}</div></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Date</th><th>Type</th><th>Motif</th><th>Source</th><th>Employé</th><th class="right">Montant</th></tr></thead>
      <tbody>
        ${movs.length? movs.map(m=>`
          <tr>
            <td class="muted">${new Date(m.date).toLocaleString('fr-FR')}</td>
            <td><span class="badge ${m.type==='entree'?'cash':'credit'}">${m.type==='entree'?'Entrée':'Sortie'}</span></td>
            <td>${m.motif}</td><td class="muted">${m.source}</td><td class="muted">${ctx.empName(m.employeId)}</td>
            <td class="right num" style="color:${m.type==='entree'?'var(--green)':'var(--red)'};font-weight:700;">${m.type==='entree'?'+':'-'}${money(m.montant)}</td>
          </tr>`).join('') : `<tr><td colspan="6" class="empty">Aucun mouvement de caisse.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

/* ---------- DEPENSES ---------- */
export function renderDepenses(ctx){
  const { money, period } = ctx;
  const start = ctx.periodBounds(period);
  const all = ctx.magasinCaisse().filter(ctx.isDepense).slice().sort((a,b)=>new Date(b.date)-new Date(a.date));
  const totalPeriode = all.filter(m=>new Date(m.date)>=start).reduce((s,m)=>s+m.montant,0);
  return `
  <div class="topbar">
    <div><h1>Dépenses</h1><p>Achats, loyer, salaires et autres sorties d'argent</p></div>
    <div class="topbar-actions"><button class="btn btn-danger" id="btn-new-depense">+ Nouvelle dépense</button></div>
  </div>
  <div class="kpi-row">
    <div class="kpi neg"><div class="lbl">Total dépenses (${period==='today'?"aujourd'hui":period==='week'?'7 jours':period==='month'?'ce mois':'tout'})</div><div class="val num">${money(totalPeriode)}</div></div>
    <div class="kpi"><div class="lbl">Nombre de dépenses</div><div class="val num">${all.filter(m=>new Date(m.date)>=start).length}</div></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Date</th><th>Motif</th><th>Catégorie</th><th>Employé</th><th class="right">Montant</th></tr></thead>
      <tbody>
        ${all.length? all.map(m=>`
          <tr><td class="muted">${new Date(m.date).toLocaleString('fr-FR')}</td><td>${m.motif}</td>
          <td class="muted">${m.source==='payroll'?'Salaire':'Dépense'}</td><td class="muted">${ctx.empName(m.employeId)}</td>
          <td class="right num" style="color:var(--red); font-weight:700;">-${money(m.montant)}</td></tr>`).join('') : `<tr><td colspan="5" class="empty">Aucune dépense enregistrée.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

/* ---------- RAPPORT JOURNALIER ---------- */
export function todayISOLocal(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
export function rapportDuJour(ctx, dateStr){
  const start = new Date(dateStr+'T00:00:00');
  const end = new Date(dateStr+'T23:59:59.999');
  const dansLaJournee = d => { const dt = new Date(d); return dt>=start && dt<=end; };
  const ventes = ctx.magasinVentes().filter(v=>dansLaJournee(v.date)).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const proformas = ctx.magasinProformas().filter(p=>dansLaJournee(p.date)).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const paiementsDette = [];
  ctx.magasinVentes().forEach(v=>{ (v.paiements||[]).forEach(p=>{ if(dansLaJournee(p.date)) paiementsDette.push({...p, venteNumero:v.numero, clientNom: v.clientId?ctx.clientName(v.clientId):'—'}); }); });
  paiementsDette.sort((a,b)=>new Date(a.date)-new Date(b.date));
  const depenses = ctx.magasinCaisse().filter(m=>ctx.isDepense(m) && dansLaJournee(m.date));
  const ca = ventes.reduce((s,v)=>s+v.total,0);
  const cmv = ventes.reduce((s,v)=>s+v.coutTotal,0);
  const totalDepenses = depenses.reduce((s,m)=>s+m.montant,0);
  const beneficeNet = (ca-cmv) - totalDepenses;
  const parMode = {};
  ventes.forEach(v=>{ parMode[v.modePaiement] = (parMode[v.modePaiement]||0) + v.montantPaye; });
  return {ventes, proformas, paiementsDette, depenses, ca, cmv, totalDepenses, beneficeNet, parMode};
}
export function renderRapport(ctx){
  const { money } = ctx;
  const dateStr = ctx.rapportDate || todayISOLocal();
  const r = rapportDuJour(ctx, dateStr);
  const labels = {cash:'Espèces',banque:'Banque',moncash:'MonCash',credit:'Crédit'};
  const colors = {cash:'#2f7d5a',banque:'#2b52a3',moncash:'#7c3aa8',credit:'#b7791f'};
  const pieData = Object.keys(r.parMode).filter(k=>r.parMode[k]>0).map(k=>({label:labels[k]||k, value:r.parMode[k], color:colors[k]||'#5b6577'}));
  return `
  <div class="topbar">
    <div><h1>Rapport journalier</h1><p>Vérification de toutes les opérations d'une journée par l'administrateur</p></div>
    <div class="topbar-actions"><input type="date" id="rapport-date" value="${dateStr}"><button class="btn btn-sm btn-gold" id="btn-export-rapport">📤 Exporter CSV</button></div>
  </div>
  <div class="kpi-row">
    <div class="kpi"><div class="lbl">Chiffre d'affaires</div><div class="val num">${money(r.ca)}</div><div class="sub">${r.ventes.length} vente(s)</div></div>
    <div class="kpi neg"><div class="lbl">Dépenses</div><div class="val num">${money(r.totalDepenses)}</div></div>
    <div class="kpi pos"><div class="lbl">Bénéfice net</div><div class="val num">${money(r.beneficeNet)}</div></div>
    <div class="kpi gold"><div class="lbl">Proformas générées</div><div class="val num">${r.proformas.length}</div></div>
  </div>
  <div class="panel"><h3>Ventes du jour (comptant &amp; crédit)</h3>
    <div class="table-wrap"><table><thead><tr><th>N°</th><th>Heure</th><th>Client</th><th>Mode</th><th class="right">Total</th><th class="right">Payé</th><th class="right">Reste</th></tr></thead><tbody>
      ${r.ventes.length? r.ventes.map(v=>`<tr><td><b>${v.numero}</b></td><td class="muted">${new Date(v.date).toLocaleTimeString('fr-FR')}</td><td>${v.clientId?ctx.clientName(v.clientId):'Comptant'}</td><td><span class="badge ${v.modePaiement}">${v.modePaiement}</span></td><td class="right num">${money(v.total)}</td><td class="right num">${money(v.montantPaye)}</td><td class="right num" style="${v.reste>0?'color:var(--red);font-weight:700;':''}">${money(v.reste)}</td></tr>`).join('') : `<tr><td colspan="7" class="empty">Aucune vente ce jour.</td></tr>`}
    </tbody></table></div>
  </div>
  <div class="panel"><h3>Proforma générées ce jour</h3>
    <div class="table-wrap"><table><thead><tr><th>N°</th><th>Heure</th><th>Client</th><th class="right">Total</th></tr></thead><tbody>
      ${r.proformas.length? r.proformas.map(p=>`<tr><td><b>${p.numero}</b></td><td class="muted">${new Date(p.date).toLocaleTimeString('fr-FR')}</td><td>${p.clientId?ctx.clientName(p.clientId):(p.clientNomLibre||'—')}</td><td class="right num">${money(p.total)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">Aucune proforma ce jour.</td></tr>`}
    </tbody></table></div>
  </div>
  <div class="grid-2">
    <div class="panel"><h3>Paiements de dettes reçus</h3>
      ${r.paiementsDette.length? r.paiementsDette.map(p=>`<div class="alert-item"><span>${new Date(p.date).toLocaleTimeString('fr-FR')} · ${p.clientNom} · Fiche ${p.venteNumero} <span class="muted">(${p.mode})</span></span><span class="num">${money(p.montant)}</span></div>`).join('') : `<div class="muted">Aucun paiement reçu ce jour.</div>`}
    </div>
    <div class="panel"><h3>Répartition des encaissements</h3>${renderPieChart(pieData)}</div>
  </div>
  <div class="panel"><h3>Dépenses du jour</h3>
    ${r.depenses.length? r.depenses.map(m=>`<div class="alert-item"><span>${new Date(m.date).toLocaleTimeString('fr-FR')} · ${m.motif}</span><span class="num" style="color:var(--red);">-${money(m.montant)}</span></div>`).join('') : `<div class="muted">Aucune dépense ce jour.</div>`}
  </div>`;
}

/* ---------- TRANSFERT ENTRE MAGASINS ---------- */
export function renderTransfertsRoot(ctx){
  return ctx.transfertView==='nouveau' ? renderTransfertBuilder(ctx) : renderTransfertListe(ctx);
}
function transfertStatutBadge(t){
  if(t.statut==='recu') return `<span class="badge cash">Reçu</span>`;
  if(t.statut==='annule') return `<span class="badge" style="background:var(--red-bg);color:var(--red);">Annulé</span>`;
  return `<span class="badge credit">En transit</span>`;
}
function renderTransfertListe(ctx){
  const { state } = ctx;
  const historique = state.transferts.slice().sort((a,b)=>new Date(b.date)-new Date(a.date));
  return `
  <div class="topbar">
    <div><h1>Transfert entre magasins</h1><p>Le stock est retiré du magasin source à l'envoi, puis ajouté au magasin destinataire seulement après confirmation de réception</p></div>
    <div class="topbar-actions"><button class="btn btn-primary" id="btn-new-transfert" ${state.magasins.length<2?'disabled':''}>+ Nouveau transfert</button></div>
  </div>
  ${state.magasins.length<2? `<div class="empty">Il faut au moins deux magasins pour effectuer un transfert.</div>` : ''}
  <div class="table-wrap">
    <table>
      <thead><tr><th>N°</th><th>Date</th><th>De</th><th>Vers</th><th>Articles</th><th class="right">Unités</th><th>Par</th><th>Statut</th><th></th></tr></thead>
      <tbody>
        ${historique.length? historique.map(t=>{
          const src = state.magasins.find(m=>m.id===t.magasinSourceId);
          const dst = state.magasins.find(m=>m.id===t.magasinDestId);
          const totalUnites = t.items.reduce((s,i)=>s+i.qte,0);
          const peutConfirmer = t.statut==='en_transit' && state.currentMagasinId===t.magasinDestId;
          const peutAnnuler = t.statut==='en_transit' && ctx.isAdminConnecte();
          return `<tr>
            <td><b>${t.numero}</b></td>
            <td class="muted">${new Date(t.date).toLocaleString('fr-FR')}</td>
            <td>${src?src.nom:'—'}</td>
            <td>${dst?dst.nom:'—'}</td>
            <td class="muted">${t.items.map(i=>i.nom+' ×'+i.qte).join(', ')}</td>
            <td class="right num">${ctx.fmt(totalUnites)}</td>
            <td class="muted">${ctx.empName(t.employeId)}</td>
            <td>${transfertStatutBadge(t)}${t.statut==='recu' && t.dateReception? `<div class="muted" style="font-size:11px; margin-top:3px;">${new Date(t.dateReception).toLocaleString('fr-FR')}</div>`:''}</td>
            <td class="right">
              ${peutConfirmer? `<button class="btn btn-sm btn-gold" data-confirmer-transfert="${t.id}">✔ Confirmer réception</button>`:''}
              ${peutAnnuler? `<button class="btn btn-sm btn-danger" data-annuler-transfert="${t.id}">Annuler</button>`:''}
            </td>
          </tr>`;
        }).join('') : `<tr><td colspan="9" class="empty">Aucun transfert effectué.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
function renderTransfertBuilder(ctx){
  const { state } = ctx;
  const produitsSrc = state.produits.filter(p=>p.magasinId===ctx.transfertSourceId && !p.archive);
  return `
  <div class="topbar">
    <div><h1>Nouveau transfert</h1><p>Choisissez le magasin source, la destination, puis les articles à envoyer</p></div>
    <div class="topbar-actions"><button class="btn" id="btn-transfert-retour">← Retour à la liste</button></div>
  </div>
  <div class="row2" style="max-width:600px; margin-bottom:16px;">
    <div class="field"><label>Magasin source (sortie de stock)</label>
      <select id="transfert-source">${state.magasins.map(m=>`<option value="${m.id}" ${m.id===ctx.transfertSourceId?'selected':''}>${m.nom}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Magasin destination (entrée de stock)</label>
      <select id="transfert-dest">
        <option value="">— Sélectionner —</option>
        ${state.magasins.filter(m=>m.id!==ctx.transfertSourceId).map(m=>`<option value="${m.id}" ${m.id===ctx.transfertDestId?'selected':''}>${m.nom}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="pos-grid">
    <div>
      <div class="prod-pick">
        ${produitsSrc.length? produitsSrc.map(p=>{
          const stock = ctx.stockUnites(p);
          return `<div class="prod-card ${stock<=0?'out':''}">
            <div class="pn">${p.nom}</div>
            <div class="pq">Stock source : ${stock} unité(s)</div>
            <button class="btn btn-sm btn-primary" data-transfert-add="${p.id}" ${stock<=0?'disabled':''} style="width:100%; margin-top:7px;">+ Ajouter</button>
          </div>`;
        }).join('') : `<div class="empty" style="grid-column:1/-1;">Ce magasin n'a aucun produit à transférer.</div>`}
      </div>
    </div>
    <div class="panel" style="margin-bottom:0;">
      <h3>Articles à transférer</h3>
      ${ctx.transfertCart.length? ctx.transfertCart.map((i,idx)=>`
        <div class="cart-item">
          <span class="ci-name">${i.nom}</span>
          <input type="number" min="1" data-transfert-qty="${idx}" value="${i.qte}">
          <button class="btn btn-sm btn-danger" data-transfert-remove="${idx}">✕</button>
        </div>`).join('') : `<div class="muted" style="padding:10px 0;">Aucun article sélectionné.</div>`}
      <button class="btn btn-primary" id="btn-open-confirm-transfert" style="width:100%; justify-content:center; margin-top:16px; padding:12px;" ${ctx.transfertCart.length===0 || !ctx.transfertDestId?'disabled':''}>✔ Confirmer le transfert</button>
    </div>
  </div>`;
}

/* ---------- HISTORIQUE DES ACHATS ---------- */
export function achatsFiltres(ctx){
  let achats = ctx.magasinAchats();
  if(ctx.achatFiltreDateDebut){
    const debut = new Date(ctx.achatFiltreDateDebut); debut.setHours(0,0,0,0);
    achats = achats.filter(a=> new Date(a.date) >= debut);
  }
  if(ctx.achatFiltreDateFin){
    const fin = new Date(ctx.achatFiltreDateFin); fin.setHours(23,59,59,999);
    achats = achats.filter(a=> new Date(a.date) <= fin);
  }
  return achats;
}
export function renderAchats(ctx){
  const { money, fmt } = ctx;
  const achats = achatsFiltres(ctx);
  const totalGeneral = achats.reduce((s,a)=>s+a.prixTotal,0);
  return `
  <div class="topbar">
    <div><h1>Historique des achats</h1><p>Suivi des réapprovisionnements et achats fournisseurs</p></div>
    <div class="topbar-actions"><button class="btn btn-primary" id="btn-new-achat">+ Nouvel achat</button></div>
  </div>
  <div class="panel" style="padding:14px 16px; margin-bottom:14px;">
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
      <div class="field" style="margin:0;"><label>Du</label><input type="date" id="achat-filtre-date-debut" value="${ctx.achatFiltreDateDebut}"></div>
      <div class="field" style="margin:0;"><label>Au</label><input type="date" id="achat-filtre-date-fin" value="${ctx.achatFiltreDateFin}"></div>
      <button class="btn btn-sm" id="btn-reset-filtres-achats">✕ Réinitialiser</button>
      <button class="btn btn-sm btn-gold" id="btn-export-achats">📤 Exporter CSV</button>
    </div>
  </div>
  <div class="kpi-row">
    <div class="kpi"><div class="lbl">Total des achats enregistrés</div><div class="val num">${money(totalGeneral)}</div></div>
    <div class="kpi"><div class="lbl">Nombre d'achats</div><div class="val num">${achats.length}</div></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Date</th><th>Produit</th><th>Fournisseur</th><th class="right">Quantité</th><th class="right">Prix unitaire</th><th class="right">Total</th><th>Par</th><th></th></tr></thead>
      <tbody>
        ${achats.length? achats.map(a=>`
          <tr>
            <td class="muted">${new Date(a.date).toLocaleDateString('fr-FR')}</td>
            <td><b>${a.nom}</b></td>
            <td class="muted">${a.fournisseur||'—'}</td>
            <td class="right num">${fmt(a.quantite)}</td>
            <td class="right num">${money(a.quantite>0? a.prixTotal/a.quantite : 0)}</td>
            <td class="right num">${money(a.prixTotal)}</td>
            <td class="muted">${ctx.empName(a.employeId)}</td>
            <td class="right"><button class="btn btn-sm btn-danger" data-del-achat="${a.id}">Suppr.</button></td>
          </tr>`).join('') : `<tr><td colspan="8" class="empty">Aucun achat enregistré.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

/* ---------- EMPLOYES & PAIE ---------- */
export function renderEmployes(ctx){
  const { state, money } = ctx;
  const emps = ctx.magasinEmployes();
  const paiements = state.payrollPaiements.filter(p=>emps.some(e=>e.id===p.employeId)).slice().sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10);
  return `
  <div class="topbar">
    <div><h1>Employés & Paie</h1><p>Gestion des employés, rôles et salaires</p></div>
    <div class="topbar-actions"><button class="btn btn-primary" id="btn-new-employe">+ Nouvel employé</button></div>
  </div>
  <div class="table-wrap" style="margin-bottom:20px;">
    <table>
      <thead><tr><th>Nom</th><th>Rôle</th><th>Téléphone</th><th class="right">Salaire</th><th>Statut</th><th></th></tr></thead>
      <tbody>
        ${emps.length? emps.map(e=>`
          <tr><td><b>${e.nom}</b></td><td><span class="badge role-${e.role}">${e.role}</span></td>
          <td class="muted">${e.telephone||'—'}</td><td class="right num">${money(e.salaire)}</td>
          <td>${e.actif?'<span class="muted">Actif</span>':'<span style="color:var(--red);">Inactif</span>'}</td>
          <td class="right">
            <button class="btn btn-sm btn-gold" data-pay-salaire="${e.id}">Payer</button>
            <button class="btn btn-sm" data-edit-employe="${e.id}">Modifier</button>
            <button class="btn btn-sm btn-danger" data-del-employe="${e.id}">Suppr.</button>
          </td></tr>`).join('') : `<tr><td colspan="6" class="empty">Aucun employé.</td></tr>`}
      </tbody>
    </table>
  </div>
  <div class="panel"><h3>Derniers paiements de salaire</h3>
    ${paiements.length? paiements.map(p=>`<div class="alert-item"><span>${ctx.empName(p.employeId)} — ${p.periode||''}</span><span class="num">${money(p.montant)} · ${new Date(p.date).toLocaleDateString('fr-FR')}</span></div>`).join('') : `<div class="muted">Aucun paiement enregistré.</div>`}
  </div>`;
}

/* ---------- JOURNAL ---------- */
export function renderJournal(ctx){
  const { state } = ctx;
  const items = state.journal.slice(0,300);
  return `
  <div class="topbar"><div><h1>Journal d'activité</h1><p>Historique complet de toutes les actions du système</p></div></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Date</th><th>Action</th><th>Détails</th><th>Employé</th><th>Magasin</th></tr></thead>
      <tbody>
        ${items.length? items.map(j=>{
          const mag = state.magasins.find(m=>m.id===j.magasinId);
          return `<tr><td class="muted">${new Date(j.date).toLocaleString('fr-FR')}</td><td><b>${j.action}</b></td><td class="muted">${j.details||''}</td><td class="muted">${ctx.empName(j.employeId)}</td><td class="muted">${mag?mag.nom:'—'}</td></tr>`;
        }).join('') : `<tr><td colspan="5" class="empty">Aucune activité enregistrée.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

/* ---------- PARAMETRES ---------- */
export function renderParametres(ctx){
  const { state } = ctx;
  const s = state.settings;
  const queue = ctx.loadOfflineQueue();
  return `
  <div class="topbar"><div><h1>Paramètres</h1><p>Personnalisez votre système</p></div></div>

  ${queue.length? `<div class="panel" style="max-width:560px;">
    <h3>Ventes hors-ligne en attente</h3>
    <p class="muted" style="margin-top:-6px; font-size:12.5px;">Ventes faites pendant une coupure internet, pas encore confirmées par le serveur.</p>
    ${queue.map(item=>`<div class="alert-item">
      <span>${item.failed? `⚠ Échec — ${item.errorMessage||'erreur inconnue'}` : '⏳ En attente d\'envoi'}</span>
    </div>`).join('')}
    <button class="btn btn-primary" id="btn-retry-offline-sync" style="margin-top:10px;">🔄 Réessayer maintenant</button>
  </div>` : ''}

  <div class="panel" style="max-width:560px;">
    <h3>Apparence</h3>
    <div class="row2">
      <div class="field"><label>Couleur principale</label><input type="color" id="set-couleur-primaire" value="${s.couleurPrimaire||'#132340'}" style="height:42px; padding:2px; cursor:pointer;"></div>
      <div class="field"><label>Couleur d'accent</label><input type="color" id="set-couleur-accent" value="${s.couleurAccent||'#c8973f'}" style="height:42px; padding:2px; cursor:pointer;"></div>
    </div>
    <div class="muted" style="font-size:12px; margin-bottom:8px;">Ou choisissez un thème prédéfini :</div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
      ${ctx.THEME_PRESETS.map(t=>`<button type="button" class="btn btn-sm" data-theme-navy="${t.navy}" data-theme-gold="${t.gold}" style="display:flex;align-items:center;gap:6px;">
        <span style="width:13px;height:13px;border-radius:50%;background:${t.navy};display:inline-block;"></span>
        <span style="width:13px;height:13px;border-radius:50%;background:${t.gold};display:inline-block;"></span>
        ${t.nom}
      </button>`).join('')}
    </div>
    <button class="btn btn-primary" id="btn-save-theme">Appliquer et enregistrer</button>
  </div>

  <div class="panel" style="max-width:560px;">
    <h3>Identité du commerce</h3>
    <div style="display:flex; gap:14px; align-items:center; margin-bottom:14px;">
      ${s.logo? `<img src="${s.logo}" class="logo-preview">` : `<div class="logo-preview center" style="display:flex;align-items:center;justify-content:center;color:var(--ink-soft);font-size:11px;">Logo</div>`}
      <div>
        <input type="file" id="set-logo" accept="image/*">
        <div class="muted" style="font-size:11.5px; margin-top:4px;">Utilisé sur les fiches et proformas imprimées</div>
      </div>
    </div>
    <div class="field"><label>Nom du commerce</label><input id="set-nom" value="${s.nomCommerce}" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="words"></div>
    <div class="field"><label>Adresse</label><input id="set-adresse" value="${s.adresse||''}" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="sentences"></div>
    <div class="row2">
      <div class="field"><label>Téléphone</label><input id="set-telephone" value="${s.telephone||''}"></div>
      <div class="field"><label>Email</label><input id="set-email" value="${s.email||''}"></div>
    </div>
    <div class="field"><label>Monnaie utilisée</label>
      <select id="set-devise">
        <option value="HTG" ${s.devise==='HTG'?'selected':''}>Gourdes (HTG)</option>
        <option value="USD" ${s.devise==='USD'?'selected':''}>Dollars (USD)</option>
      </select>
    </div>
    <button class="btn btn-primary" id="btn-save-settings">Enregistrer</button>
  </div>

  <div class="panel" style="max-width:640px;">
    <h3>Magasins</h3>
    ${state.magasins.map(m=>`<div class="alert-item">
      <span style="display:flex; align-items:center; gap:10px;">
        ${m.logo? `<img src="${m.logo}" style="width:32px;height:32px;object-fit:contain;border:1px solid var(--line);border-radius:6px;background:#fff;">` : ''}
        <span>${m.nom} <span class="muted">${m.adresse||''}</span></span>
      </span>
      <span>
        <button class="btn btn-sm" data-edit-magasin="${m.id}">Modifier</button>
        <button class="btn btn-sm btn-danger" data-del-magasin="${m.id}" ${state.magasins.length<=1?'disabled':''}>Suppr.</button>
      </span>
    </div>`).join('')}
    <button class="btn" id="btn-new-magasin" style="margin-top:12px;">+ Ajouter un magasin</button>
  </div>

  <div class="panel" style="max-width:560px;">
    <h3>Catégories de produits</h3>
    <p class="muted" style="margin-top:-6px; font-size:12.5px;">Créées ici, elles apparaissent ensuite comme suggestions dans le formulaire d'un produit.</p>
    ${state.categories.length? state.categories.slice().sort((a,b)=>a.nom.localeCompare(b.nom)).map(c=>`<div class="alert-item">
      <span>${c.nom}</span>
      <button class="btn btn-sm btn-danger" data-del-categorie="${c.id}">Suppr.</button>
    </div>`).join('') : `<div class="muted" style="padding:6px 0;">Aucune catégorie créée pour l'instant.</div>`}
    <div class="row2" style="margin-top:12px;">
      <input id="new-categorie-nom" placeholder="Ex: Boissons, Épicerie..." spellcheck="true" lang="fr" autocorrect="on" autocapitalize="words">
      <button class="btn btn-primary" id="btn-add-categorie">+ Ajouter</button>
    </div>
  </div>

  <div class="panel" style="max-width:640px;">
    <h3>Sauvegarde des données</h3>
    <p class="muted" style="margin-top:-6px; font-size:12.5px;">Les données sont stockées dans votre projet Supabase et partagées en temps réel entre tous les postes. Cet export sert de sauvegarde ponctuelle, pas de stockage principal.</p>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button class="btn btn-primary" id="btn-export-data">⬇ Télécharger une sauvegarde (.json)</button>
    </div>
  </div>`;
}

/* ---------- PROFORMA ---------- */
export function renderProforma(ctx){
  if(ctx.proformaView==='nouvelle') return renderProformaBuilder(ctx);
  const { money } = ctx;
  const list = ctx.magasinProformas().slice().sort((a,b)=>new Date(b.date)-new Date(a.date));
  return `
  <div class="topbar">
    <div><h1>Proforma</h1><p>Devis et factures proforma pour vos clients</p></div>
    <div class="topbar-actions"><button class="btn btn-primary" id="btn-new-proforma">+ Nouvelle proforma</button></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>N°</th><th>Date</th><th>Client</th><th class="right">Total</th><th></th></tr></thead>
      <tbody>
        ${list.length? list.map(pf=>`
          <tr><td><b>${pf.numero}</b></td><td class="muted">${new Date(pf.date).toLocaleDateString('fr-FR')}</td>
          <td>${pf.clientId? ctx.clientName(pf.clientId) : (pf.clientNomLibre||'—')}</td>
          <td class="right num">${money(pf.total)}</td>
          <td class="right">
            <button class="btn btn-sm" data-voir-proforma="${pf.id}">Voir</button>
            <button class="btn btn-sm" data-print-proforma="${pf.id}">Imprimer</button>
            <button class="btn btn-sm btn-gold" data-convert-proforma="${pf.id}">Convertir en vente</button>
            <button class="btn btn-sm btn-danger" data-del-proforma="${pf.id}">Suppr.</button>
          </td></tr>`).join('') : `<tr><td colspan="5" class="empty">Aucune proforma enregistrée.</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
function renderProformaBuilder(ctx){
  const { money } = ctx;
  const produits = ctx.magasinProduitsActifs();
  const clients = ctx.magasinClients();
  const total = ctx.cartTotal(ctx.proformaCart);
  return `
  <div class="topbar"><div><h1>Nouvelle proforma</h1><p>Devis sans impact sur le stock</p></div>
    <div class="topbar-actions"><button class="btn" id="btn-proforma-retour">← Retour à la liste</button></div>
  </div>
  <div class="pos-grid">
    <div>
      <div class="prod-pick">
        ${produits.length? produits.map(p=>{
          const lots = p.lots||[];
          return `<div class="prod-card">
            <div class="pn">${p.nom}</div>
            <div class="pp">${money(p.prixVenteDetail)} <span class="muted" style="font-weight:500;font-size:11px;">/ unité</span></div>
            <button class="btn btn-sm btn-primary" data-pf-add-detail="${p.id}" style="width:100%; margin-top:7px;">+ Détail</button>
            ${lots.length? `<select data-pf-lot-add="${p.id}" style="width:100%; margin-top:5px; padding:6px; border:1px solid var(--line); border-radius:6px; font-size:12px;">
              <option value="">+ Ajouter un lot...</option>
              ${lots.map(l=>`<option value="${l.id}">Lot de ${l.taille} — ${money(l.prix)}</option>`).join('')}
            </select>` : ''}
          </div>`;
        }).join('') : `<div class="empty" style="grid-column:1/-1;">Aucun produit.</div>`}
      </div>
    </div>
    <div class="panel" style="margin-bottom:0;">
      <h3>Articles du devis</h3>
      ${ctx.proformaCart.length? ctx.proformaCart.map((i,idx)=>`
        <div class="cart-item">
          <span class="ci-name">${i.nom} <span class="badge ${i.mode==='gros'?'credit':'cash'}" style="font-size:9.5px;">${i.mode==='gros'?'Lot':'Détail'}</span></span>
          <input type="number" min="1" data-pf-qty="${idx}" value="${i.qte}">
          <span class="num" style="width:80px;text-align:right;">${money(i.qte*i.prixVente)}</span>
          <button class="btn btn-sm btn-danger" data-pf-remove="${idx}">✕</button>
        </div>`).join('') : `<div class="muted" style="padding:10px 0;">Aucun article.</div>`}
      <div class="cart-total"><span>Total</span><span class="num">${money(total)}</span></div>

      <div class="field" style="margin-top:14px;"><label>Client existant (optionnel)</label>
        <select id="pf-client"><option value="">— Aucun —</option>${clients.map(c=>`<option value="${c.id}" ${ctx.proformaClientId===c.id?'selected':''}>${c.nom}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Ou nom du client (libre)</label><input id="pf-client-libre" value="${ctx.proformaClientNomLibre}" placeholder="Ex: Client de passage"></div>
      <div class="field"><label>Notes</label><textarea id="pf-notes" rows="2" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="sentences">${ctx.proformaNotes}</textarea></div>

      <button class="btn btn-primary" id="btn-save-proforma" style="width:100%; justify-content:center; padding:12px;" ${ctx.proformaCart.length===0?'disabled':''}>✔ Enregistrer & imprimer</button>
    </div>
  </div>`;
}
export function generateProformaHTML(ctx, pf){
  const { state, money, fmt } = ctx;
  const s = state.settings;
  const magasin = state.magasins.find(m=>m.id===pf.magasinId);
  const logo = (magasin && magasin.logo) || s.logo;
  const adresse = (magasin && magasin.adresse) || s.adresse;
  const telephone = (magasin && magasin.telephone) || s.telephone;
  return `
    <div style="font-family:'Inter',Arial,sans-serif; max-width:340px; margin:0 auto;">
      <div style="text-align:center; margin-bottom:10px;">
        ${logo? `<img src="${logo}" style="max-width:70px; max-height:70px; margin-bottom:6px;">` : ''}
        <div style="font-weight:800; font-size:16px;">${s.nomCommerce}</div>
        <div style="font-size:11px;">${magasin?magasin.nom:''}</div>
        ${adresse? `<div style="font-size:11px;">${adresse}</div>`:''}
        ${telephone? `<div style="font-size:11px;">Tél: ${telephone}</div>`:''}
      </div>
      <div style="text-align:center; font-weight:800; letter-spacing:1px; border:1px solid #000; padding:3px 0; margin-bottom:6px;">PROFORMA</div>
      <div style="border-top:1px dashed #000; border-bottom:1px dashed #000; padding:6px 0; font-size:12px;">
        N° ${pf.numero}<br>Date : ${new Date(pf.date).toLocaleDateString('fr-FR')}<br>
        Client : ${pf.clientId? ctx.clientName(pf.clientId) : (pf.clientNomLibre||'—')}<br>
      </div>
      <table style="width:100%; font-size:12px; margin-top:6px;">
        ${pf.items.map(i=>`<tr><td>${i.nom}${i.mode==='gros'?' (lot)':''}</td><td style="text-align:center;">x${i.qte}</td><td style="text-align:right;">${fmt(i.qte*i.prixVente)}</td></tr>`).join('')}
      </table>
      <div style="border-top:1px dashed #000; margin-top:8px; padding-top:6px; font-size:13px;">
        <div style="display:flex; justify-content:space-between;"><b>TOTAL</b><b>${money(pf.total)}</b></div>
      </div>
      ${pf.notes? `<div style="margin-top:8px; font-size:11px;">Notes : ${pf.notes}</div>`:''}
      <div style="text-align:center; margin-top:14px; font-size:10.5px;">Ce document est une offre de prix et ne constitue pas une facture. Valable 15 jours.</div>
    </div>`;
}

/* =========================================================
   MODALES
========================================================= */
export function renderModal(ctx){
  const fns = {produit:modalProduit, client:modalClient, employe:modalEmploye, payDette:modalPayDette,
    paySalaire:modalPaySalaire, caisseMouvement:modalCaisseMouvement, magasin:modalMagasin,
    confirmVente:modalConfirmVente, voirVente:modalVoirVente, payVente:modalPayVente, receiptPreview:modalReceiptPreview,
    voirProforma:modalVoirProforma, confirmTransfert:modalConfirmTransfert, changePassword:modalChangePassword, achat:modalAchat};
  return fns[ctx.editing.type] ? fns[ctx.editing.type](ctx) : '';
}

function modalChangePassword(ctx){
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>Changer mon mot de passe</h2>
    ${ctx.changePwError? `<div style="background:var(--red-bg); color:var(--red); padding:9px 12px; border-radius:8px; font-size:13px; margin-bottom:12px;">${ctx.changePwError}</div>`:''}
    <div class="field"><label>Nouveau mot de passe</label><input type="password" id="cp-new"></div>
    <div class="field"><label>Confirmer le nouveau mot de passe</label><input type="password" id="cp-new2"></div>
    <div class="muted" style="font-size:11.5px; margin-bottom:8px;">Géré par Supabase Auth — aucune saisie de l'ancien mot de passe n'est nécessaire tant que votre session est active.</div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-change-password">Enregistrer</button></div>
  </div></div>`;
}

function modalVoirProforma(ctx){
  const { state, money } = ctx;
  const pf = state.proformas.find(x=>x.id===ctx.editing.id);
  if(!pf) return `<div class="overlay" id="overlay"><div class="modal"><h2>Proforma introuvable</h2><div class="modal-actions"><button class="btn" id="btn-cancel">Fermer</button></div></div></div>`;
  const magasin = state.magasins.find(m=>m.id===pf.magasinId);
  return `<div class="overlay" id="overlay"><div class="modal wide">
    <h2>Proforma ${pf.numero}</h2>
    <div class="info-box">
      Date : ${new Date(pf.date).toLocaleString('fr-FR')} &nbsp;·&nbsp; Magasin : ${magasin?magasin.nom:''} &nbsp;·&nbsp; Par : ${ctx.empName(pf.employeId)}<br>
      Client : ${pf.clientId? ctx.clientName(pf.clientId) : (pf.clientNomLibre||'—')}
    </div>
    <table>
      <thead><tr><th>Article</th><th>Type</th><th class="right">Qté</th><th class="right">Prix unit.</th><th class="right">Sous-total</th></tr></thead>
      <tbody>${pf.items.map(i=>`<tr><td>${i.nom}</td><td class="muted">${i.mode==='gros'?'Lot':'Détail'}</td><td class="right num">${i.qte}</td><td class="right num">${money(i.prixVente)}</td><td class="right num">${money(i.qte*i.prixVente)}</td></tr>`).join('')}</tbody>
    </table>
    <div class="breakdown-row total"><span>Total</span><span class="num">${money(pf.total)}</span></div>
    ${pf.notes? `<div class="muted" style="margin-top:8px;">Notes : ${pf.notes}</div>` : ''}
    <div class="modal-actions" style="justify-content:space-between;">
      <div>
        <button class="btn" id="btn-reprint-proforma">🖨 Imprimer</button>
        <button class="btn btn-gold" id="btn-convert-proforma-modal">Convertir en vente</button>
      </div>
      <button class="btn" id="btn-cancel">Fermer</button>
    </div>
  </div></div>`;
}

function modalReceiptPreview(ctx){
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>Aperçu avant impression</h2>
    <div style="background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; max-height:60vh; overflow-y:auto;">${ctx.editing.html}</div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Fermer</button><button class="btn btn-primary" id="btn-do-print">🖨 Imprimer</button></div>
  </div></div>`;
}

function produitLiveInfoHTML(ctx, qpc,qc,qd,pa,pvd){
  qpc = qpc>0? qpc : 1;
  const total = (qc*qpc)+qd;
  const cout = pa/qpc;
  const mDetail = ctx.margePct(pvd, cout);
  const ok = pvd>0 && mDetail>0;
  const color = ok ? 'var(--green)' : 'var(--red)';
  const msg = ok ? '✅ Marge correcte' : (pvd>0 ? '⚠️ Marge négative ou nulle — vérifiez le prix' : '⚠️ Renseignez un prix de vente');
  return `Stock total : <b class="num">${ctx.fmt(total)} unité(s)</b> <span class="muted">(${ctx.fmt(qc)} caisse(s) × ${ctx.fmt(qpc)} + ${ctx.fmt(qd)} en détail)</span><br>
    Coût unitaire : <b class="num">${ctx.money(cout)}</b> &nbsp;·&nbsp;
    Marge détail : <b class="num" style="color:${color};">${mDetail.toFixed(1)}%</b> &nbsp;·&nbsp;
    <span style="color:${color}; font-weight:700;">${msg}</span>`;
}
function lotMarginText(ctx, p, taille, prix){
  const cout = ctx.coutUnitaire(p)*taille;
  const m = ctx.margePct(prix, cout);
  const ok = prix>0 && m>0;
  return `Coût du lot : ${ctx.money(cout)} · Marge : ${m.toFixed(1)}% ${ok?'✅':'⚠️'}`;
}
export function lotsEditorHTML(ctx, p){
  return ctx.productLotsDraft.map((l,idx)=>`
    <div class="row2" style="align-items:end; margin-bottom:6px; background:#f8f6f0; padding:8px; border-radius:8px;">
      <div class="field" style="margin-bottom:0;"><label>Taille du lot (unités)</label><input type="number" min="1" data-lot-taille="${idx}" value="${l.taille||0}"></div>
      <div class="field" style="margin-bottom:0;"><label>Prix du lot</label><input type="number" min="0" data-lot-prix="${idx}" value="${l.prix||0}"></div>
      <div style="grid-column:1/-1; display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
        <span class="muted" id="lot-margin-${idx}" style="font-size:11.5px;">${lotMarginText(ctx, p, l.taille||0, l.prix||0)}</span>
        <button type="button" class="btn btn-sm btn-danger" data-remove-lot="${idx}">Retirer</button>
      </div>
    </div>`).join('');
}
export { produitLiveInfoHTML, lotMarginText };

function modalProduit(ctx){
  const { state } = ctx;
  const p = ctx.editing.id ? state.produits.find(x=>x.id===ctx.editing.id) : {
    nom:'',categorie:'',prixAchat:0,quantiteParCaisse:1,prixVenteDetail:0,
    quantiteCaisse:0,quantiteDetail:0,stockInitial:0,stockMinimum:5,lots:[]
  };
  const categoriesExistantes = [...new Set([
    ...state.categories.map(c=>c.nom),
    ...state.produits.map(x=>x.categorie),
  ].filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const lotCaisse = (p.lots||[]).find(l=>l.taille===(p.quantiteParCaisse||1));
  return `<div class="overlay" id="overlay"><div class="modal wide">
    <h2>${ctx.editing.id?'Modifier le produit':'Nouveau produit'}</h2>
    <div class="row2">
      <div class="field"><label>Nom du produit</label><input id="f-nom" value="${p.nom}" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="sentences"></div>
      <div class="field"><label>Catégorie</label>
        <div style="display:flex; gap:6px;">
          <select id="f-categorie-select" style="flex:1;">
            <option value="">— Sans catégorie —</option>
            ${categoriesExistantes.map(c=>`<option value="${c}" ${p.categorie===c?'selected':''}>${c}</option>`).join('')}
            <option value="__new__">+ Créer une nouvelle catégorie...</option>
          </select>
          <button type="button" class="btn btn-sm" id="btn-cat-new-inline" title="Créer une nouvelle catégorie">+ Créer</button>
        </div>
      </div>
    </div>
    <div class="row2">
      <div class="field"><label>Quantité par caisse (unités)${aide("Combien d'unités il y a dans une caisse/carton de ce produit. Ex: une caisse de 24 sodas → 24.")}</label><input type="number" id="f-quantiteParCaisse" value="${p.quantiteParCaisse||1}" min="1"></div>
      <div class="field"><label>Prix d'achat (par caisse)${aide("Combien vous avez payé pour UNE caisse entière chez le fournisseur — pas le prix d'une seule unité.")}</label><input type="number" id="f-prixAchat" value="${p.prixAchat}" min="0"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Quantité de caisses en stock${aide("Vous pouvez entrer une valeur décimale si vous avez une caisse incomplète. Ex: 0.5 = une demi-caisse (les unités correspondantes seront ajoutées automatiquement).")}</label><input type="number" id="f-quantiteCaisse" value="${p.quantiteCaisse||0}" min="0" step="0.5"></div>
      <div class="field"><label>Unités en détail actuellement</label><input value="${ctx.fmt(p.quantiteDetail||0)} unité(s) — géré automatiquement" disabled>
        <div class="muted" style="font-size:11px; margin-top:3px;">Se met à jour automatiquement lors des ventes (une caisse est ouverte si besoin), ou si vous entrez une caisse incomplète ci-contre.</div>
      </div>
    </div>
    <div class="row2">
      <div class="field"><label>Prix de vente en détail (par unité)${aide("Le prix auquel vous vendez UNE seule unité au client.")}</label><input type="number" id="f-prixVenteDetail" value="${p.prixVenteDetail}" min="0"></div>
      <div class="field"><label>Prix de vente en gros (pour <span id="gros-qty-label">${p.quantiteParCaisse||1}</span> unité(s), soit 1 caisse)${aide("Optionnel : un prix spécial quand le client achète une caisse entière d'un coup, souvent moins cher qu'à l'unité.")}</label>
        <input type="number" id="f-prixVenteGros" min="0" value="${lotCaisse?lotCaisse.prix:''}" placeholder="Laisser vide si non applicable">
      </div>
    </div>
    <div class="info-box" id="live-info-box">${produitLiveInfoHTML(ctx, p.quantiteParCaisse||1, p.quantiteCaisse||0, p.quantiteDetail||0, p.prixAchat||0, p.prixVenteDetail||0)}</div>

    <div class="field">
      <label>Autres tailles de lot (optionnel — ex: lot de 3, 12 unités)${aide("D'autres formats de vente groupée en plus de la vente en gros par caisse, ex: un pack de 6.")}</label>
      <div id="lots-editor">${lotsEditorHTML(ctx, p)}</div>
      <button type="button" class="btn btn-sm" id="btn-add-lot-row">+ Ajouter un type de lot</button>
    </div>

    <div class="row2">
      ${ctx.editing.id
        ? `<div class="field"><label>Stock initial (référence, fixe)</label><input value="${ctx.fmt(p.stockInitial||0)} unité(s)" disabled>
             <button type="button" class="btn btn-sm" id="btn-recalc-stock-initial" style="margin-top:6px;">↻ Recalculer sur le stock actuel (${ctx.fmt(ctx.stockUnites(p))})</button>
           </div>`
        : `<div class="field"><label>Stock initial</label><input value="Calculé automatiquement à l'enregistrement" disabled></div>`}
      <div class="field"><label>Stock minimum (alerte)${aide("En dessous de cette quantité, le produit apparaît dans les alertes de stock bas.")}</label><input type="number" id="f-stockMinimum" value="${p.stockMinimum||0}" min="0"></div>
    </div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-produit">Enregistrer</button></div>
  </div></div>`;
}

function modalClient(ctx){
  const c = ctx.editing.id ? ctx.state.clients.find(x=>x.id===ctx.editing.id) : {nom:'',telephone:''};
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>${ctx.editing.id?'Modifier le client':'Nouveau client'}</h2>
    <div class="field"><label>Nom</label><input id="f-nom" value="${c.nom}" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="words"></div>
    <div class="field"><label>Téléphone</label><input id="f-telephone" value="${c.telephone||''}" spellcheck="false" autocorrect="off"></div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-client">Enregistrer</button></div>
  </div></div>`;
}

function modalEmploye(ctx){
  const e = ctx.editing.id ? ctx.state.employes.find(x=>x.id===ctx.editing.id) : {nom:'',role:'Caissier',telephone:'',email:'',salaire:0,actif:true};
  return `<div class="overlay" id="overlay"><div class="modal wide">
    <h2>${ctx.editing.id?"Modifier l'employé":'Nouvel employé'}</h2>
    <div class="field"><label>Nom complet</label><input id="f-nom" value="${e.nom}" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="words"></div>
    <div class="row2">
      <div class="field"><label>Étiquette du rôle (affichage)</label>
        <select id="f-role">
          <option value="Admin" ${e.role==='Admin'?'selected':''}>Admin</option>
          <option value="Gerant" ${e.role==='Gerant'?'selected':''}>Gérant</option>
          <option value="Caissier" ${e.role==='Caissier'?'selected':''}>Caissier</option>
          <option value="Personnalisé" ${e.role==='Personnalisé'?'selected':''}>Personnalisé</option>
        </select>
      </div>
      <div class="field"><label>Téléphone</label><input id="f-telephone" value="${e.telephone||''}" spellcheck="false" autocorrect="off"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Salaire (par période)</label><input type="number" id="f-salaire" value="${e.salaire||0}" min="0"></div>
      <div class="field"><label>Statut</label><select id="f-actif"><option value="true" ${e.actif?'selected':''}>Actif</option><option value="false" ${!e.actif?'selected':''}>Inactif</option></select></div>
    </div>

    <div class="field"><label>Email (identifiant de connexion)</label><input id="f-email" type="email" value="${e.email||''}"></div>
    <div class="field">
      <label>Accès au système</label>
      <div style="background:#f8f6f0; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-size:12.5px;">
        ${!ctx.isAdminConnecte() ? `<span class="muted">Seul un administrateur peut générer ou modifier les mots de passe.</span>` :
          ctx.editing.id ? `
          ${e.authUserId ? 'Un compte de connexion est déjà configuré pour cet agent.' : "Aucun compte de connexion — l'agent ne peut pas encore se connecter."}
          <div style="margin-top:8px;"><button type="button" class="btn btn-sm btn-gold" id="btn-generate-password">${e.authUserId?'↻ Régénérer un mot de passe':'🔑 Générer un mot de passe'}</button></div>
          ${ctx.generatedPasswordPreview? `<div style="margin-top:10px; background:var(--green-bg); color:var(--green); padding:8px 10px; border-radius:6px; font-weight:700;">Mot de passe généré : ${ctx.generatedPasswordPreview}<br><span style="font-weight:500; font-size:11px;">Notez-le maintenant et communiquez-le à l'agent — il ne sera plus jamais réaffiché.</span></div>` : ''}
        ` : `<span class="muted">Enregistrez d'abord l'employé, puis rouvrez sa fiche pour générer son mot de passe.</span>`}
      </div>
    </div>

    <div class="field">
      <label>Permissions (accès aux menus)</label>
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <button type="button" class="btn btn-sm" id="btn-preset-admin">Préréglage Admin</button>
        <button type="button" class="btn btn-sm" id="btn-preset-gerant">Préréglage Gérant</button>
        <button type="button" class="btn btn-sm" id="btn-preset-caissier">Préréglage Caissier</button>
      </div>
      <div style="display:grid; grid-template-columns:repeat(2,1fr); gap:6px 14px; background:#f8f6f0; border:1px solid var(--line); border-radius:8px; padding:12px 14px;">
        ${ctx.PERMS_ALL.map(key=>`
          <label style="display:flex; align-items:center; gap:8px; font-size:13px; font-weight:500;">
            <input type="checkbox" data-perm="${key}" ${ctx.permissionsDraft.includes(key)?'checked':''}> ${ctx.PERMS_LABELS[key]}
          </label>`).join('')}
      </div>
    </div>

    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-employe">Enregistrer</button></div>
  </div></div>`;
}

function modalPayDette(ctx){
  const c = ctx.state.clients.find(x=>x.id===ctx.editing.id);
  const dette = ctx.clientDette(c.id);
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>Paiement partiel — ${c.nom}</h2>
    <p class="muted">Dette actuelle : <b class="num">${ctx.money(dette)}</b></p>
    <div class="field"><label>Montant payé maintenant</label><input type="number" id="f-montant" min="0" max="${dette}" value="${dette}"></div>
    <div class="field"><label>Mode de paiement</label><select id="f-mode"><option value="cash">Espèces</option><option value="banque">Banque</option><option value="moncash">MonCash</option></select></div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-paydette">Enregistrer le paiement</button></div>
  </div></div>`;
}

function modalPayVente(ctx){
  const v = ctx.state.ventes.find(x=>x.id===ctx.editing.id);
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>Paiement partiel — Fiche ${v.numero}</h2>
    <p class="muted">Reste dû : <b class="num">${ctx.money(v.reste)}</b></p>
    <div class="field"><label>Montant payé maintenant</label><input type="number" id="f-montant" min="0" max="${v.reste}" value="${v.reste}"></div>
    <div class="field"><label>Mode de paiement</label><select id="f-mode"><option value="cash">Espèces</option><option value="banque">Banque</option><option value="moncash">MonCash</option></select></div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-payvente">Enregistrer le paiement</button></div>
  </div></div>`;
}

function modalPaySalaire(ctx){
  const e = ctx.state.employes.find(x=>x.id===ctx.editing.id);
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>Payer le salaire — ${e.nom}</h2>
    <div class="field"><label>Période</label><input id="f-periode" placeholder="Ex: Août 2026"></div>
    <div class="field"><label>Montant</label><input type="number" id="f-montant" value="${e.salaire||0}" min="0"></div>
    <div class="field"><label>Mode de paiement</label><select id="f-mode"><option value="cash">Espèces (caisse)</option><option value="banque">Banque</option><option value="moncash">MonCash</option></select></div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-paysalaire">Confirmer le paiement</button></div>
  </div></div>`;
}

function modalCaisseMouvement(ctx){
  const isEntree = ctx.editing.mode==='entree';
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>${isEntree?'Entrée de caisse':'Sortie de caisse / Dépense'}</h2>
    <div class="field"><label>Motif</label><input id="f-motif" placeholder="${isEntree?'Ex: Apport de fonds':'Ex: Achat fournitures, loyer...'}" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="sentences"></div>
    <div class="field"><label>Montant</label><input type="number" id="f-montant" min="0" value="0"></div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-caisse">Enregistrer</button></div>
  </div></div>`;
}

function modalMagasin(ctx){
  const m = ctx.editing.id ? ctx.state.magasins.find(x=>x.id===ctx.editing.id) : {nom:'', adresse:'', telephone:'', email:'', logo:''};
  const logoActuel = ctx.magasinLogoDraft!=null ? ctx.magasinLogoDraft : (m.logo||'');
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>${ctx.editing.id? 'Modifier le magasin' : 'Nouveau magasin'}</h2>
    <div style="display:flex; gap:14px; align-items:center; margin-bottom:14px;">
      ${logoActuel? `<img src="${logoActuel}" class="logo-preview">` : `<div class="logo-preview center" style="display:flex;align-items:center;justify-content:center;color:var(--ink-soft);font-size:11px;">Logo</div>`}
      <div><input type="file" id="magasin-logo" accept="image/*">
        <div class="muted" style="font-size:11px; margin-top:4px;">Logo propre à ce magasin (sinon le logo général est utilisé sur les fiches)</div>
      </div>
    </div>
    <div class="field"><label>Nom du magasin</label><input id="f-nom" value="${m.nom}" placeholder="Ex: Succursale Delmas" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="words"></div>
    <div class="field"><label>Adresse</label><input id="f-adresse" value="${m.adresse||''}" placeholder="Ex: Delmas 33" spellcheck="true" lang="fr" autocorrect="on" autocapitalize="sentences"></div>
    <div class="row2">
      <div class="field"><label>Téléphone</label><input id="f-telephone" value="${m.telephone||''}" spellcheck="false" autocorrect="off"></div>
      <div class="field"><label>Email</label><input id="f-email" value="${m.email||''}" spellcheck="false" autocorrect="off" autocapitalize="none"></div>
    </div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-magasin">${ctx.editing.id?'Enregistrer':'Créer'}</button></div>
  </div></div>`;
}

function modalConfirmTransfert(ctx){
  const { state, fmt } = ctx;
  const src = state.magasins.find(m=>m.id===ctx.transfertSourceId);
  const dst = state.magasins.find(m=>m.id===ctx.transfertDestId);
  const totalUnites = ctx.transfertCart.reduce((s,i)=>s+i.qte,0);
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>Envoyer le transfert</h2>
    <div class="breakdown-row"><span>De</span><span><b>${src?src.nom:''}</b></span></div>
    <div class="breakdown-row"><span>Vers</span><span><b>${dst?dst.nom:''}</b></span></div>
    <div style="margin:12px 0; max-height:220px; overflow-y:auto;">
      ${ctx.transfertCart.map(i=>`<div class="alert-item"><span>${i.nom}</span><span class="num">${i.qte} unité(s)</span></div>`).join('')}
    </div>
    <div class="breakdown-row total"><span>Total</span><span class="num">${fmt(totalUnites)} unité(s)</span></div>
    <div class="muted" style="font-size:12px; margin-top:6px;">Une fois validé, le stock sera retiré de "${src?src.nom:''}" immédiatement (marqué « en transit »). Il ne sera ajouté à "${dst?dst.nom:''}" qu'après confirmation de réception depuis ce magasin.</div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-valider-transfert">✔ Envoyer le transfert</button></div>
  </div></div>`;
}

function cvValiderDisabled(ctx){
  const total = ctx.venteTotalNet();
  const recu = ctx.posMontantRecu;
  const isPartial = ctx.posEncaissementPartiel;
  const insuffisant = !isPartial && recu<total;
  return (isPartial && !ctx.posClientId) || insuffisant || ctx.busy;
}
export { cvValiderDisabled };
function cvDynamicHTML(ctx){
  const total = ctx.venteTotalNet();
  const recu = ctx.posMontantRecu;
  const isPartial = ctx.posEncaissementPartiel;
  const reste = isPartial ? Math.max(0, total-recu) : 0;
  const monnaie = Math.max(0, recu-total);
  const insuffisant = !isPartial && recu<total;
  const clients = ctx.magasinClients();
  if(!isPartial){
    return `
    <div class="field"><label>Client (optionnel)</label>
      <select id="f-cv-client"><option value="">— Vente sans client enregistré —</option>${clients.map(c=>`<option value="${c.id}" ${ctx.posClientId===c.id?'selected':''}>${c.nom}</option>`).join('')}</select>
    </div>
    <div class="breakdown-row total"><span>Monnaie à remettre</span><span class="num" style="color:var(--green);">${ctx.money(monnaie)}</span></div>
      ${insuffisant? `<div class="muted" style="color:var(--red); font-size:12.5px; margin-top:4px;">Le montant reçu est inférieur au total. Cochez "Paiement partiel" si le client ne paie pas tout.</div>` : ''}`;
  }
  return `
    <div class="field"><label>Client (requis — encaissement partiel)</label>
      <select id="f-cv-client"><option value="">— Sélectionner un client —</option>${clients.map(c=>`<option value="${c.id}" ${ctx.posClientId===c.id?'selected':''}>${c.nom}</option>`).join('')}</select>
    </div>
    <div class="breakdown-row total"><span>Reste à créditer</span><span class="num" style="color:var(--red);">${ctx.money(reste)}</span></div>
    ${monnaie>0?`<div class="breakdown-row"><span>Monnaie à remettre</span><span class="num" style="color:var(--green);">${ctx.money(monnaie)}</span></div>`:''}
    <div class="muted" style="font-size:12px;">Le reste sera ajouté à la dette du client et pourra être réglé plus tard depuis la fiche de vente.</div>`;
}
export { cvDynamicHTML };
function modalConfirmVente(ctx){
  const total = ctx.venteTotalNet();
  const isPartial = ctx.posEncaissementPartiel;
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>Confirmer l'encaissement</h2>
    <div class="breakdown-row"><span>Total de la vente</span><span class="num">${ctx.money(total)}</span></div>
    <label style="display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; margin:12px 0; background:#f8f6f0; padding:9px 12px; border-radius:8px;">
      <input type="checkbox" id="cv-partial" ${isPartial?'checked':''}> ☐ Paiement partiel (le client ne paie pas tout maintenant)
    </label>
    <div class="field"><label>${isPartial? 'Montant payé maintenant' : 'Montant reçu du client'}</label><input type="number" id="f-montant-recu" min="0" value="${ctx.posMontantRecu}"></div>
    <div class="field"><label>Mode du versement reçu</label>
      <select id="f-deposit-mode">
        <option value="cash" ${ctx.posDepositMode==='cash'?'selected':''}>Espèces</option>
        <option value="banque" ${ctx.posDepositMode==='banque'?'selected':''}>Banque</option>
        <option value="moncash" ${ctx.posDepositMode==='moncash'?'selected':''}>MonCash</option>
      </select>
    </div>
    <div id="cv-dynamic">${cvDynamicHTML(ctx)}</div>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-valider-vente" ${cvValiderDisabled(ctx)?'disabled':''}>${ctx.busy?'Traitement...':"✔ Valider l'encaissement"}</button></div>
  </div></div>`;
}

function modalVoirVente(ctx){
  const { money } = ctx;
  const v = ctx.state.ventes.find(x=>x.id===ctx.editing.id);
  const magasin = ctx.state.magasins.find(m=>m.id===v.magasinId);
  return `<div class="overlay" id="overlay"><div class="modal wide">
    <h2>Fiche ${v.numero}</h2>
    <div class="info-box">
      Date : ${new Date(v.date).toLocaleString('fr-FR')} &nbsp;·&nbsp; Magasin : ${magasin?magasin.nom:''} &nbsp;·&nbsp; Caissier : ${ctx.empName(v.employeId)}<br>
      Client : ${v.clientId? ctx.clientName(v.clientId) : 'Comptant'} &nbsp;·&nbsp; Mode : <span class="badge ${v.modePaiement}">${v.modePaiement}</span>
    </div>
    <table>
      <thead><tr><th>Article</th><th>Type</th><th class="right">Qté</th><th class="right">Prix unit.</th><th class="right">Sous-total</th></tr></thead>
      <tbody>
        ${v.items.map(i=>`<tr><td>${i.nom}</td><td class="muted">${i.mode==='gros'?'Lot':'Détail'}</td><td class="right num">${i.qte}</td><td class="right num">${money(i.prixVente)}</td><td class="right num">${money(i.qte*i.prixVente)}</td></tr>`).join('')}
      </tbody>
    </table>
    ${v.remise>0? `<div class="breakdown-row"><span>Sous-total</span><span class="num">${money(v.totalBrut)}</span></div>
    <div class="breakdown-row"><span>Remise appliquée</span><span class="num" style="color:var(--red);">-${money(v.remise)}</span></div>` : ''}
    <div class="breakdown-row total"><span>Total</span><span class="num">${money(v.total)}</span></div>
    <div class="breakdown-row"><span>Montant reçu</span><span class="num">${money(v.montantRecu)}</span></div>
    ${v.monnaieRendue>0?`<div class="breakdown-row"><span>Monnaie rendue</span><span class="num">${money(v.monnaieRendue)}</span></div>`:''}
    <div class="breakdown-row"><span>Montant payé (encaissé)</span><span class="num">${money(v.montantPaye)}</span></div>
    <div class="breakdown-row"><span>Reste dû</span><span class="num" style="${v.reste>0?'color:var(--red);font-weight:700;':''}">${money(v.reste)}</span></div>

    ${v.paiements && v.paiements.length ? `
      <h3 style="margin-top:16px;">Historique des paiements</h3>
      ${v.paiements.map(p=>`<div class="alert-item"><span>${new Date(p.date).toLocaleString('fr-FR')} · ${p.mode}</span><span class="num">${money(p.montant)}</span></div>`).join('')}
    ` : ''}

    <div class="modal-actions" style="justify-content:space-between;">
      <div>
        ${v.reste>0? `<button class="btn btn-gold" id="btn-pay-vente">+ Paiement partiel</button>` : ''}
        <button class="btn" id="btn-reprint-vente">🖨 Réimprimer</button>
        ${ctx.isAdminConnecte()? `<button class="btn btn-gold" id="btn-modifier-vente">✎ Modifier</button><button class="btn btn-danger" id="btn-suppr-vente">Supprimer</button>` : ''}
      </div>
      <button class="btn" id="btn-cancel">Fermer</button>
    </div>
  </div></div>`;
}

function modalAchat(ctx){
  const produits = ctx.magasinProduits();
  return `<div class="overlay" id="overlay"><div class="modal">
    <h2>Nouvel achat / réapprovisionnement</h2>
    <div class="field"><label>Produit</label>
      <select id="f-achat-produit">${produits.length? produits.map(p=>`<option value="${p.id}">${p.nom}</option>`).join('') : '<option value="">Aucun produit</option>'}</select>
    </div>
    <div class="row2">
      <div class="field"><label>Date</label><input type="date" id="f-achat-date" value="${todayISOLocal()}"></div>
      <div class="field"><label>Fournisseur (optionnel)</label><input id="f-achat-fournisseur" placeholder="Ex: Distributeur XYZ"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Quantité achetée (unités)</label><input type="number" id="f-achat-quantite" min="1" value="1"></div>
      <div class="field"><label>Prix total payé</label><input type="number" id="f-achat-prixtotal" min="0" value="0"></div>
    </div>
    <label style="display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; margin:10px 0;">
      <input type="checkbox" id="f-achat-ajoutstock" checked> Ajouter cette quantité au stock du produit
    </label>
    <div class="modal-actions"><button class="btn" id="btn-cancel">Annuler</button><button class="btn btn-primary" id="btn-save-achat">Enregistrer</button></div>
  </div></div>`;
}
