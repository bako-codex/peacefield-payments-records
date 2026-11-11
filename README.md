# Peacefield Payments Reports

A React payment report for Peacefield Private Schools. Staff sign in with
Firebase Authentication, verify their email, and need an approved access
request before the server will return payment records.
Payment data is read from Firestore by authenticated Vercel API functions using
Firebase Admin credentials; the browser never has direct payment access.

## Local development

1. Copy `.env.example` to `.env.local` and fill in the Firebase Web App values:
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
   `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID`.
2. Set `ADMIN_EMAILS` to a comma-separated list of administrator email
   addresses on the local server. Matching Firebase accounts can review and
   approve access requests from the dashboard. This list must not be a `VITE_`
   variable.
3. To email access codes locally, also set `BREVO_API_KEY` and `EMAIL_FROM` in
   `.env.local`. The sender address must be verified in Brevo; optionally set
   `EMAIL_FROM_NAME=Peacefield Records`.
4. Authenticate Firebase Admin using Application Default Credentials:

   ```powershell
   gcloud auth application-default login
   gcloud auth application-default set-quota-project peacefield-payments-bf7c2
   ```

   The quota-project command is required so Firebase Authentication's Admin API
   can use local ADC. Alternatively, set `FIREBASE_SERVICE_ACCOUNT_JSON` to
   single-line JSON for a service account with the minimum required Firebase
   Authentication and Firestore permissions. Leave it empty when using ADC;
   do not paste user ADC credentials there or commit credentials.
5. Install dependencies and start Vite:

   ```powershell
   npm install
   npm run dev
   ```

6. Open <http://127.0.0.1:5173>.

## Firebase setup

1. Enable **Email/Password** and **Google** in Firebase Authentication →
   **Sign-in method**. For Google, choose a support email and save the provider.
2. Add the deployed Vercel domain and local development domain to Firebase
   Authentication's authorized domains (`127.0.0.1` locally).
3. Create a Firebase Web App and set its public `VITE_FIREBASE_*` configuration
   values in Vercel's project environment variables.
4. Set the following server-only Vercel environment variables:
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: service account JSON for the same Firebase
     project. Keep this secret and never prefix it with `VITE_`.
   - `FIREBASE_PROJECT_ID`: `peacefield-payments-bf7c2`.
   - `ADMIN_EMAILS`: comma-separated email addresses of school administrators.
   - `APP_URL`: the canonical deployed URL, for example
     `https://payments.example.com`.
   - `BREVO_API_KEY`: a Brevo transactional email API key.
   - `EMAIL_FROM`: a sender address verified in Brevo.
   - `EMAIL_FROM_NAME`: optional sender label; defaults to `Peacefield Records`.
   Local development also uses `ADMIN_EMAILS` and `FIREBASE_SERVICE_ACCOUNT_JSON`
   from `.env.local`; those are server-side variables and must not use a
   `VITE_` prefix.
5. Deploy the Firestore rules in `firestore.rules`. These deny direct client
   reads/writes of payments, user profiles, and access requests; the server
   verifies Firebase ID tokens and active user profiles before using the Admin
   SDK.
6. Deploy the project to Vercel. Vercel builds the React app and deploys
   `api/**/*.js` as serverless functions.

Staff submit their name and email from **Request access**. Requests are private
and visible only to configured administrators in the dashboard. An admin
approves or rejects each request; after approving, the admin separately chooses
**Send OTP**. The access code is emailed through Brevo, is valid for 7 days,
and can be used once to create an account or renew an existing account's access.
After the code is accepted, account access lasts 7 days. Users with Google
accounts must use the same email address as the approved request. Configured
administrators can request their own verification code without a separate
approval. No public, unrestricted account can read payment data.

Configure and verify the Brevo sender address before sending codes. Firebase
Authentication continues to send password-reset emails. For better inbox
placement, authenticate the sending domain in Brevo and publish its recommended
SPF/DKIM DNS records; inbox placement cannot be guaranteed. Keep the Brevo API
key server-side and never put it in a `VITE_` variable.

## Data/report behavior

The report automatically loads payment records in pages of 50. Firestore reads
may incur normal charges. The From and To month filters reload records
immediately when changed; either boundary can be used on its own, and selected
months are inclusive. Filters and search operate on the loaded data.

Category fee totals use the supplied Tuition/Lesson/Social rate schedule and
only count fees listed in an item's summary. Day Care uses the Reception
tuition rate. Outstanding payment balances are shown separately and can be
filtered with the class selector.

## Deployment and security notes

- Use Node.js 24.x for Vercel builds and functions. Firebase Admin and the
  resolved Firebase dependencies require a recent Node runtime.
- Never put Firebase service-account JSON, Brevo keys, or other server
  credentials in the frontend or commit them to source control.
- Firebase Web App settings are public identifiers, not server credentials.
- Keep `ADMIN_EMAILS` synchronized with trusted school administrators.
- The Firebase Admin service account bypasses Firestore rules. Restrict its IAM
  permissions to the minimum needed and protect Vercel environment variables.
- Review the Firestore rules before deploying. They intentionally disable
  direct client access to the payment collection.
- Vercel Hobby/serverless function limits may not be suitable for loading a
  large Firestore collection in one request. Monitor function duration and
  reads; if the dataset grows, add server-side filtering and pagination UX.
