# NUR2 DATA — VTUGate Contract & Project Context

This file consolidates the VTUGate and project facts already supplied by the project owner in the ChatGPT project conversation. It is a working integration record, not a claim that a live provider call has been made.

## 1. Provider endpoints and request contract supplied by the owner

### Fetch data plans
- Method: `POST`
- Path: `/api/v1/fetchdataplans`
- Content type: `application/x-www-form-urlencoded`
- Form field: `service_id`
- The application reads the plan list from `data.data_plans`.
- A supplied MTN example included `code: "1"`, `1GB 30d`, `price: 350`, `face_value: 400`, `service_id: 149`; another example included code `2` / 2GB / price 700. An older SME example used `service_id: 191`.

### Buy data
- Method: `POST`
- Path: `/api/v1/buydata`
- Content type: `application/x-www-form-urlencoded`
- Fields supplied by the owner: `service_id`, `phone_number`, `amount`, `plan_code`, `client_reference`.
- `plan_code` must be the selected catalog row's `code`; use its associated `service_id`.
- `amount` must match the catalog price.
- Standard mode does not use `resale_price`.
- Owner-supplied successful example identifiers: `transaction_id: 45232`, `external_reference: "DAT789XYZ"`.
- Owner-supplied duplicate behavior: reusing `client_reference` returns the original transaction; duplicate/in-progress behavior may return HTTP 409. Do not treat a duplicate response as a new purchase.

### Transaction status
- Method: `POST`
- Path: `/api/v1/transactionstatus`
- Form fields supplied by the owner: `transaction_id` and/or `external_reference`; `client_reference` was also included in the supplied example; `requery` controls whether to query provider live.
- `requery=false`: database-only lookup; it does not call the provider.
- `requery=true`: live requery.
- Owner-supplied example: `transaction_id: 45231`, `status: "success"`, `requeried: true`, `wallet_adjusted: true`, `reconciliation_action: "deduct"`.
- The owner also supplied an airtime transaction-status example. Do not assume the airtime response is identical to data-purchase response without checking the supplied data-purchase example.

## 2. Sandbox and test behavior supplied by the owner

- The owner supplied a VTUGate sandbox/test API key for test use. The secret itself must not be committed to this repository or included in distributable ZIP files.
- The owner stated that sandbox mocked responses match the live response format.
- Test purchase transaction IDs begin at `900000001`.
- Transaction records are retained for 30 days.
- Reusing the same `client_reference` returns the first transaction.
- A test phone number ending in `3333` was previously described as simulating insufficient wallet.

## 3. Safety and implementation rules

1. Never put the VTUGate API key in frontend code, source control, logs, screenshots, or ZIP deliverables. Store it only as a Supabase Edge Function secret.
2. Do not enable live purchase intake or the worker until request/response parsing and status mapping are implemented and verified against the owner's supplied contract examples.
3. Never retry an ambiguous/unknown provider outcome as a new purchase. Keep the same idempotency/client reference and reconcile status first.
4. Do not refund solely because of a timeout or missing response. An unknown outcome remains unresolved until a reliable status result is obtained.
5. Treat HTTP 409 / duplicate as an existing or in-progress transaction, not a fresh success or permission to create a second debit.
6. Use the catalog price and selected catalog `code` + `service_id`; reject client-supplied price overrides.
7. Do not expose Supabase service-role credentials to the browser.

## 4. Related project facts supplied by the owner

- Project/repository: `ismailumar650-netizen/nur2-data-platform-`
- Default branch: `main`
- Primary development environment: GitHub Codespaces, workspace named `filthy spooky`.
- Wallet funding uses Paystack; the project has `initialize-wallet-funding` and `verify-wallet-funding` Edge Functions.
- Paystack funding validation was described as ₦100–₦100,000.
- Relevant secret names used in project documentation: `VTUGATE_API_KEY`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_CALLBACK_URL`. Never store secret values here.
- Purchase intake and worker are intentionally disabled pending verified integration.

## 5. Super Admin bootstrap identity

The owner explicitly supplied this Supabase Auth user UUID for the first Super Admin:

`02ef4d60-c8b0-47ac-b5a4-772667e0b6cd`

Configure it as the Supabase Edge Function secret `NUR2_SUPER_ADMIN_USER_ID`. The UUID is an identifier, not an authentication credential. Do not hardcode it into browser code. Do not include service-role keys or passwords in this file.

## 6. What remains to verify before live purchases

- Confirm exact field names and value types in the full successful and failed **data buy** JSON examples.
- Confirm the complete set of status values and exact status response shape for data purchases, including pending/unknown/failed outcomes.
- Confirm how a provider transaction is correlated when only `external_reference` or `client_reference` is available.
- Confirm webhook/callback support and signature verification, if used.
- Run sandbox end-to-end tests and verify idempotency, wallet debit, reconciliation, and no-double-refund behavior.

The examples above are facts recorded from the owner's messages. Any field not explicitly listed above must not be invented by the implementation.
