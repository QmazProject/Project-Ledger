import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

const LEDGER_UPLOAD_BUCKET = "project-ledger-uploads";

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
        .select("id, username, role, force_password_change, multiple_targets_enabled");
      if (profileError) throw profileError;
      const { data: uploads, error: uploadError } = await admin.from("project_ledger_uploads")
        .select("uploaded_by");
      if (uploadError) throw uploadError;
      const { data: security } = await admin.from("security_settings")
        .select("captcha_enabled").eq("id", 1).maybeSingle();
      const byId = new Map((profiles || []).map((p) => [p.id, p]));
      const uploadCounts = new Map<string, number>();
      for (const upload of uploads || []) {
        uploadCounts.set(upload.uploaded_by, (uploadCounts.get(upload.uploaded_by) || 0) + 1);
      }
      return json({ captcha_enabled: security?.captcha_enabled !== false, users: (data.users || []).map((u) => ({
        id: u.id,
        email: u.email || "",
        username: byId.get(u.id)?.username || "",
        role: byId.get(u.id)?.role || "user",
        force_password_change: byId.get(u.id)?.force_password_change || false,
        multiple_targets_enabled: byId.get(u.id)?.multiple_targets_enabled || false,
        banned_until: u.banned_until || null,
        last_sign_in_at: u.last_sign_in_at || null,
        upload_count: uploadCounts.get(u.id) || 0,
      })) });
    }

    if (action === "list-uploads") {
      const userId = String(body.user_id || "");
      if (!userId) return json({ error: "User ID is required." }, 400);
      const { data: uploads, error } = await admin.from("project_ledger_uploads")
        .select("id, original_filename, uploaded_at")
        .eq("uploaded_by", userId)
        .order("uploaded_at", { ascending: false });
      if (error) throw error;
      return json({ uploads: uploads || [] });
    }

    if (action === "file-url") {
      const uploadId = String(body.upload_id || "");
      if (!uploadId) return json({ error: "Upload ID is required." }, 400);
      const { data: upload, error: uploadError } = await admin.from("project_ledger_uploads")
        .select("storage_path, original_filename")
        .eq("id", uploadId)
        .maybeSingle();
      if (uploadError) throw uploadError;
      if (!upload) return json({ error: "Upload not found." }, 404);
      const download = body.download === true;
      const { data: signed, error: signedError } = await admin.storage
        .from(LEDGER_UPLOAD_BUCKET)
        .createSignedUrl(upload.storage_path, 60, download ? { download: upload.original_filename } : undefined);
      if (signedError) throw signedError;
      return json({ url: signed.signedUrl });
    }

    if (action === "set-captcha") {
      const enabled = body.enabled !== false;
      const { error } = await admin.from("security_settings")
        .update({ captcha_enabled: enabled, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) throw error;
      return json({ ok: true, captcha_enabled: enabled });
    }

    const userId = String(body.user_id || "");
    if (!userId) return json({ error: "User ID is required." }, 400);

    if (action === "set-multiple-targets") {
      const enabled = body.enabled === true;
      const { error } = await admin.from("profiles")
        .update({ multiple_targets_enabled: enabled }).eq("id", userId);
      if (error) throw error;
      return json({ ok: true, multiple_targets_enabled: enabled });
    }

    if (action === "reset-password") {
      const temporaryPassword = String(body.temporary_password || "");
      if (temporaryPassword.length < 6 || temporaryPassword.length > 8) return json({ error: "Temporary password must be between 6 and 8 characters." }, 400);
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
