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

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return json({ error: "Invalid session." }, 401);

    const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") return json({ error: "Administrator access required." }, 403);

    const body = await request.json().catch(() => ({}));
    const action = body.action;

    if (action === "list") {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const { data: profiles, error: profileError } = await admin.from("profiles")
        .select("id, username, role, force_password_change");
      if (profileError) throw profileError;
      const byId = new Map((profiles || []).map((p) => [p.id, p]));
      return json({ users: (data.users || []).map((u) => ({
        id: u.id,
        email: u.email || "",
        username: byId.get(u.id)?.username || "",
        role: byId.get(u.id)?.role || "user",
        force_password_change: byId.get(u.id)?.force_password_change || false,
        banned_until: u.banned_until || null,
        last_sign_in_at: u.last_sign_in_at || null,
      })) });
    }

    const userId = String(body.user_id || "");
    if (!userId) return json({ error: "User ID is required." }, 400);

    if (action === "reset-password") {
      const temporaryPassword = String(body.temporary_password || "");
      if (temporaryPassword.length < 2 || temporaryPassword.length > 8) return json({ error: "Temporary password must be between 2 and 8 characters." }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password: temporaryPassword,
      });
      if (error) throw error;
      const { error: profileError } = await admin.from("profiles")
        .update({ force_password_change: true }).eq("id", userId);
      if (profileError) throw profileError;
      return json({ ok: true });
    }

    if (action === "ban" || action === "unban") {
      const { error } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: action === "ban" ? "876000h" : "none",
      });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
