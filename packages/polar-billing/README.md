# `@humans/polar-billing`

Production Polar boundary for Organization billing and Credit usage. It uses
native `fetch` and pins every request to the stable `2026-04` contract with the
`Polar-Version` header.

## Configuration

`createPolarBillingClient` requires values normally sourced from:

| Option | Environment input | Purpose |
| --- | --- | --- |
| `accessToken` | `POLAR_ACCESS_TOKEN` | Server-only Organization Access Token |
| `baseUrl` | `POLAR_BASE_URL` | Exactly `https://api.polar.sh/v1` or `https://sandbox-api.polar.sh/v1` |
| `organizationId` | `POLAR_ORGANIZATION_ID` | Polar Organization UUID |
| `proProductId` | `POLAR_PRO_PRODUCT_ID` | Server-pinned Pro product UUID |
| `usageMeterId` | `POLAR_USAGE_METER_ID` | One-Credit count meter UUID |
| `usageEventName` | `POLAR_USAGE_EVENT_NAME` | Event name selected by that meter |
| `successUrlAllowlist` | Application configuration | Allowed redirect origins, written as origin URLs |

The optional `fetch` and `clock` constructor values are injectable seams for
Workers and deterministic tests. The boundary does not log requests, responses,
tokens, customer email addresses, payloads, or generated checkout and portal
URLs.

## Polar contract

| Operation | Endpoint | Documented OAT scopes |
| --- | --- | --- |
| Get or ensure Customer | `GET /v1/customers/external/{external_id}` and `POST /v1/customers/` | `customers:read`, `customers:write` |
| Create Pro checkout | `POST /v1/checkouts/` | `checkouts:write` |
| Create Customer Portal session | `POST /v1/customer-sessions/` | `customer_sessions:write` |
| Read Customer state | `GET /v1/customers/external/{external_id}/state` | `customers:read`, `customers:write` |
| Ingest finalized Credit usage | `POST /v1/events/ingest` | `events:write` |
| Read meter quantities | `GET /v1/meters/{id}/quantities` | `meters:read`, `meters:write` |

Checkout callers cannot supply a product, price, amount, units, seats, or
metered price. The request contains the configured Pro product only, disables
discount codes and trials, and omits all ad-hoc and metered pricing fields. The
Polar product catalog must itself be provisioned as the $20 monthly product with
no metered price; the checkout endpoint does not expose a way to constrain a
catalog product's existing prices.

Each Humans Organization is represented by a Team Customer whose immutable
`external_id` is its Clerk Organization ID. Its owner uses the immutable Clerk
Member ID as `owner.external_id` and the Member email as `owner.email`. The
email is never sent as the Customer's unique `email`, so the same Member can own
more than one Organization Customer.

The checkout also sets `metadata.humansOrganizationId` to the immutable Clerk
Organization ID. Polar copies checkout metadata to the resulting subscription,
which is the link consumed by the API's verified subscription webhook parser.

Each finalized usage item creates exactly one countable event. Its local
idempotency key is sent as Polar's event `external_id`, and the immutable Clerk
Organization ID is sent as `external_customer_id`.

## 2026-04 notes

- An OAT is already tied to one Polar Organization, so `organization_id` is
  optional in Polar's Customer and Event schemas. This boundary still requires
  it, sends it where those schemas allow it, and validates it on responses.
- The Customer create OpenAPI page documents `422`, not `409`, for validation
  failures. Polar currently reports duplicate email or external ID as `422`.
  The ensure operation handles both `422` and defensive `409` race responses by
  looking up the immutable external ID again; it never inspects or exposes the
  potentially sensitive error body.
- Customer state contains only active subscriptions, whose `2026-04` statuses
  are `active` and `trialing`. Past-due and terminal status transitions remain a
  webhook concern.
- Polar webhook deliveries use the full opaque webhook secret as the HMAC key.
  The API adapter therefore supplies its UTF-8 bytes to `standardwebhooks` in
  raw mode instead of stripping or base64-decoding the secret.
- The Customer Session page says the owner is selected automatically when the
  Polar member model is enabled, while its field-level schema limits that
  default to individual Customers. This boundary creates team Customers and
  identifies portal sessions by external Customer ID, so enabling Polar's
  optional member model would require resolving and supplying a member ID.
- The Checkout create schema has no request-idempotency field or documented
  idempotency header. A retried `429` or `5xx` can therefore leave an additional
  unused open checkout session, but cannot itself create a charge.
- Polar attributes late usage to the billing period in which Polar receives the
  event, even when the supplied event timestamp is older.
