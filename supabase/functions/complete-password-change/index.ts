import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Authentication required." }, 401);

    const password = String((await request.json().catch(() => ({}))).password || "");
    if (password.length < 6 || password.length > 8) {
      return json({ error: "Password must be between 6 and 8 characters." }, 400);
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return json({ error: "Invalid session." }, 401);

    const { data: profile, error: profileError } = await admin.from("profiles")
      .select("force_password_change").eq("id", user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile?.force_password_change) {
      return json({ error: "A temporary password change is not pending." }, 403);
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, { password });
    if (updateError) throw updateError;

    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
