// =========================================================
// Lakouwon POS — Edge Function: admin-employee
// =========================================================
// Gère la création des comptes d'authentification des employés
// et la génération/réinitialisation de leur mot de passe. Ces
// opérations nécessitent la clé "service role" de Supabase, qui
// ne doit JAMAIS être exposée au client — d'où cette fonction
// serveur (Deno, exécutée par Supabase Edge Functions).
//
// Déploiement :
//   supabase functions deploy admin-employee
//
// Variables d'environnement nécessaires (déjà fournies
// automatiquement par Supabase pour SUPABASE_URL et
// SUPABASE_SERVICE_ROLE_KEY dans l'environnement des Edge
// Functions) :
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//
// Actions (POST JSON { action, ...payload }) :
//   - "bootstrap"      : crée le tout premier compte Admin.
//                        Refusée dès qu'un employé existe déjà.
//   - "set_password"   : (réservée aux Admins) crée le compte
//                        d'authentification d'un employé existant
//                        s'il n'en a pas, ou réinitialise son mot
//                        de passe sinon. Retourne le mot de passe
//                        généré UNE SEULE FOIS.
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function generatePassword(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Corps JSON invalide" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const action = payload.action;

  // -------------------------------------------------------
  // BOOTSTRAP — premier compte Admin, une seule fois.
  // -------------------------------------------------------
  if (action === "bootstrap") {
    const { nom, email, password } = payload as { nom?: string; email?: string; password?: string };
    if (!nom || !email || !password) return json({ error: "nom, email et password sont requis" }, 400);
    if (password.length < 6) return json({ error: "Le mot de passe doit contenir au moins 6 caractères" }, 400);

    const { count, error: countError } = await admin.from("employes").select("id", { count: "exact", head: true });
    if (countError) return json({ error: countError.message }, 500);
    if ((count ?? 0) > 0) {
      return json({ error: "Un compte existe déjà — le bootstrap est désactivé. Utilisez set_password (Admin connecté)." }, 403);
    }

    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({
      email: String(email).toLowerCase(),
      password,
      email_confirm: true,
    });
    if (userErr) return json({ error: userErr.message }, 400);

    const { data: magasin } = await admin.from("magasins").select("id").limit(1).maybeSingle();

    const { data: employe, error: empErr } = await admin
      .from("employes")
      .insert({
        auth_user_id: userRes.user.id,
        nom,
        role: "Admin",
        magasin_id: magasin?.id ?? null,
        email: String(email).toLowerCase(),
        permissions: [
          "dashboard","vente","fiches","proforma","produits","clients","caisse",
          "depenses","transferts","achats","rapport","employes","journal","parametres",
        ],
        actif: true,
      })
      .select()
      .single();
    if (empErr) {
      await admin.auth.admin.deleteUser(userRes.user.id);
      return json({ error: empErr.message }, 500);
    }

    return json({ employe });
  }

  // -------------------------------------------------------
  // Actions réservées aux Admins connectés : vérifier le JWT
  // de l'appelant avant toute autre chose.
  // -------------------------------------------------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr2 } = await callerClient.auth.getUser();
  if (userErr2 || !userData?.user) return json({ error: "Non authentifié" }, 401);

  const { data: callerEmploye, error: callerErr } = await admin
    .from("employes")
    .select("id, role, actif")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();
  if (callerErr) return json({ error: callerErr.message }, 500);
  if (!callerEmploye || !callerEmploye.actif || callerEmploye.role !== "Admin") {
    return json({ error: "Seul un administrateur peut gérer les comptes" }, 403);
  }

  // -------------------------------------------------------
  // SET_PASSWORD — crée le compte Auth s'il n'existe pas, sinon
  // réinitialise le mot de passe. Retourne le mot de passe en
  // clair une seule fois (comme dans l'app d'origine).
  // -------------------------------------------------------
  if (action === "set_password") {
    const { employe_id, email } = payload as { employe_id?: string; email?: string };
    if (!employe_id || !email) return json({ error: "employe_id et email sont requis" }, 400);

    const { data: target, error: targetErr } = await admin
      .from("employes")
      .select("id, auth_user_id, nom")
      .eq("id", employe_id)
      .maybeSingle();
    if (targetErr) return json({ error: targetErr.message }, 500);
    if (!target) return json({ error: "Employé introuvable" }, 404);

    const password = generatePassword(10);
    const normalizedEmail = String(email).toLowerCase();

    if (target.auth_user_id) {
      const { error: updErr } = await admin.auth.admin.updateUserById(target.auth_user_id, {
        password,
        email: normalizedEmail,
        email_confirm: true,
      });
      if (updErr) return json({ error: updErr.message }, 400);
      const { error: rowErr } = await admin.from("employes").update({ email: normalizedEmail }).eq("id", employe_id);
      if (rowErr) return json({ error: rowErr.message }, 500);
    } else {
      const { data: userRes, error: createErr } = await admin.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
      });
      if (createErr) return json({ error: createErr.message }, 400);
      const { error: rowErr } = await admin
        .from("employes")
        .update({ email: normalizedEmail, auth_user_id: userRes.user.id })
        .eq("id", employe_id);
      if (rowErr) {
        await admin.auth.admin.deleteUser(userRes.user.id);
        return json({ error: rowErr.message }, 500);
      }
    }

    await admin.from("journal").insert({
      action: "Mot de passe généré",
      details: target.nom,
      employe_id: callerEmploye.id,
    });

    return json({ password });
  }

  return json({ error: "Action inconnue" }, 400);
});
