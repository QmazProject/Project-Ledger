# DTR passcodes and Google Password Manager

How the DTR keeps employee passcodes out of Google Password Manager, why it has to, and
what to do with passcodes Chrome already saved. Written 2026-10-12.

---

## 1. The problem

After an employee signed in to the DTR in Chrome, this pop-up appeared:

> **Check your saved passwords**
> The password you just used was found in a data breach. To secure your accounts,
> Google Password Manager recommends changing it now and …

It showed up for nearly every employee, every time they signed in.

## 2. Why it happened

In plain words:

1. The passcode box was built as a **password box** (`<input type="password">`).
2. Chrome treats every password box as a **website login**. When the box went away after
   sign-in, Chrome decided "a login just happened" and **saved** the passcode.
3. Chrome then compares saved passwords against huge lists of passwords leaked from other
   websites. A short number code like `1234`, `5678` or `246810` is on **every** one of
   those lists, simply because millions of people use the same codes.
4. So Chrome warned — not because our system leaked anything, but because a 4–8 digit
   code is never unique.

**Nothing leaked from the DTR.** The warning is about the code itself being common.

## 3. What was changed in the app

The passcode boxes are **no longer password boxes**. They are ordinary number boxes that
are *drawn* as dots, so the passcode still looks like `••••` but Chrome no longer sees a
login. Chrome therefore:

- does not offer to save the passcode, and
- does not check it against breach lists, so the pop-up does not appear.

| Where | Boxes changed |
|---|---|
| DTR sign-in (`/dtr/sign-in`) | the passcode step (the ID step was already a plain box) |
| DTR → Settings → My passcode | Current passcode, New passcode, Repeat it |
| Project Ledger login (`/login`) | **not changed** — that is a real website password, and Chrome's help is useful there |

What stays the same for employees:

- The passcode still shows as dots, never as digits.
- Phones still show the **number keypad**.
- Copying the passcode out of the box is blocked, like a password box.
- Wrong passcodes are still refused, and an ID is still held for 5 minutes after 5 wrong tries.

### Browsers that cannot draw dots in a plain box

The dots come from a browser feature called `-webkit-text-security`. Chrome, Edge,
Safari and Samsung Internet have it. A browser without it **keeps the old password
box**, so the digits are never shown — that browser may still offer to save the passcode,
but it is not Chrome, so not this pop-up.

## 4. What to do on phones and computers

### 4.1 Check the fix (once, after deploying)

1. Open `https://project-ledger-psi.vercel.app/dtr` in Chrome.
2. Sign in with an ID and passcode.
3. Expected: you land on Punch and **no** "Check your saved passwords" pop-up and **no**
   "Save password?" offer appears.

### 4.2 Remove passcodes Chrome already saved (optional, per phone)

Passcodes saved **before** this fix stay in that phone's Google Password Manager. They are
harmless now (Chrome will not fill them into the new boxes), but they are clutter and
will keep showing up in Google's "Password Checkup" list.

> ⚠️ **Delete carefully.** The DTR and Project Ledger share one website address
> (`project-ledger-psi.vercel.app`). Delete only entries whose **username is an employee
> ID number** (e.g. `1002`) or is **empty**. **Keep** entries whose username is an
> **email address** — those are real Project Ledger logins.

**Android (Chrome app)**
1. Chrome → **⋮** (top right) → **Settings** → **Google Password Manager**
   (on some phones: **Password Manager**).
2. Search `project-ledger-psi`.
3. Tap an entry whose username is an ID number or empty → **Delete**.

**Computer (Chrome)**
1. Go to `chrome://password-manager/passwords`.
2. Search `project-ledger-psi`.
3. Open each entry with an ID-number or empty username → **Delete**.

**Any device, if Chrome syncs with a Google account**
1. Go to `https://passwords.google.com` and sign in with that Google account.
2. Search `project-ledger-psi`, open it, delete only the ID-number / empty-username entries.

### 4.3 Things **not** to do

- **Do not tap "Never" for this site** when Chrome offers to save a password. That would
  also stop Chrome saving real Project Ledger passwords for the same address.
- **Do not turn off Chrome's breach warning** to hide the pop-up. That setting (Chrome →
  Settings → Privacy and security → Safe Browsing / Security → "Warn you if a password
  was compromised in a data breach") protects **every** website on the device, not just
  the DTR. After the fix it is not needed anyway.

Chrome menu names change a little between versions; the words above are close to what
you will see.

## 5. For developers — the rules

### 5.1 Never use `type="password"` for a DTR passcode

Use the helper in `DTR System/dtr-system.jsx`:

```jsx
/* in the passcodes section, next to hasPin / verifyPin */
const MASK_AS_TEXT = !!globalThis.CSS?.supports?.("-webkit-text-security", "disc");
const passcodeBox = (className = "") => (MASK_AS_TEXT
  ? { type: "text", className: `${className} masked`.trim(), autoComplete: "off",
      autoCorrect: "off", autoCapitalize: "off", spellCheck: false, onCopy: noCopy, onCut: noCopy }
  : { type: "password", className: className || undefined, autoComplete: "off" });

/* any new passcode box */
<input {...passcodeBox()} inputMode="numeric" aria-label="New passcode" value={v} onChange={…} />
```

and the style rule `.qm .masked{-webkit-text-security:disc}`.

Always give the box an `aria-label` (screen readers, and tests find boxes by it).

### 5.2 Why the simpler fixes do not work

| Tried / tempting | Why it fails |
|---|---|
| `autoComplete="off"` on a password box | Chrome ignores it for password boxes on purpose; it still saves and still checks for breaches. |
| `autoComplete="new-password"` / `"current-password"` | These *invite* the password manager. The old Settings boxes had them. |
| Wrapping in a `<form>` or removing the `<form>` | Chrome detects password boxes with or without a form (it noticed the box disappearing after sign-in). |
| Showing the digits in a normal box | Removes the pop-up but shows the passcode to anyone looking at the screen. |

### 5.3 Gotcha: `CSS` in `dtr-system.jsx`

In that file `CSS` is the **stylesheet string constant**, declared further down. Writing
`CSS.supports(...)` near the top reaches that constant before it exists and the whole DTR
page crashes ("Cannot access 'CSS' before initialization"). Use `globalThis.CSS` for the
browser's CSS API.

### 5.4 Leave Project Ledger alone

`src/auth/SignIn.jsx` and `src/auth/ResetPassword.jsx` are real account passwords
(Supabase). There the password manager and its breach warning are wanted. Do not apply
`passcodeBox()` to them.

## 6. Known limits

- **Screen readers:** in the dotted text box a phone screen reader may speak the digits
  as they are typed; a password box stays silent. Acceptable for a time-clock phone; worth
  knowing if an employee uses TalkBack / VoiceOver.
- **Chrome can change its rules.** If a future Chrome starts treating dotted text boxes as
  passwords, the pop-up could return. Re-check with §4.1 after big Chrome updates.
- **Old saved entries** stay until deleted (§4.2).
- **The warning had a point:** a 4-digit code *is* easy to guess. What protects an ID is
  the 5-wrong-tries → 5-minute hold. Requiring 6 digits (`PIN_MIN` in
  `dtr-system.jsx`) would make guessing much slower if that is ever wanted.

## 7. How it was tested (2026-10-12)

Headless Edge driving a local copy with **no Supabase keys** (nothing touched production):

- Sign-in passcode step is a text box with dots, number keypad, `autocomplete=off`;
  **no** password box anywhere on the sign-in page or Settings.
- Copying out of the passcode box is blocked.
- Wrong passcode refused; right passcode signs in to `/dtr/punch`.
- Settings: changing a passcode works and the new passcode signs in.
- A browser without `-webkit-text-security` falls back to a password box and still signs in.
- Result: 14/14, plus `npm test` 311/311 and the earlier address (42/42) and photo (11/11)
  checks.

Not testable there: the Google pop-up itself, which needs a real Chrome signed in to a
Google account — hence the manual check in §4.1.
