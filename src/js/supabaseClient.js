import { createClient } from "./vendor/supabase.esm.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

if (!SUPABASE_URL || SUPABASE_URL.includes("VOTRE-PROJET")) {
  // eslint-disable-next-line no-console
  console.warn("Configurez src/config.js avec les identifiants de votre projet Supabase (voir src/config.example.js).");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
