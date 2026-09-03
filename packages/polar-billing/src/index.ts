export const POLAR_API_VERSION = "2026-04" as const;
export const POLAR_PRODUCTION_BASE_URL = "https://api.polar.sh/v1" as const;
export const POLAR_SANDBOX_BASE_URL =
  "https://sandbox-api.polar.sh/v1" as const;

export type PolarBaseUrl =
  | typeof POLAR_PRODUCTION_BASE_URL
  | typeof POLAR_SANDBOX_BASE_URL;

export type PolarBillingClock = {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
};

export type PolarBillingErrorCode =
  | "invalid_configuration"
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "malformed_response";

export type PolarBillingOperation =
  | "get_customer"
  | "create_customer"
  | "create_checkout"
  | "create_customer_session"
  | "get_customer_state"
  | "ingest_usage"
  | "get_meter_quantities";

const ERROR_MESSAGES: Record<PolarBillingErrorCode, string> = {
  invalid_configuration: "Invalid Polar billing configuration.",
  invalid_input: "Invalid Polar billing input.",
  unauthorized: "Polar authentication failed.",
  forbidden: "Polar authorization failed.",
  not_found: "The Polar resource was not found.",
  conflict: "The Polar request conflicted with existing state.",
  invalid_request: "Polar rejected the request.",
  rate_limited: "Polar rate limited the request.",
  server_error: "Polar could not complete the request.",
  network_error: "Polar could not be reached.",
  malformed_response: "Polar returned an invalid response.",
};

export class PolarBillingError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: PolarBillingErrorCode,
    readonly details: {
      operation?: PolarBillingOperation;
      field?: string;
      statusCode?: number;
      retryAfterMs?: number;
    } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "PolarBillingError";
    this.retryable =
      code === "rate_limited" ||
      code === "server_error" ||
      code === "network_error";
  }
}

export type PolarCustomer = {
  id: string;
  clerkOrganizationId: string;
  type: "team";
};

export type PolarCustomerOwner = {
  externalId: string;
  email: string;
};

export type EnsurePolarCustomerInput = {
  clerkOrganizationId: string;
  name: string;
  owner: PolarCustomerOwner;
};

export type CreateProCheckoutInput = {
  clerkOrganizationId: string;
  successUrl: string;
};

export type PolarCheckoutSession = {
  id: string;
  url: string;
  expiresAt: Date;
};

export type CreateCustomerPortalSessionInput = {
  clerkOrganizationId: string;
  returnUrl?: string;
};

export type PolarCustomerPortalSession = {
  id: string;
  url: string;
  expiresAt: Date;
};

export type PolarSubscription = {
  id: string;
  status: "active" | "trialing";
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
};

export type PolarCustomerState = {
  customer: PolarCustomer;
  proSubscription: PolarSubscription | null;
};

export type FinalizedCreditUsage = {
  idempotencyKey: string;
  clerkOrganizationId: string;
  occurredAt?: Date;
};

export type PolarUsageIngestResult = {
  inserted: number;
  duplicates: number;
};

export type PolarMeterInterval = "year" | "month" | "week" | "day" | "hour";

export type GetMeterQuantitiesInput = {
  clerkOrganizationId: string;
  startAt: Date;
  endAt: Date;
  interval: PolarMeterInterval;
};

export type PolarMeterQuantity = {
  timestamp: Date;
  quantity: number;
};

export type PolarMeterQuantities = {
  quantities: readonly PolarMeterQuantity[];
  total: number;
};

export type PolarBillingClient = {
  getCustomer(clerkOrganizationId: string): Promise<PolarCustomer>;
  ensureCustomer(input: EnsurePolarCustomerInput): Promise<PolarCustomer>;
  createProCheckout(
    input: CreateProCheckoutInput,
  ): Promise<PolarCheckoutSession>;
  createCustomerPortalSession(
    input: CreateCustomerPortalSessionInput,
  ): Promise<PolarCustomerPortalSession>;
  getCustomerState(clerkOrganizationId: string): Promise<PolarCustomerState>;
  ingestFinalizedCreditUsage(
    events: readonly FinalizedCreditUsage[],
  ): Promise<PolarUsageIngestResult>;
  getMeterQuantities(
    input: GetMeterQuantitiesInput,
  ): Promise<PolarMeterQuantities>;
};

export type CreatePolarBillingClientOptions = {
  accessToken: string;
  baseUrl: PolarBaseUrl;
  organizationId: string;
  proProductId: string;
  usageMeterId: string;
  usageEventName: string;
  successUrlAllowlist: readonly string[];
  fetch?: typeof globalThis.fetch;
  clock?: PolarBillingClock;
};

type JsonObject = Record<string, unknown>;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLERK_ORGANIZATION_ID = /^org_[A-Za-z0-9_-]+$/;
const RFC_3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const METER_INTERVALS = new Set<PolarMeterInterval>([
  "year",
  "month",
  "week",
  "day",
  "hour",
]);
const MAX_ATTEMPTS = 3;

const systemClock: PolarBillingClock = {
  now: () => new Date(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const configurationError = (field: string): never => {
  throw new PolarBillingError("invalid_configuration", { field });
};

const inputError = (field: string): never => {
  throw new PolarBillingError("invalid_input", { field });
};

const malformedResponse = (operation: PolarBillingOperation): never => {
  throw new PolarBillingError("malformed_response", { operation });
};

const assertExactInputKeys = (
  value: unknown,
  allowedKeys: readonly string[],
  field: string,
): JsonObject => {
  if (!isObject(value)) return inputError(field);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) inputError(field);
  return value;
};

const requireConfigurationString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value === "" || value !== value.trim())
    return configurationError(field);
  return value;
};

const requireInputString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value === "" || value !== value.trim())
    return inputError(field);
  return value;
};

const requireResponseString = (
  value: unknown,
  operation: PolarBillingOperation,
): string => {
  if (typeof value !== "string" || value === "")
    return malformedResponse(operation);
  return value;
};

const requireUuidConfiguration = (value: unknown, field: string): string => {
  const id = requireConfigurationString(value, field);
  if (!UUID_V4.test(id)) configurationError(field);
  return id;
};

const requireUuidResponse = (
  value: unknown,
  operation: PolarBillingOperation,
): string => {
  const id = requireResponseString(value, operation);
  if (!UUID_V4.test(id)) malformedResponse(operation);
  return id;
};

const requireClerkOrganizationId = (value: unknown): string => {
  const id = requireInputString(value, "clerkOrganizationId");
  if (!CLERK_ORGANIZATION_ID.test(id)) inputError("clerkOrganizationId");
  return id;
};

const requireInputDate = (value: unknown, field: string): Date => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return inputError(field);
  return value;
};

const requireResponseDate = (
  value: unknown,
  operation: PolarBillingOperation,
): Date => {
  const timestamp = requireResponseString(value, operation);
  if (!RFC_3339.test(timestamp)) malformedResponse(operation);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) malformedResponse(operation);
  return date;
};

const requireResponseNumber = (
  value: unknown,
  operation: PolarBillingOperation,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return malformedResponse(operation);
  return value;
};

const requireResponseInteger = (
  value: unknown,
  operation: PolarBillingOperation,
): number => {
  const number = requireResponseNumber(value, operation);
  if (!Number.isSafeInteger(number)) malformedResponse(operation);
  return number;
};

const requireResponseObject = (
  value: unknown,
  operation: PolarBillingOperation,
): JsonObject => {
  if (!isObject(value)) return malformedResponse(operation);
  return value;
};

const readClockNow = (clock: PolarBillingClock): Date => {
  let now: Date;
  try {
    now = clock.now();
  } catch {
    return configurationError("clock.now");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    return configurationError("clock.now");
  return now;
};

const requireWebUrl = (
  value: unknown,
  onError: () => never,
): { value: string; url: URL } => {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    value.length > 2083
  )
    return onError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return onError();
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  )
    return onError();
  return { value, url };
};

const parseCustomer = (
  value: unknown,
  operation: PolarBillingOperation,
  expectedExternalId: string,
  expectedOrganizationId: string,
): PolarCustomer => {
  const customer = requireResponseObject(value, operation);
  const id = requireUuidResponse(customer.id, operation);
  const externalId = requireResponseString(customer.external_id, operation);
  const organizationId = requireUuidResponse(
    customer.organization_id,
    operation,
  );
  if (
    externalId !== expectedExternalId ||
    organizationId !== expectedOrganizationId
  )
    malformedResponse(operation);
  if (customer.type !== "team") return malformedResponse(operation);
  return {
    id,
    clerkOrganizationId: externalId,
    type: "team",
  };
};

const parseRetryAfter = (
  value: string | null,
  clock: PolarBillingClock,
): number | undefined => {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  const now = readClockNow(clock);
  return Math.max(0, timestamp - now.getTime());
};

const cancelResponse = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already being discarded; cancellation is best effort.
  }
};

const mapResponseError = (
  operation: PolarBillingOperation,
  response: Response,
  retryAfterMs?: number,
): PolarBillingError => {
  const details = { operation, statusCode: response.status, retryAfterMs };
  if (response.status === 401)
    return new PolarBillingError("unauthorized", details);
  if (response.status === 403)
    return new PolarBillingError("forbidden", details);
  if (response.status === 404)
    return new PolarBillingError("not_found", details);
  if (response.status === 409)
    return new PolarBillingError("conflict", details);
  if (response.status === 422)
    return new PolarBillingError("invalid_request", details);
  if (response.status === 429)
    return new PolarBillingError("rate_limited", details);
  if (response.status >= 500 && response.status <= 599)
    return new PolarBillingError("server_error", details);
  return new PolarBillingError("malformed_response", details);
};

export const createPolarBillingClient = (
  options: CreatePolarBillingClientOptions,
): PolarBillingClient => {
  if (!isObject(options)) configurationError("options");
  const accessToken = requireConfigurationString(
    options.accessToken,
    "accessToken",
  );
  if (!accessToken.startsWith("polar_oat_")) configurationError("accessToken");
  if (
    options.baseUrl !== POLAR_PRODUCTION_BASE_URL &&
    options.baseUrl !== POLAR_SANDBOX_BASE_URL
  )
    configurationError("baseUrl");
  const baseUrl = options.baseUrl;
  const organizationId = requireUuidConfiguration(
    options.organizationId,
    "organizationId",
  );
  const proProductId = requireUuidConfiguration(
    options.proProductId,
    "proProductId",
  );
  const usageMeterId = requireUuidConfiguration(
    options.usageMeterId,
    "usageMeterId",
  );
  const usageEventName = requireConfigurationString(
    options.usageEventName,
    "usageEventName",
  );
  if (usageEventName.length > 128) configurationError("usageEventName");
  if (
    !Array.isArray(options.successUrlAllowlist) ||
    options.successUrlAllowlist.length === 0
  )
    configurationError("successUrlAllowlist");

  const allowedOrigins = new Set<string>();
  for (const entry of options.successUrlAllowlist) {
    const allowed = requireWebUrl(entry, () =>
      configurationError("successUrlAllowlist"),
    );
    if (
      allowed.url.pathname !== "/" ||
      allowed.url.search !== "" ||
      allowed.url.hash !== ""
    )
      configurationError("successUrlAllowlist");
    allowedOrigins.add(allowed.url.origin);
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") configurationError("fetch");
  const clock = options.clock ?? systemClock;
  if (
    !isObject(clock) ||
    typeof clock.now !== "function" ||
    typeof clock.sleep !== "function"
  )
    configurationError("clock");

  const validateRedirectUrl = (value: unknown, field: string): string => {
    const redirect = requireWebUrl(value, () => inputError(field));
    if (!allowedOrigins.has(redirect.url.origin)) inputError(field);
    return redirect.value;
  };

  const parseJson = async (
    response: Response,
    operation: PolarBillingOperation,
  ): Promise<unknown> => {
    if (response.headers.get("Polar-Version") !== POLAR_API_VERSION)
      malformedResponse(operation);
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType))
      malformedResponse(operation);
    try {
      return await response.json();
    } catch {
      return malformedResponse(operation);
    }
  };

  const request = async (
    operation: PolarBillingOperation,
    path: string,
    method: "GET" | "POST",
    expectedStatus: number,
    body?: JsonObject,
  ): Promise<unknown> => {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Polar-Version": POLAR_API_VERSION,
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const serializedBody =
      body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImplementation(`${baseUrl}${path}`, {
          method,
          headers,
          body: serializedBody,
          redirect: "manual",
        });
      } catch {
        throw new PolarBillingError("network_error", { operation });
      }
      if (!(response instanceof Response)) malformedResponse(operation);

      const retryableStatus =
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599);
      const retryAfterMs = retryableStatus
        ? parseRetryAfter(response.headers.get("Retry-After"), clock)
        : undefined;
      if (retryableStatus && attempt < MAX_ATTEMPTS) {
        await cancelResponse(response);
        const delay = retryAfterMs ?? 250 * 2 ** (attempt - 1);
        try {
          await clock.sleep(delay);
        } catch {
          throw new PolarBillingError("network_error", { operation });
        }
        continue;
      }

      if (response.status !== expectedStatus) {
        await cancelResponse(response);
        throw mapResponseError(operation, response, retryAfterMs);
      }
      return parseJson(response, operation);
    }
    throw new PolarBillingError("server_error", { operation });
  };

  const getCustomer = async (
    clerkOrganizationIdValue: string,
  ): Promise<PolarCustomer> => {
    const clerkOrganizationId = requireClerkOrganizationId(
      clerkOrganizationIdValue,
    );
    const response = await request(
      "get_customer",
      `/customers/external/${encodeURIComponent(clerkOrganizationId)}`,
      "GET",
      200,
    );
    return parseCustomer(
      response,
      "get_customer",
      clerkOrganizationId,
      organizationId,
    );
  };

  return {
    getCustomer,

    async ensureCustomer(input) {
      const value = assertExactInputKeys(
        input,
        ["clerkOrganizationId", "name", "owner"],
        "input",
      );
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const name = requireInputString(value.name, "name");
      if (name.length > 256) inputError("name");
      const owner = assertExactInputKeys(
        value.owner,
        ["externalId", "email"],
        "owner",
      );
      const ownerExternalId = requireInputString(
        owner.externalId,
        "owner.externalId",
      );
      const ownerEmail = requireInputString(owner.email, "owner.email");
      if (ownerEmail.length > 254 || !EMAIL.test(ownerEmail))
        inputError("owner.email");

      try {
        return await getCustomer(clerkOrganizationId);
      } catch (error) {
        if (!(error instanceof PolarBillingError) || error.code !== "not_found")
          throw error;
      }

      try {
        const response = await request(
          "create_customer",
          "/customers/",
          "POST",
          201,
          {
            type: "team",
            external_id: clerkOrganizationId,
            name,
            organization_id: organizationId,
            owner: {
              external_id: ownerExternalId,
              email: ownerEmail,
            },
          },
        );
        return parseCustomer(
          response,
          "create_customer",
          clerkOrganizationId,
          organizationId,
        );
      } catch (error) {
        const shouldRecover =
          error instanceof PolarBillingError &&
          (error.code === "conflict" ||
            error.code === "invalid_request" ||
            error.code === "network_error" ||
            error.code === "server_error");
        if (!shouldRecover) throw error;
        try {
          return await getCustomer(clerkOrganizationId);
        } catch (lookupError) {
          if (
            lookupError instanceof PolarBillingError &&
            lookupError.code === "not_found"
          )
            throw error;
          throw lookupError;
        }
      }
    },

    async createProCheckout(input) {
      const value = assertExactInputKeys(
        input,
        ["clerkOrganizationId", "successUrl"],
        "input",
      );
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const successUrl = validateRedirectUrl(value.successUrl, "successUrl");
      const response = requireResponseObject(
        await request("create_checkout", "/checkouts/", "POST", 201, {
          products: [proProductId],
          external_customer_id: clerkOrganizationId,
          success_url: successUrl,
          allow_discount_codes: false,
          allow_trial: false,
          metadata: { humansOrganizationId: clerkOrganizationId },
        }),
        "create_checkout",
      );
      const id = requireUuidResponse(response.id, "create_checkout");
      const responseProductId = requireUuidResponse(
        response.product_id,
        "create_checkout",
      );
      const responseOrganizationId = requireUuidResponse(
        response.organization_id,
        "create_checkout",
      );
      const responseExternalId = requireResponseString(
        response.external_customer_id,
        "create_checkout",
      );
      const responseMetadata = requireResponseObject(
        response.metadata,
        "create_checkout",
      );
      requireUuidResponse(response.customer_id, "create_checkout");
      if (
        response.status !== "open" ||
        responseProductId !== proProductId ||
        responseOrganizationId !== organizationId ||
        responseExternalId !== clerkOrganizationId ||
        responseMetadata.humansOrganizationId !== clerkOrganizationId
      )
        malformedResponse("create_checkout");
      const checkout = requireWebUrl(response.url, () =>
        malformedResponse("create_checkout"),
      );
      if (checkout.url.protocol !== "https:")
        malformedResponse("create_checkout");
      return {
        id,
        url: checkout.value,
        expiresAt: requireResponseDate(response.expires_at, "create_checkout"),
      };
    },

    async createCustomerPortalSession(input) {
      const value = assertExactInputKeys(
        input,
        ["clerkOrganizationId", "returnUrl"],
        "input",
      );
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const body: JsonObject = {
        external_customer_id: clerkOrganizationId,
      };
      if (value.returnUrl !== undefined)
        body.return_url = validateRedirectUrl(value.returnUrl, "returnUrl");
      const response = requireResponseObject(
        await request(
          "create_customer_session",
          "/customer-sessions/",
          "POST",
          201,
          body,
        ),
        "create_customer_session",
      );
      const id = requireUuidResponse(response.id, "create_customer_session");
      const customerId = requireUuidResponse(
        response.customer_id,
        "create_customer_session",
      );
      requireResponseString(response.token, "create_customer_session");
      const customer = parseCustomer(
        response.customer,
        "create_customer_session",
        clerkOrganizationId,
        organizationId,
      );
      if (customer.id !== customerId)
        malformedResponse("create_customer_session");
      const portal = requireWebUrl(response.customer_portal_url, () =>
        malformedResponse("create_customer_session"),
      );
      if (portal.url.protocol !== "https:")
        malformedResponse("create_customer_session");
      return {
        id,
        url: portal.value,
        expiresAt: requireResponseDate(
          response.expires_at,
          "create_customer_session",
        ),
      };
    },

    async getCustomerState(clerkOrganizationIdValue) {
      const clerkOrganizationId = requireClerkOrganizationId(
        clerkOrganizationIdValue,
      );
      const response = requireResponseObject(
        await request(
          "get_customer_state",
          `/customers/external/${encodeURIComponent(clerkOrganizationId)}/state`,
          "GET",
          200,
        ),
        "get_customer_state",
      );
      const customer = parseCustomer(
        response,
        "get_customer_state",
        clerkOrganizationId,
        organizationId,
      );
      const activeSubscriptions = response.active_subscriptions;
      if (!Array.isArray(activeSubscriptions))
        return malformedResponse("get_customer_state");

      const ids = new Set<string>();
      const proSubscriptions: PolarSubscription[] = [];
      for (const item of activeSubscriptions) {
        const subscription = requireResponseObject(item, "get_customer_state");
        const id = requireUuidResponse(subscription.id, "get_customer_state");
        if (ids.has(id)) malformedResponse("get_customer_state");
        ids.add(id);
        const status = subscription.status;
        if (status !== "active" && status !== "trialing")
          return malformedResponse("get_customer_state");
        const productId = requireUuidResponse(
          subscription.product_id,
          "get_customer_state",
        );
        const currentPeriodStart = requireResponseDate(
          subscription.current_period_start,
          "get_customer_state",
        );
        const currentPeriodEnd = requireResponseDate(
          subscription.current_period_end,
          "get_customer_state",
        );
        const cancelAtPeriodEnd = subscription.cancel_at_period_end;
        if (currentPeriodStart.getTime() >= currentPeriodEnd.getTime())
          return malformedResponse("get_customer_state");
        if (typeof cancelAtPeriodEnd !== "boolean")
          return malformedResponse("get_customer_state");
        if (productId === proProductId)
          proSubscriptions.push({
            id,
            status,
            currentPeriodStart,
            currentPeriodEnd,
            cancelAtPeriodEnd,
          });
      }
      if (proSubscriptions.length > 1) malformedResponse("get_customer_state");
      return {
        customer,
        proSubscription: proSubscriptions[0] ?? null,
      };
    },

    async ingestFinalizedCreditUsage(events) {
      if (!Array.isArray(events) || events.length === 0) inputError("events");
      const externalIds = new Set<string>();
      const polarEvents = events.map((event) => {
        const value = assertExactInputKeys(
          event,
          ["idempotencyKey", "clerkOrganizationId", "occurredAt"],
          "events",
        );
        const externalId = requireInputString(
          value.idempotencyKey,
          "idempotencyKey",
        );
        if (externalIds.has(externalId)) inputError("idempotencyKey");
        externalIds.add(externalId);
        const clerkOrganizationId = requireClerkOrganizationId(
          value.clerkOrganizationId,
        );
        const occurredAt = requireInputDate(
          value.occurredAt ?? readClockNow(clock),
          "occurredAt",
        );
        return {
          name: usageEventName,
          external_customer_id: clerkOrganizationId,
          external_id: externalId,
          timestamp: occurredAt.toISOString(),
          organization_id: organizationId,
        };
      });
      const response = requireResponseObject(
        await request("ingest_usage", "/events/ingest", "POST", 200, {
          events: polarEvents,
        }),
        "ingest_usage",
      );
      const inserted = requireResponseInteger(
        response.inserted,
        "ingest_usage",
      );
      const duplicates =
        response.duplicates === undefined
          ? 0
          : requireResponseInteger(response.duplicates, "ingest_usage");
      if (inserted + duplicates !== events.length)
        malformedResponse("ingest_usage");
      return { inserted, duplicates };
    },

    async getMeterQuantities(input) {
      const value = assertExactInputKeys(
        input,
        ["clerkOrganizationId", "startAt", "endAt", "interval"],
        "input",
      );
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const startAt = requireInputDate(value.startAt, "startAt");
      const endAt = requireInputDate(value.endAt, "endAt");
      if (startAt.getTime() >= endAt.getTime()) inputError("endAt");
      const interval = value.interval;
      if (
        typeof interval !== "string" ||
        !METER_INTERVALS.has(interval as PolarMeterInterval)
      )
        return inputError("interval");
      const query = new URLSearchParams({
        start_timestamp: startAt.toISOString(),
        end_timestamp: endAt.toISOString(),
        interval,
        timezone: "UTC",
        external_customer_id: clerkOrganizationId,
      });
      const response = requireResponseObject(
        await request(
          "get_meter_quantities",
          `/meters/${encodeURIComponent(usageMeterId)}/quantities?${query.toString()}`,
          "GET",
          200,
        ),
        "get_meter_quantities",
      );
      const responseQuantities = response.quantities;
      if (!Array.isArray(responseQuantities))
        return malformedResponse("get_meter_quantities");
      const quantities = responseQuantities.map((item) => {
        const quantity = requireResponseObject(item, "get_meter_quantities");
        return {
          timestamp: requireResponseDate(
            quantity.timestamp,
            "get_meter_quantities",
          ),
          quantity: requireResponseNumber(
            quantity.quantity,
            "get_meter_quantities",
          ),
        };
      });
      return {
        quantities,
        total: requireResponseNumber(response.total, "get_meter_quantities"),
      };
    },
  };
};
