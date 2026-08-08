# hCaptcha Protection with Supabase

This guide explains how hCaptcha protects the Project Ledger authentication flow and how to reuse the same setup in future Supabase applications.

## 1. How the protection works

There are two keys:

- **Site key**: public. This is used by the frontend to display the hCaptcha widget.
- **Secret key**: private. This is entered in Supabase and must never be placed in frontend code, Git, or Vercel public variables.

The flow is:

```text
User opens sign-in form
        ↓
hCaptcha widget appears
        ↓
User completes the challenge
        ↓
hCaptcha returns a temporary token
        ↓
Frontend sends the token to Supabase Auth
        ↓
Supabase verifies the token using the secret key
        ↓
Sign-in or password recovery is accepted/rejected
```

A site key by itself is not enough. The application must render the widget and send its token as `captchaToken` or `captcha_token` with the Auth request.

## 2. Create hCaptcha keys

1. Open [hCaptcha](https://www.hcaptcha.com/).
2. Create or open an account.
3. Create a new site.
4. Add the domains where the application will run, for example:

   ```text
   project-ledger-psi.vercel.app
   localhost
   ```

5. Copy both values:

   - Site key
   - Secret key

Use the same hCaptcha provider in Supabase that was selected when the keys were created.

## 3. Configure Supabase

In the Supabase Dashboard:

1. Open the project.
2. Go to **Authentication**.
3. Open **Bot and Abuse Protection** or **CAPTCHA Protection**.
4. Enable CAPTCHA protection.
5. Select **hCaptcha**.
6. Paste the hCaptcha **Secret key**.
7. Save the changes.

The secret key stays in Supabase. Do not put it in `VITE_*` variables.

Also configure the application URL:

1. Go to **Authentication → URL Configuration**.
2. Set the production Site URL:

   ```text
   https://project-ledger-psi.vercel.app
   ```

3. Add the password reset redirect URL:

   ```text
   https://project-ledger-psi.vercel.app/reset-password
   ```

For local testing, also add the appropriate localhost URL.

## 4. Configure the frontend site key

In Vercel:

1. Open the project.
2. Go to **Settings → Environment Variables**.
3. Add this variable:

   ```text
   VITE_HCAPTCHA_SITE_KEY=your-public-hcaptcha-site-key
   ```

The application also accepts `VITE_CAPTCHA_SITE_KEY`, but `VITE_HCAPTCHA_SITE_KEY` is the preferred name.

Enable the variable for the correct Vercel environment, normally **Production**. If Preview and Development are needed, enable them too.

Important: Vite embeds `VITE_*` values during the build. Adding or changing the variable does not update an existing deployment. A new Vercel deployment is required.

## 5. Frontend implementation pattern

Install the React component:

```bash
npm install @hcaptcha/react-hcaptcha
```

Import it and store the token:

```jsx
import { useRef, useState } from "react";
import HCaptcha from "@hcaptcha/react-hcaptcha";

const [captchaToken, setCaptchaToken] = useState("");
const captchaRef = useRef(null);
const siteKey = import.meta.env.VITE_HCAPTCHA_SITE_KEY;
```

Render the widget:

```jsx
<HCaptcha
  ref={captchaRef}
  sitekey={siteKey}
  onVerify={(token) => setCaptchaToken(token)}
  onExpire={() => setCaptchaToken("")}
  onError={() => setCaptchaToken("")}
/>
```

Before submitting an Auth request:

```jsx
if (!captchaToken) {
  setError("Complete the CAPTCHA challenge first.");
  return;
}
```

For normal Supabase password sign-in:

```jsx
await supabase.auth.signInWithPassword({
  email,
  password,
  options: { captchaToken },
});
```

For sign-up:

```jsx
await supabase.auth.signUp({
  email,
  password,
  options: { captchaToken },
});
```

After the request, reset the challenge so the token cannot be reused:

```jsx
captchaRef.current?.resetCaptcha();
setCaptchaToken("");
```

## 5A. Exact Project Ledger locations

The code above is already integrated into this project in these files:

### Frontend dependency

The package is installed in `package.json`:

```json
"@hcaptcha/react-hcaptcha": "..."
```

Install it manually in a future project with:

```bash
npm install @hcaptcha/react-hcaptcha
```

### hCaptcha import and state

File: `src/auth/SignIn.jsx`, lines 1–2 and 16–26.

The current project uses:

```jsx
import { useRef, useState } from "react";
import HCaptcha from "@hcaptcha/react-hcaptcha";

const [captchaToken, setCaptchaToken] = useState("");
const captchaRef = useRef(null);
const captchaSiteKey =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY ||
  import.meta.env.VITE_CAPTCHA_SITE_KEY;
```

The fallback variable is supported for compatibility, but use `VITE_HCAPTCHA_SITE_KEY` for new deployments.

### Token validation and password sign-in

File: `src/auth/SignIn.jsx`, lines 39–42 and 69–71.

Before submitting, the app checks for a token:

```jsx
if (!captchaToken) {
  setError("Complete the CAPTCHA challenge first.");
  return;
}
```

The username is first converted to its Supabase email using the existing `get_login_email` RPC. The CAPTCHA token is then passed to Supabase Auth:

```jsx
await supabase.auth.signInWithPassword({
  email,
  password,
  options: { captchaToken },
});
```

After the request, lines 70–71 reset the widget:

```jsx
captchaRef.current?.resetCaptcha();
setCaptchaToken("");
```

### CAPTCHA widget location

File: `src/auth/SignIn.jsx`, lines 186–191.

The widget is rendered on both normal sign-in and Forgot password mode:

```jsx
<HCaptcha
  ref={captchaRef}
  sitekey={captchaSiteKey}
  onVerify={setCaptchaToken}
  onExpire={() => setCaptchaToken("")}
  onError={() => setCaptchaToken("")}
/>
```

If the site key is missing, the app displays `CAPTCHA site key is not configured.` instead of rendering an empty widget.

### Forgot-password flow

File: `src/auth/SignIn.jsx`, lines 46–54.

The browser does not look up the username email directly for recovery. It calls the Edge Function and sends the CAPTCHA token:

```jsx
await supabase.functions.invoke("password-recovery", {
  body: {
    username: normalizedUsername,
    captcha_token: captchaToken,
  },
});
```

The user receives the same generic message whether the username exists or not:

```text
If the username exists, a recovery link has been sent. Please check the registered email.
```

### Password-recovery Edge Function

File: `supabase/functions/password-recovery/index.ts`.

The function receives `captcha_token` on line 17 and forwards it to Supabase Auth on line 37. It performs the username lookup and 2-attempt rate limit server-side, so the browser cannot bypass the protection or discover registered usernames.

Deploy changes with:

```bash
supabase functions deploy password-recovery
```

There is no sign-up form in the current Project Ledger system. If a future system adds sign-up, use the same widget and pass `captchaToken` in the `options` object of `supabase.auth.signUp()`.

## 6. Password recovery with an Edge Function

For password recovery, do not expose the username-to-email lookup to the browser. Use an Edge Function:

```text
Frontend
  → sends username + captcha token
  → password-recovery Edge Function
  → verifies the CAPTCHA through Supabase Auth
  → looks up the username server-side
  → sends the recovery email
  → returns the same generic response
```

The generic response prevents username enumeration:

```text
If the username exists, a recovery link has been sent. Please check the registered email.
```

The Project Ledger function is located at:

```text
supabase/functions/password-recovery/index.ts
```

The function receives the CAPTCHA token and forwards it to Supabase Auth as `captcha_token`. Keep the redirect URL fixed or allowlisted on the server. Never accept an arbitrary redirect URL from the browser.

Deploy it with:

```bash
supabase functions deploy password-recovery
```

If the function uses a custom production URL, configure it as a server-side secret:

```bash
supabase secrets set PUBLIC_SITE_URL=https://project-ledger-psi.vercel.app
```

Do not put the Supabase service-role key in frontend code. Edge Functions may use it server-side only.

## 7. Project Ledger recovery rate limit

Project Ledger also has a database-side recovery limit:

- Maximum of 2 accepted recovery requests per username
- 15-minute window
- Further requests do not send another recovery email
- The browser continues receiving the same generic message

The migration is located at:

```text
supabase/migrations/20260808000000_password_recovery_rate_limit.sql
```

Apply migrations with:

```bash
supabase db push
```

This limit is stored server-side, so refreshing the browser does not reset it.

## 8. Deployment checklist

Before testing production:

- [ ] hCaptcha site includes the production domain.
- [ ] hCaptcha secret is saved in Supabase CAPTCHA settings.
- [ ] `VITE_HCAPTCHA_SITE_KEY` is saved in Vercel for Production.
- [ ] Vercel has been redeployed after adding the variable.
- [ ] Supabase Site URL is correct.
- [ ] `/reset-password` is in Supabase redirect URLs.
- [ ] Database migrations are applied with `supabase db push`.
- [ ] The recovery function is deployed with `supabase functions deploy password-recovery`.
- [ ] The hCaptcha provider in Supabase matches the frontend provider.
- [ ] Browser cache is cleared or the site is opened in a private window for testing.

## 9. Testing checklist

### Sign in

1. Open the login page.
2. Confirm the hCaptcha widget is visible.
3. Try signing in without completing it.
4. Confirm the app says:

   ```text
   Complete the CAPTCHA challenge first.
   ```

5. Complete the challenge and sign in.
6. Confirm the challenge resets after the request.

### Password recovery

1. Select **Forgot password?**
2. Enter a username.
3. Complete hCaptcha.
4. Submit the form.
5. Confirm the generic recovery message appears.
6. Check the registered email.
7. Repeat the request twice and confirm that additional requests do not send more email during the rate-limit window.

### Common errors

#### `no captcha_token found`

Usually one of these is the cause:

- The site key variable is missing from Vercel.
- The variable name is wrong.
- Vercel was not redeployed after adding the variable.
- The hCaptcha widget was not completed.
- The token was not passed to Supabase Auth.
- The recovery Edge Function was not redeployed after token forwarding was added.

#### `CAPTCHA site key is not configured`

Add this exact Vercel variable and redeploy:

```text
VITE_HCAPTCHA_SITE_KEY=your-site-key
```

#### hCaptcha widget does not appear

Check:

- The site key is correct.
- The production domain is registered in hCaptcha.
- The selected provider is hCaptcha in Supabase.
- The Vercel variable is enabled for Production.
- The browser is loading the newest deployment.

#### CAPTCHA works locally but not in production

Add both domains to the hCaptcha site configuration:

```text
localhost
project-ledger-psi.vercel.app
```

Then create a new deployment.

## 10. Reusing this in another Supabase system

For a future React + Supabase project:

1. Create an hCaptcha site and copy the site and secret keys.
2. Save the secret in Supabase CAPTCHA settings.
3. Save the site key as a public `VITE_*` environment variable.
4. Install `@hcaptcha/react-hcaptcha`.
5. Render the widget on each protected Auth form.
6. Store the token in React state.
7. Pass `captchaToken` to Supabase Auth.
8. Reset the widget after every attempt.
9. Use an Edge Function for username-based recovery or any server-side lookup.
10. Keep service-role keys and CAPTCHA secrets server-side.
11. Add server-side rate limiting for recovery and other abuse-sensitive actions.
12. Add production and local domains to hCaptcha and Supabase redirect settings.

Reference: [Supabase Enable CAPTCHA Protection](https://supabase.com/docs/guides/auth/auth-captcha)
