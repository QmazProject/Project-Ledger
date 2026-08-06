import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/* true only when both values are present — the UI shows a setup notice otherwise */
export const isConfigured = Boolean(url && anonKey);

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,      // stay signed in across reloads
        autoRefreshToken: true,
        detectSessionInUrl: false, // no magic-link / OAuth redirects in this app
      },
    })
  : null;
