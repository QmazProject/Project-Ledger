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
  if (!response.ok) return { ok: false, codes: [`http-${response.status}`] };
  const result = await response.json().catch(() => ({}));
  return { ok: result.success === true, codes: result["error-codes"] || [] };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { username, password, captcha_token } = await request.json().catch(() => ({}));
    const normalizedUsername = String(username || "").trim().toLowerCase();
    const plainPassword = String(password || "");
    if (!normalizedUsername || !plainPassword) return json({ error: "Username and password are required." }, 400);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: setting } = await admin.from("security_settings")
      .select("captcha_enabled").eq("id", 1).maybeSingle();
    const captchaEnabled = setting?.captcha_enabled !== false;

    if (captchaEnabled) {
      const secret = Deno.env.get("HCAPTCHA_SECRET");
      if (!secret) return json({ error: "CAPTCHA server secret is not configured." }, 500);
      if (!captcha_token) return json({ error: "Complete the CAPTCHA challenge first." }, 400);
      const verification = await captchaIsValid(String(captcha_token), secret);
      if (!verification.ok) {
        const detail = verification.codes.length ? ` (${verification.codes.join(", ")})` : "";
        return json({ error: `CAPTCHA verification failed${detail}. Check the hCaptcha site key, secret, and allowed domain.` }, 400);
      }
    }

    // Resolve the username through the existing security-definer function.
    // This replaces a profile lookup plus a separate admin user lookup with
    // one database round trip while keeping the auth.users table protected.
    const { data: email, error: emailError } = await admin.rpc("get_login_email", {
      p_username: normalizedUsername,
    });
    if (emailError || !email) return json({ error: "Invalid username or password." }, 401);

    // The global Supabase Auth CAPTCHA setting must be disabled. This function
    // performs the conditional verification above instead; passing the same
    // token to Auth would verify a single-use hCaptcha response twice.
    const auth = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data, error } = await auth.auth.signInWithPassword({ email, password: plainPassword });
    if (error || !data.session) return json({ error: error?.message || "Invalid username or password." }, 401);
    return json({ session: data.session });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
