const BASE_URL = "https://sandbox-api.polar.sh/v1";
const API_VERSION = "2026-04";
const PROVISIONING_KEY = "humans-v1-sandbox";
const USAGE_EVENT_NAME = "credit_consumed";
const WEBHOOK_EVENTS = [
  "subscription.created",
  "subscription.active",
  "subscription.updated",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.cycled",
  "subscription.revoked",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "order.paid",
  "order.refunded",
];

const usage = `Usage: bun run setup:polar:sandbox [options]

Required environment:
  POLAR_PERSONAL_ACCESS_TOKEN  Sandbox PAT or OAT used only for provisioning
                              (POLAR_ACCESS_TOKEN is also accepted)

Options:
  --token-stdin               Read the provisioning token from standard input
  --organization-id <uuid>    Required when the token can access multiple Organizations
  --webhook-url <https-url>   Create or update the Humans billing webhook
  --help                      Show this help

The token needs organizations:read/write, meters:read/write,
benefits:read/write, products:read/write, and webhooks:read/write when
--webhook-url is supplied.`;

const parseArguments = (arguments_) => {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--token-stdin") {
      options.token_stdin = true;
      continue;
    }
    if (argument !== "--organization-id" && argument !== "--webhook-url") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return options;
};

// Operator-only scripts are not Turborepo tasks, so their environment is not cached.
let token =
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: documented operator input
  process.env.POLAR_PERSONAL_ACCESS_TOKEN ?? process.env.POLAR_ACCESS_TOKEN;

const api = async (path, { body, method = "GET" } = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Polar-Version": API_VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000);
    throw new Error(
      `Polar ${method} ${path} failed (${response.status}): ${detail}`,
    );
  }
  return response.json();
};

const listAll = async (path) => {
  const separator = path.includes("?") ? "&" : "?";
  const first = await api(`${path}${separator}page=1&limit=100`);
  const items = [...first.items];
  for (let page = 2; page <= first.pagination.max_page; page += 1) {
    const result = await api(`${path}${separator}page=${page}&limit=100`);
    items.push(...result.items);
  }
  return items;
};

const oneProvisionedResource = (resources, kind) => {
  const matches = resources.filter(
    (resource) => resource.metadata?.humansProvisioningKey === PROVISIONING_KEY,
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple provisioned ${kind} resources found; clean them up`,
    );
  }
  return matches[0];
};

const sameEvents = (left, right) =>
  left.length === right.length &&
  [...left].sort().every((event, index) => event === [...right].sort()[index]);

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options.token_stdin) {
    if (token) {
      throw new Error(
        "Use either --token-stdin or a Polar token environment variable, not both",
      );
    }
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    token = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (!token) {
    throw new Error(
      "Set POLAR_PERSONAL_ACCESS_TOKEN, POLAR_ACCESS_TOKEN, or use --token-stdin",
    );
  }

  const organizations = await listAll("/organizations/");
  const organization = options.organization_id
    ? organizations.find((item) => item.id === options.organization_id)
    : organizations.length === 1
      ? organizations[0]
      : undefined;
  if (!organization) {
    const choices = organizations
      .map(({ id, name }) => `${name}: ${id}`)
      .join("\n");
    throw new Error(
      `Select an accessible Polar Organization with --organization-id:\n${choices || "(none found)"}`,
    );
  }
  const organizationOwnership = token.startsWith("polar_oat_")
    ? {}
    : { organization_id: organization.id };

  if (organization.subscription_settings.allow_multiple_subscriptions) {
    await api(`/organizations/${organization.id}`, {
      method: "PATCH",
      body: {
        subscription_settings: {
          ...organization.subscription_settings,
          allow_multiple_subscriptions: false,
        },
      },
    });
  }

  const meters = await listAll(
    `/meters/?organization_id=${encodeURIComponent(organization.id)}&is_archived=false`,
  );
  let meter = oneProvisionedResource(meters, "meter");
  if (!meter) {
    meter = await api("/meters/", {
      method: "POST",
      body: {
        name: "Humans Credits",
        unit: "custom",
        custom_label: "Credit",
        ...organizationOwnership,
        metadata: { humansProvisioningKey: PROVISIONING_KEY },
        filter: {
          conjunction: "and",
          clauses: [
            { property: "name", operator: "eq", value: USAGE_EVENT_NAME },
          ],
        },
        aggregation: { func: "count" },
      },
    });
  }
  const meterIsValid =
    meter.archived_at === null &&
    meter.aggregation?.func === "count" &&
    meter.filter?.conjunction === "and" &&
    meter.filter?.clauses?.length === 1 &&
    meter.filter.clauses[0]?.property === "name" &&
    meter.filter.clauses[0]?.operator === "eq" &&
    meter.filter.clauses[0]?.value === USAGE_EVENT_NAME;
  if (!meterIsValid) {
    throw new Error(`Provisioned meter ${meter.id} does not match Humans v1`);
  }

  const benefits = await listAll(
    `/benefits/?organization_id=${encodeURIComponent(organization.id)}`,
  );
  let benefit = oneProvisionedResource(benefits, "benefit");
  if (!benefit) {
    benefit = await api("/benefits/", {
      method: "POST",
      body: {
        type: "meter_credit",
        description: "1,000 monthly Humans Credits",
        ...organizationOwnership,
        metadata: { humansProvisioningKey: PROVISIONING_KEY },
        properties: { units: 1_000, rollover: false, meter_id: meter.id },
      },
    });
  }
  const benefitIsValid =
    benefit.type === "meter_credit" &&
    benefit.properties?.units === 1_000 &&
    benefit.properties?.rollover === false &&
    benefit.properties?.meter_id === meter.id;
  if (!benefitIsValid) {
    throw new Error(
      `Provisioned benefit ${benefit.id} does not match Humans v1`,
    );
  }

  const products = await listAll(
    `/products/?organization_id=${encodeURIComponent(organization.id)}&is_archived=false`,
  );
  let product = oneProvisionedResource(products, "product");
  if (!product) {
    product = await api("/products/", {
      method: "POST",
      body: {
        name: "Humans Pro",
        description: "1,000 Credits per month for one Humans Organization.",
        visibility: "public",
        ...organizationOwnership,
        metadata: { humansProvisioningKey: PROVISIONING_KEY },
        recurring_interval: "month",
        recurring_interval_count: 1,
        prices: [
          {
            amount_type: "fixed",
            price_currency: "usd",
            price_amount: 2_000,
          },
        ],
      },
    });
  }
  const activePrices = product.prices.filter((price) => !price.is_archived);
  const productCatalogIsValid =
    !product.is_archived &&
    product.recurring_interval === "month" &&
    product.recurring_interval_count === 1 &&
    product.trial_interval === null &&
    activePrices.length === 1 &&
    activePrices[0]?.amount_type === "fixed" &&
    activePrices[0]?.price_currency === "usd" &&
    activePrices[0]?.price_amount === 2_000;
  if (!productCatalogIsValid) {
    throw new Error(
      `Provisioned product ${product.id} does not match Humans v1`,
    );
  }
  if (product.benefits.length === 0) {
    product = await api(`/products/${product.id}/benefits`, {
      method: "POST",
      body: { benefits: [benefit.id] },
    });
  }
  if (product.benefits.length !== 1 || product.benefits[0]?.id !== benefit.id) {
    throw new Error(
      `Provisioned product ${product.id} has unexpected Polar benefits`,
    );
  }

  let webhook;
  if (options.webhook_url) {
    const url = new URL(options.webhook_url);
    if (url.protocol !== "https:") {
      throw new Error("--webhook-url must use HTTPS");
    }
    const webhooks = await listAll(
      `/webhooks/endpoints?organization_id=${encodeURIComponent(organization.id)}`,
    );
    const matches = webhooks.filter(
      (item) => item.name === "Humans billing" || item.url === url.href,
    );
    if (matches.length > 1) {
      throw new Error("Multiple Humans webhook endpoints found; clean them up");
    }
    webhook = matches[0];
    if (!webhook) {
      webhook = await api("/webhooks/endpoints", {
        method: "POST",
        body: {
          url: url.href,
          name: "Humans billing",
          format: "raw",
          events: WEBHOOK_EVENTS,
          ...organizationOwnership,
        },
      });
    } else if (
      webhook.url !== url.href ||
      webhook.format !== "raw" ||
      !webhook.enabled ||
      !sameEvents(webhook.events, WEBHOOK_EVENTS)
    ) {
      webhook = await api(`/webhooks/endpoints/${webhook.id}`, {
        method: "PATCH",
        body: {
          url: url.href,
          name: "Humans billing",
          format: "raw",
          events: WEBHOOK_EVENTS,
          enabled: true,
        },
      });
    }
  }

  console.log(`Provisioned Polar Sandbox Organization: ${organization.name}`);
  console.log(
    "\n# Add these values to the target environment (do not commit secrets)",
  );
  console.log(`POLAR_BASE_URL=${BASE_URL}`);
  console.log(`POLAR_ORGANIZATION_ID=${organization.id}`);
  console.log(`POLAR_PRO_PRODUCT_ID=${product.id}`);
  console.log(`POLAR_USAGE_METER_ID=${meter.id}`);
  console.log(`POLAR_USAGE_EVENT_NAME=${USAGE_EVENT_NAME}`);
  if (webhook) console.log(`POLAR_WEBHOOK_SECRET=${webhook.secret}`);
  else console.log("# POLAR_WEBHOOK_SECRET=<create with --webhook-url>");
  console.log(
    "# POLAR_ACCESS_TOKEN=<create a sandbox Organization Access Token>",
  );
  console.log(
    "# POLAR_CUSTOMER_OWNER_EMAIL=<operator-managed service mailbox>",
  );
  console.log("# BILLING_APP_ORIGIN=<web application origin>");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
