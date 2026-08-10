import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

async function captchaIsValid(token: string, secret: string, remoteIp: string | null) {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
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
      if (!secret || !captcha_token || !(await captchaIsValid(String(captcha_token), secret, request.headers.get("x-forwarded-for")))) {
        return json({ error: "Complete the CAPTCHA challenge first." }, 400);
      }
    }

    const { data: profile, error: profileError } = await admin.from("profiles")
      .select("id").eq("username", normalizedUsername).maybeSingle();
    if (profileError || !profile) return json({ error: "Invalid username or password." }, 401);
    const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(profile.id);
    const email = authUser?.user?.email;
    if (authUserError || !email) return json({ error: "Invalid username or password." }, 401);

    // The global Supabase Auth CAPTCHA setting must be disabled. This function
    // performs the conditional verification above instead.
    const auth = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data, error } = await auth.auth.signInWithPassword({ email, password: plainPassword });
    if (error || !data.session) return json({ error: error?.message || "Invalid username or password." }, 401);
    return json({ session: data.session });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
