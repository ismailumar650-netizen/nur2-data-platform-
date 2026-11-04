# NUR2 DATA VTUGate Purchase Integration Contract

This document defines the evidence and contract decisions required before NUR2 DATA can submit or reconcile VTUGate data purchases. The VTUGate purchase and status operations are **UNKNOWN** until confirmed by current, authoritative VTUGate documentation.

## Service Catalog

| Service | Port | Category | Purpose |
|---|---:|---|---|
| NUR2 DATA web client | UNKNOWN | Client | Allows a user to review a plan; the current UI does not submit purchases. |
| NUR2 DATA Supabase Edge Functions | UNKNOWN | API Layer | Authenticates users, exposes plan lookup and guarded purchase intake, and hosts a disabled worker. |
| VTUGate | UNKNOWN | External provider | Its catalog lookup is present in source. Purchase submission and transaction-status contracts are UNKNOWN. |
| Supabase Postgres | UNKNOWN | Persistence | Owns wallets, purchase idempotency, provider leases, settlement, and refund records. |

## API Endpoints Inventory

Paths and fields below are source-observed only where explicitly marked. Do not treat source shape as vendor contract confirmation.

| Service | Method | Path | Request Type | Response Type |
|---|---|---|---|---|
| NUR2 DATA `fetchdataplans` Edge Function | POST | `https://api.vtugate.com/api/v1/fetchdataplans` (source-observed) | Form body containing `service_id` (source-observed) | VTUGate response passed through by the function; authoritative schema UNKNOWN |
| VTUGate Buy Data API | UNKNOWN | UNKNOWN | UNKNOWN; confirm with VTUGate | UNKNOWN; confirm with VTUGate |
| VTUGate Transaction Status API | UNKNOWN | UNKNOWN | UNKNOWN; confirm with VTUGate | UNKNOWN; confirm with VTUGate |
| NUR2 DATA `purchase-data` Edge Function | POST | Supabase function route `purchase-data` | Authenticated request; current handler accepts `service_id`, `plan_code`, `phone_number`, `idempotency_key` | Prepared purchase result; provider submission does not occur in this function |
| NUR2 DATA `data-purchase-worker` Edge Function | POST | Supabase function route `data-purchase-worker` | Service-role authenticated request with an action | Worker is hard-disabled in the deployed entry point; no provider call occurs |
| NUR2 DATA `admin-data-purchases` Edge Function | GET | Supabase function route `admin-data-purchases` | Authenticated admin request with bounded pagination | Read-only purchase monitoring response |

## Management & Observability Endpoints

No VTUGate health, readiness, or observability endpoints have been confirmed. Provider diagnostics and support channels are UNKNOWN; obtain those details from authoritative VTUGate documentation or the provider.

## DTOs & Contracts

### Authoritative documentation required

Obtain current VTUGate-owned API documentation, or written confirmation from an authorized VTUGate support channel, for both:

1. **Buy Data API:** endpoint URL and version, HTTP method, authentication and headers, encoding/content type, request and response schemas, field definitions, allowed values, and all success/error response semantics.
2. **Transaction Status API:** endpoint URL and version, HTTP method, authentication and headers, request and response schemas, status meanings, reference lookup behavior, and when a result is definitive.

The materials must identify the applicable environment (test/sandbox versus live), version/date, and any migration/deprecation notices. If VTUGate offers no test environment, that fact and an approved non-production validation method must be confirmed before any live testing is proposed. All of these items are currently **UNKNOWN**.

### Schemas and semantics to confirm with VTUGate

| Contract item | Required confirmation |
|---|---|
| Buy Data URL, method, version | Exact official endpoint and supported API version. **UNKNOWN** |
| Authentication | Credential type, placement, rotation, required headers, and whether credentials differ by environment. **UNKNOWN** |
| Request encoding | JSON, form encoding, or other; exact content type and character encoding. **UNKNOWN** |
| Required request fields | Exact names, types, formats, units, allowed values, and validation rules for service/network, plan, phone/MSISDN, amount/price, and client reference. Do not assume any field is accepted. **UNKNOWN** |
| Price authority | Whether submitted amount is required, optional, ignored, or independently validated; currency and minor-unit rules. **UNKNOWN** |
| Provider reference | Which client-supplied reference is accepted, maximum length/character set, uniqueness scope, retention, and lookup support. **UNKNOWN** |
| Buy Data response | Exact success envelope, provider transaction identifier, external reference, status field, and whether an accepted response means queued or completed. **UNKNOWN** |
| Error response | Complete documented error taxonomy and which errors are definitive versus ambiguous. **UNKNOWN** |
| Transaction Status request | Lookup key(s), field names, reference type, encoding, and authorization. **UNKNOWN** |
| Transaction Status response | Exact schema and definitive meanings for success, failure, pending/processing, unknown, and not found. **UNKNOWN** |
| Rate limits, timeouts, retries | Limits, `Retry-After` semantics, provider processing time, and safe retry rules. **UNKNOWN** |
| Duplicate requests | Provider idempotency behavior, duplicate detection window, and response for repeated references. **UNKNOWN** |
| Webhooks and reversals | Whether webhooks, reversals, chargebacks, or later status changes exist and their authentication/signature rules. **UNKNOWN** |
| Provider wallet/reconciliation | Whether VTUGate merchant-wallet fields exist and how they relate to a customer purchase, if at all. **UNKNOWN** |

Do not implement request/response DTOs for either purchase endpoint until each schema is backed by authoritative material. Do not infer request fields from the existing plan-catalog response or database column names.

## Communication Patterns

- **Current catalog flow:** The client calls the authenticated `fetchdataplans` function. Source code posts `service_id` to the source-observed VTUGate catalog URL. This documents only the current implementation, not a Buy Data or status API contract.
- **Purchase intake:** The deployed `purchase-data` entry point hard-codes intake off regardless of environment flags. Its injectable handler uses an authenticated user and catalog-derived price; it receives a client-supplied `idempotency_key`, derives a NUR2 `reference`, and the database creates a separate `client_reference`. The current UI does not invoke it. Do not enable intake until the VTUGate purchase/status contracts are authoritative and the complete fulfillment/reconciliation flow is validated.
- **Worker/provider adapter:** The worker entry point sets `workerEnabled: false`. The adapter always returns `unknown`. Keep it disabled; do not make Buy Data or Transaction Status calls.
- **Persistence and retries:** The database contains an idempotent wallet-debit/purchase operation, lease-checked transitions, a separate reconciliation claim, and a linked idempotent refund operation. These are local safeguards and do not establish VTUGate's idempotency or response semantics.
- **Admin monitoring:** A separate authenticated, membership-checked endpoint reads purchase rows and a read-only summary. Admin audit actor attribution remains a known limitation.
- **Transport/auth/security details for purchase/status provider endpoints:** UNKNOWN until official documentation is received. Do not construct endpoint URLs, authorization headers, or payloads by guesswork.

### State mapping policy

The values below define the required NUR2 DATA handling policy. Mapping an actual VTUGate response into one of these states remains **UNKNOWN** until VTUGate documents the response meaning.

| Provider evidence | NUR2 DATA handling |
|---|---|
| Documented, definitive success | Mark purchase successful and debit settled exactly once. Preserve provider transaction identifiers only after validating their documented form. |
| Documented, definitive failure | Mark failed and perform one atomic, purchase-linked refund. |
| Documented accepted/processing state | Keep pending; do not submit again. Query status according to the confirmed provider rules. |
| Ambiguous response, unrecognized schema/status, or contradictory identifiers | Record/retain unknown; do not refund or submit again until reconciled. |
| Timeout, connection loss, or invalid/truncated response after submission may have reached provider | Treat as unknown; reconcile using the persisted `client_reference` only if VTUGate confirms it as a supported lookup key. Never interpret a timeout as proof of non-submission. |
| Definitive not-found from a documented status lookup | A retry may be considered only after VTUGate confirms the lookup's consistency/settling window and no prior request can still be accepted. Reuse the same `client_reference` only if VTUGate confirms it as the supported submission reference. |
| Not-found before the documented visibility/settlement window, or status lookup unavailable | Keep unknown/pending and defer reconciliation; no retry or refund. |

## Service Technology Matrix

| Service | Web | Data Access | Discovery | Gateway | Health/Observability | Cache | Metrics |
|---|---|---|---|---|---|---|---|
| NUR2 DATA Edge Functions | Supabase Edge Functions | Supabase client and PostgreSQL RPC | None observed | Supabase function endpoints | UNKNOWN | None observed | UNKNOWN |
| VTUGate | UNKNOWN | UNKNOWN | UNKNOWN | External API; purchase/status contract UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

## Service Communication Sequence

<!-- mermaid-checked: every participant uses `participant Id as "Label"`, no \n in aliases/messages/notes, every alt/opt/loop closed by end, no `:` inside any alias -->
~~~mermaid
sequenceDiagram
    participant User as "User"
    participant Client as "NUR2 DATA Client"
    participant Catalog as "Catalog Edge Function"
    participant Provider as "VTUGate"
    participant Intake as "Purchase Intake Function"
    participant DB as "Supabase Database"
    participant Worker as "Disabled Purchase Worker"

    User->>Client: Review available plans
    Client->>Catalog: Authenticated plan lookup
    Catalog->>Provider: Source-observed catalog request
    Provider-->>Catalog: Catalog response schema not vendor-verified
    Catalog-->>Client: Plan response
    Note over Client,Intake: Current client does not invoke purchase intake
    Note over Intake,Worker: Intake flag must remain disabled and worker stays disabled
    opt Separately approved future validation only
        Client->>Intake: Authenticated request with idempotency key
        Intake->>DB: Catalog-priced idempotent debit and purchase record
        DB-->>Intake: Purchase reference and current state
        Intake-->>Client: Prepared purchase result
        Note over Worker,Provider: Buy Data and Transaction Status contracts are UNKNOWN; no calls permitted
    end
~~~

## Provider Reference and Idempotency Requirements

The repository has distinct NUR2 request/idempotency and provider-correlation fields:

| Exact field | NUR2 purpose | VTUGate meaning |
|---|---|---|
| `idempotency_key` | Supplied in the purchase-intake request. NUR2 uses it as the idempotency key scoped to the authenticated `user_id`; it is not itself a provider reference. | Whether VTUGate accepts it is **UNKNOWN**. |
| `reference` / `p_reference` | The handler derives `reference` as a SHA-256 digest of the authenticated user ID and `idempotency_key`, passes it to the database RPC as `p_reference`, persists it as `data_purchases.reference`, and returns it in the NUR2 response. It is an NUR2 request/tracking reference; the database's per-user idempotency lookup uses `idempotency_key`. | Whether VTUGate accepts, echoes, or looks it up is **UNKNOWN**. |
| `client_reference` | A separate UUID generated and persisted by the database for the purchase. It is NUR2's provider-correlation reference candidate, distinct from `reference`. | Whether VTUGate accepts, echoes, or supports status lookup by it is **UNKNOWN**. |
| `provider_transaction_id`, `provider_external_reference`, `provider_reference` | NUR2 persistence fields for provider-related identifiers. The current outcome function assigns `p_provider_external_reference` to both `provider_external_reference` and `provider_reference`; these are internal field mappings only. | Which identifiers VTUGate returns, and their semantics, are **UNKNOWN**. |

1. A retry of the same logical purchase must reuse the same authenticated-user-scoped `idempotency_key` and resolve to the original NUR2 purchase without another debit.
2. Keep the persisted `client_reference` stable for that purchase. Do not treat its name as proof VTUGate accepts or searches it; confirm the accepted reference field and status-lookup key with authoritative VTUGate documentation.
3. Before implementation, determine whether VTUGate supports an idempotency key distinct from its transaction/reference field. That behavior is **UNKNOWN**. Until documented, do not assume provider-side duplicate protection.
4. Never generate a new `client_reference` for an ambiguous retry, timeout, or reconciliation attempt. Never use a browser-supplied value as provider authority.
5. Confirm accepted reference field, uniqueness scope, allowable characters/length, retention, and duplicate-reference response with VTUGate. All are **UNKNOWN**.

## Safe Retry and Reconciliation Rules

- A purchase attempt must have one stable, server-owned NUR2 `client_reference` and one current database lease. Whether VTUGate accepts `client_reference` as its provider reference is **UNKNOWN**.
- Do not retry submission on timeout, connection reset, invalid response, unrecognized status, or any result that could mean VTUGate accepted the request.
- Reconcile ambiguous attempts using the documented Transaction Status API and original `client_reference` only if VTUGate confirms that field is a supported lookup key. Otherwise automated lookup is **UNKNOWN** and the attempt must remain unresolved pending a documented safe procedure.
- Only a definitive, authoritative not-found result—after the provider-confirmed visibility/settling window—can permit another submission. Reuse the same `client_reference` and require the current lease; whether VTUGate accepts it for resubmission is **UNKNOWN** until confirmed.
- Do not treat an empty response, HTTP status, transport error, or undocumented provider message as definitive not-found or failure.
- Enforce maximum provider attempts, backoff, request timeout, rate limiting, and operator escalation only after VTUGate supplies authoritative values. These limits are **UNKNOWN**; do not invent them.
- Any stale, invalid, or expired lease must prevent settlement and provider retry. Expired work must enter reconciliation, not automatic resubmission.

## Wallet Debit, Refund, and Duplicate-Submission Protections

- Debit and purchase creation must remain atomic and idempotent. Verify the server-selected plan/price before debit.
- A debit is not permission to submit repeatedly. A provider timeout or uncertain result must leave funds reserved pending reconciliation.
- Only a documented definitive provider failure can trigger refund. Refund creation, debit status update, purchase outcome, and wallet credit must commit atomically.
- Link each refund to its source purchase debit and enforce uniqueness so retries cannot credit twice. Never refund a successful, pending, or unresolved purchase.
- Validate the current lease and purchase/action state before applying outcomes. Reject stale, mismatched, or expired leases.
- Do not use VTUGate merchant-wallet balance/reconciliation fields to calculate customer funds due. Customer accounting uses NUR2 DATA customer debit/refund records only.
- Keep purchase intake and worker disabled until provider documentation, the approved state mapping, and isolated mock/database validation are reviewed.

## Mock-Only Contract Test Scenarios

Tests must stub all provider requests; no live VTUGate calls are permitted in contract-test development or validation.

1. Catalog-shaped request/response fixture is treated separately from purchase API fixtures; no catalog fields are assumed valid for Buy Data.
2. Buy Data documented success maps to successful settlement once; duplicate delivery/retry does not create a second debit or provider submission.
3. Documented definitive failure maps to one atomic linked refund; repeated processing does not refund again.
4. Documented pending/processing response remains pending and is eligible for status reconciliation only.
5. Timeout before a response, connection loss, malformed JSON, unknown fields/status, and mismatched reference all remain unknown and do not trigger resubmission or refund.
6. Transaction Status success/failure/pending fixtures map only according to the approved VTUGate mapping table.
7. Definitive not-found fixtures before and after the provider-confirmed consistency window prove that retry is blocked before the window and, if approved, reuses the same `client_reference` only after VTUGate documentation confirms it is accepted for lookup and submission.
8. Status lookup timeout, rate-limit response, authentication failure, and provider outage do not cause duplicate submissions; exact handling awaits documented provider semantics.
9. Duplicate provider reference, duplicate transaction identifier, and repeated callback/status results preserve exactly-once settlement.
10. Invalid/expired lease, wrong action, stale result, concurrent worker claim, and worker-disabled/intake-disabled states produce no provider call or settlement.
11. Unauthorized users, caller-supplied price/user/reference values, and repeated user idempotency keys cannot bypass server validation or debit rules.
12. Tests assert outbound method, destination, authentication placement, content type, request fields, timeout, and response parsing against reviewed fixtures only after authoritative schemas are approved.

## Approval Gate

Before any provider adapter is implemented or enabled, attach the authoritative Buy Data and Transaction Status materials, resolve every **UNKNOWN** item above, review the exact request/response mapping and retry policy, and approve a separate isolated validation phase. This document does not authorize enabling intake, enabling the worker, making live provider requests, or deployment.
