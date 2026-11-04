# NUR2 Data VTU

## Local setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Set `VITE_SUPABASE_URL` to the Project URL shown in your Supabase project settings.
4. Set `VITE_SUPABASE_ANON_KEY` to the project's publishable key (or legacy anon key).
5. Start the app with `npm run dev`.

Vite embeds variables prefixed with `VITE_` in browser code. Use only a
publishable/anon key here; never use a Supabase secret or service-role key.
Vite is configured to reject secret/service-role keys during startup and builds.

The app includes email sign-in and registration, an authenticated dashboard,
and airtime, data, bills, wallet, and transaction-history views. The dashboard
shows recent wallet and data-purchase activity, and the history view supports
bounded cursor pagination. The Data section loads plans through the
authenticated `fetchdataplans` function. Transactions remain disabled until a
secure VTUGate purchase integration is configured.
Password recovery uses Supabase email recovery; allow the application's
configured HTTPS origin in Supabase Auth redirect URL settings.
The Data section lets users select a network, enter a Nigerian phone number,
choose a returned plan, and review a confirmation summary. Its Continue action
only displays that summary; it does not submit a purchase. The VTUGate service
ID remains an explicit input because the service catalog is not integrated.
The `purchase-data` deployment entry point is hard-disabled regardless of
environment flags, and the data-purchase worker is also hard-disabled. Neither
the app nor those functions submits purchases to VTUGate.

The Wallet section reads the authenticated user's balance and transaction
history. Direct client writes to wallet and transaction tables remain blocked
by RLS and table grants. Paystack Test Mode funding uses server-side Edge
Functions; payment references are verified with Paystack before an atomic,
idempotent database function credits a wallet. Live Paystack keys are rejected.

To apply the migration locally, start the Supabase local stack and run
`supabase migration up`. Before applying it to a hosted project, confirm the
linked project is the intended one, review `supabase migration list`, run
`supabase db push --dry-run`, and inspect the pending migration before running
`supabase db push`. Take a database backup first when applying to production.

## Paystack Test Mode wallet funding

The wallet payment flow requires the
`20261031175231_add_paystack_wallet_funding.sql` migration and the
`initialize-wallet-funding` and `verify-wallet-funding` Edge Functions. Review
the migration before applying it: it adds Paystack reference/status metadata,
a unique reference index, and a `service_role`-only atomic credit function. It
does not change the existing RLS read policies or grant client write access.
Do not deploy the payment functions until this migration has been reviewed and
applied.

Set these Edge Function secrets in the Supabase Dashboard (never in `.env`,
Vite variables, or browser code):

- `PAYSTACK_SECRET_KEY`: a Paystack **Test Mode** secret beginning with
  `sk_test_`. The functions reject keys that do not use this prefix.
- `PAYSTACK_CALLBACK_URL`: the exact HTTPS URL of the application page that
  should receive Paystack's `reference` callback.

Supabase Edge Functions provide `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` in the server runtime. The service-role key is used
only server-side and must never be copied into application configuration.

After review and approval, deploy the two functions with `verify_jwt` enabled
as configured in `supabase/config.toml`. The initialize function opens a
Paystack Test Mode checkout and records a pending deposit intent. The verify
function independently checks the reference, successful status, NGN currency,
and exact kobo amount with Paystack before calling the atomic database credit
function. A browser redirect or client-side success message never credits a
wallet.

## Admin purchase monitoring

The Admin section calls the `admin-data-purchases` Edge Function, which
authenticates the Supabase user and checks `admin_members` on every request.
The browser UI is not an authorization boundary; non-members must receive
`403`, and the function exposes only its read-only purchase projection and
summary.

To provision an administrator, first review and apply
`20261103133500_create_admin_members.sql` to the intended environment. A
trusted database operator should identify the user's immutable Supabase Auth
user ID, then add or remove that ID in `public.admin_members` using a
privileged administrative connection. Never provision membership from browser
code, user metadata, app role claims, or a service-role key exposed to a user.
Keep that connection and every service-role credential inside trusted
administrative tooling. The membership audit trigger records grant/revoke
events, but actor attribution can be null when changes are made through a
privileged service role; verify and document the operator identity separately.
No admin account is provisioned automatically.

## VTUGate purchase release blocker

The source-observed `fetchdataplans` URL and form request document only the
catalog operation. Authoritative VTUGate Buy Data and Transaction Status API
contracts have not been verified. Do not invent endpoints, payloads, response
meanings, idempotency behavior, or retry rules. Keep purchase intake and the
worker disabled until current, provider-owned documentation confirms both
contracts, implementation and reconciliation safeguards are reviewed, and
non-production fulfillment tests demonstrate safe outcomes. Ambiguous
provider transactions must never be resubmitted automatically.

The SQL migrations and SQL tests have not been run as part of this change.
Verify which migrations have been reviewed and applied in each environment
before enabling any dependent feature; do not infer production schema state
from repository files.

## Fetch VTUGate data plans

The `fetchdataplans` Supabase Edge Function proxies data-plan requests to
VTUGate. Configure the API key as a Supabase Function secret; never add it to
the frontend environment or source:

```sh
supabase secrets set VTUGATE_API_KEY=your_vtugate_api_key
supabase functions deploy fetchdataplans
```

The function requires an authenticated Supabase user and accepts a JSON body
containing `service_id`, for example `{"service_id":"your-service-id"}`. It
forwards the request to VTUGate over HTTPS and keeps the API key server-side.
Enter a service ID supplied by your VTUGate service catalog in the Data
section; the function returns the VTUGate response unchanged, including its
`data.data_plans` list.

## Local validation

Run the JavaScript unit and handler tests, linter, and production build locally:

```sh
npm test
npm run lint
npm run build
```

The SQL tests require a disposable local Supabase stack. Run them only against
that local database, never against a linked or production project:

```sh
supabase start
supabase test db
supabase stop
```
