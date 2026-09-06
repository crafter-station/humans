# Polar Sandbox setup

Humans uses Polar Sandbox for local and Preview billing. Sandbox is fully
isolated from Polar Production: create the Organization, tokens, catalog, and
webhook in `sandbox.polar.sh`, even if their Production counterparts exist.

## Provision the catalog

1. Open <https://sandbox.polar.sh/start>, create a sandbox account, and create
   or select the Humans sandbox Organization.
2. In personal settings, create a sandbox Personal Access Token for
   provisioning, or create an Organization Access Token in the sandbox
   Organization. Grant `organizations:read`, `organizations:write`,
   `meters:read`, `meters:write`, `benefits:read`, `benefits:write`,
   `products:read`, and `products:write`. Also grant `webhooks:read` and
   `webhooks:write` if the script will configure a deployed webhook.
3. Supply the token without putting it in an application environment file. If
   commands run in the same persistent shell session, export it temporarily:

   ```sh
   export POLAR_PERSONAL_ACCESS_TOKEN=polar_pat_replace_me
   ```

   If each command runs in an isolated shell, copy the token to the macOS
   clipboard and pipe it to the provisioner instead:

   ```sh
   pbpaste | bun run setup:polar:sandbox --token-stdin
   ```

4. Provision the meter, 1,000-Credit benefit, `$20 USD` monthly Pro product,
   and the Organization subscription setting:

   ```sh
   bun run setup:polar:sandbox
   ```

   If the token can access more than one Polar Organization, rerun with the ID
   printed by the command:

   ```sh
   bun run setup:polar:sandbox --organization-id <polar-organization-uuid>
   ```

   The command is repeatable. It reuses resources tagged with
   `humansProvisioningKey=humans-v1-sandbox` and stops if their billing shape no
   longer matches the Humans v1 contract. It does not delete or archive other
   Polar resources.

## Configure webhooks

For a deployed Worker, pass its public webhook URL while provisioning:

```sh
bun run setup:polar:sandbox --organization-id <uuid> \
  --webhook-url https://<worker-host>/webhooks/polar
```

The script creates or updates one raw `Humans billing` endpoint for all
subscription lifecycle events plus `order.paid` and `order.refunded`, then
prints its signing secret.

For local development, install the Polar CLI and forward directly to the local
Worker instead of creating a permanent endpoint:

```sh
curl -fsSL https://polar.sh/install.sh | bash
polar login
polar listen http://localhost:8787/webhooks/polar
```

Use the signing secret printed by `polar listen` as `POLAR_WEBHOOK_SECRET` for
that local session.

## Create the runtime token

The provisioning Personal Access Token is not the application credential. In
the sandbox Organization's **Settings > Developers** section, create a separate
Organization Access Token with these least-privilege scopes:

- `customers:read`, `customers:write`
- `checkouts:read`, `checkouts:write`
- `customer_sessions:write`
- `subscriptions:read`
- `events:write`
- `meters:read`, `meters:write`

Store that Organization Access Token as `POLAR_ACCESS_TOKEN` only in the target
server-side secret store.

## Configure Humans

The provisioner prints the non-secret IDs and, when applicable, the webhook
secret assignment. Configure all of these together; partial Polar configuration
is rejected:

```dotenv
POLAR_ACCESS_TOKEN=polar_oat_replace_me
POLAR_BASE_URL=https://sandbox-api.polar.sh/v1
POLAR_ORGANIZATION_ID=<printed-organization-id>
POLAR_PRO_PRODUCT_ID=<printed-product-id>
POLAR_CUSTOMER_OWNER_EMAIL=billing@example.com
POLAR_USAGE_METER_ID=<printed-meter-id>
POLAR_USAGE_EVENT_NAME=credit_consumed
POLAR_WEBHOOK_SECRET=<webhook-or-listen-secret>
BILLING_APP_ORIGIN=http://localhost:3000
```

Use an operator-managed service mailbox for `POLAR_CUSTOMER_OWNER_EMAIL`, never
a Humans Member's email address. For Preview, use its immutable Vercel Preview
origin and the repository's `bun run configure:api:preview-origin` flow.

## Verify the sandbox

1. Confirm **Allow multiple subscriptions** is disabled in Polar Organization
   settings.
2. Confirm `Humans Pro` has one active fixed price: `$20 USD`, monthly, with no
   trial, seat, unit, or metered overage price.
3. Confirm its only benefit grants 1,000 units on `Humans Credits` each cycle
   with rollover disabled.
4. Start the API and web application, create a checkout from the Humans billing
   page, and pay with Stripe's sandbox card `4242 4242 4242 4242`, any future
   expiry, and any CVC.
5. Confirm Polar delivers `order.paid`, Humans grants exactly 1,000 Organization
   Credits, the billing page shows Pro, and the customer portal opens.
6. Exercise cancellation and a refund in Polar and confirm the corresponding
   webhook deliveries return successful responses.
