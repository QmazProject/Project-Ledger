import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

async function captchaIsValid(token: string, secret: string) {
  const body = new URLSearchParams({ secret, response: token });
  const response = await fetch("https://hcaptcha.com/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return false;
  const result = await response.json().catch(() => ({}));
  return result.success === true;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { username, captcha_token } = await request.json();
    const normalizedUsername = String(username || "").trim().toLowerCase();
    const genericResponse = { ok: true };
    if (!normalizedUsername) return json(genericResponse);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const siteUrl = Deno.env.get("PUBLIC_SITE_URL") || "https://project-ledger-psi.vercel.app";
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: setting } = await admin.from("security_settings")
      .select("captcha_enabled").eq("id", 1).maybeSingle();
    const captchaEnabled = setting?.captcha_enabled !== false;
    if (captchaEnabled) {
      const secret = Deno.env.get("HCAPTCHA_SECRET");
      if (!secret || !captcha_token || !(await captchaIsValid(String(captcha_token), secret))) {
        return json(genericResponse);
      }
    }

    const { data, error } = await admin.rpc("consume_password_recovery", {
      p_username: normalizedUsername,
    });
    if (error || !data?.allowed || !data.email) return json(genericResponse);

    // The redirect is fixed server-side so a client cannot send reset tokens
    // to an untrusted destination.
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    await fetch(`${url}/auth/v1/recover`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: data.email,
        redirect_to: `${siteUrl}/reset-password`,
        ...(captchaEnabled ? { captcha_token } : {}),
      }),
    });
    return json(genericResponse);
  } catch (_error) {
    return json({ ok: true });
  }
});
