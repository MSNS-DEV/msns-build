# Two-factor authentication: setup

Every account (staff, students and parents) can turn on any of these from **Profile → Security** (parents: **Security** in the portal header):

| Method                                     | Needs on the server                  | Cost                         |
| ------------------------------------------ | ------------------------------------ | ---------------------------- |
| Passkey (fingerprint, face, screen lock)   | nothing extra                        | free                         |
| Authenticator app (Google/Microsoft/Authy) | `TWO_FACTOR_ENCRYPTION_KEY`          | free                         |
| SMS code                                   | an SMS provider (below)              | the SIM's SMS bundle         |
| Email code                                 | SMTP settings                        | free with your mail provider |
| Backup codes                               | nothing extra (issued automatically) | free                         |

Admins and the Principal manage accounts and the per-role 2FA rule at **Admin → Accounts & Access** (`/admin/users/accounts`).

## 1. Encryption key (required)

Authenticator-app secrets are stored encrypted. Generate a key once and add it to Vercel (Production and Preview):

```sh
openssl rand -base64 48
```

Set it as `TWO_FACTOR_ENCRYPTION_KEY`. **Never change or lose it** after people have enrolled: their authenticator apps would stop working and an admin would have to reset their 2FA.

`TRUSTED_DEVICE_SECRET` is optional. It signs "Remember this device" cookies and falls back to `AUTH_SECRET`.

## 2. SMS with SMS Gateway for Android (free apart from the SIM)

There is no free commercial SMS gateway for Pakistani numbers. [SMS Gateway for Android](https://sms-gate.app) (open source, Apache-2.0) sends messages through an ordinary Android phone and SIM, so the only cost is the SIM's SMS bundle.

1. **Phone and SIM.** Use a spare Android phone (Android 5+) with a dedicated SIM on an SMS bundle. Keep it charged, on Wi-Fi or mobile data, and exempt the app from battery optimisation.
2. **Install the app** from the releases page of `github.com/capcom6/android-sms-gateway` (or Google Play, "SMS Gateway for Android"). Grant the SMS permission.
3. **Turn on Cloud server** in the app and start it. It shows a **username** and **password**.
4. **Add these to Vercel** (msns-build project):
   ```
   SMS_PROVIDER=smsgate
   SMS_GATE_URL=https://api.sms-gate.app
   SMS_GATE_USERNAME=<from the app>
   SMS_GATE_PASSWORD=<from the app>
   SMS_DAILY_LIMIT=500
   ```
5. Redeploy, then in your own profile add your number under **Text message (SMS)**. You should get a code within a few seconds.

How it behaves:

- Messages are sent with a 5-minute expiry and high priority. If the phone is offline, the code expires instead of arriving late.
- Codes are 6 digits, valid 5 minutes, at most 5 tries each, with a 60-second resend wait. Each account can request 5 codes an hour, each IP 20 an hour.
- `SMS_DAILY_LIMIT` caps all SMS per day so a flood of requests can't drain the bundle. After the cap, people use another method.
- The last line of each SMS (`@lms.msns.edu.pk #123456`) lets Android Chrome fill the code in automatically.

**Private server option.** To avoid the public cloud relay, run the gateway's own server (see the "Private server" guide on docs.sms-gate.app) and set `SMS_GATE_URL=https://<your-host>/api`.

**Twilio instead.** Set `SMS_PROVIDER=twilio` with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`. This costs per message.

**Development.** `SMS_PROVIDER=console` prints codes to the server log. It refuses to run in production.

## 3. Email codes (optional)

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`. Without them the email option is hidden. People add their own address and confirm it with a code first; generated `@msns.edu.pk` addresses are not used unless they really receive mail.

## 4. Passkeys

Passkeys are tied to the site's domain. Defaults come from `AUTH_URL`:

```
WEBAUTHN_RP_ID=lms.msns.edu.pk
WEBAUTHN_ORIGIN=https://lms.msns.edu.pk
```

- Passkeys made on `lms.msns.edu.pk` don't work on preview URLs (`*.vercel.app`) and vice versa. Test previews with an authenticator app instead.
- **The Android app (Capacitor WebView) can't use passkeys.** The option is hidden there with a note to use the phone's browser. Inside the app, people sign in with an authenticator app, SMS or a backup code.

## 5. Requiring 2FA for a role

In **Accounts & Access → Security policy**, switch on "Require 2FA" for a role. Members without 2FA are sent to a setup page at their next sign-in (or within 5 minutes if already signed in) and can't use the portal until they add a method. The page shows how many members already have it.

Suggested order: ADMIN and PRINCIPAL first, then HEAD and CLERK, then TEACHER. Only require it for students and parents once SMS is running, since many won't have an authenticator app.

## 6. When someone is locked out

In **Accounts & Access**, open the account:

- **Unlock sign-in** after too many wrong passwords.
- **Reset 2FA** removes all their methods and backup codes. Confirm who they are in person or by phone first: this is the main way an attacker would try to take over an account.
- **Reset password** creates a temporary password shown once; they must choose a new one at the next sign-in.

Every action is recorded in the **Audit log** and in the person's own security activity.

## What changes for users at deploy

Everyone is signed out once: sessions are now tracked per device so they can be listed and signed out individually.
