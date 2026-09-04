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
  | "get_customer_member"
  | "create_customer_member"
  | "update_customer_member"
  | "list_customer_members"
  | "get_checkout"
  | "create_checkout"
  | "list_checkouts"
  | "create_customer_session"
  | "list_subscriptions"
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

export type EnsurePolarCustomerInput = {
  clerkOrganizationId: string;
  name: string;
};

export type FindOpenProCheckoutInput = {
  clerkOrganizationId: string;
  successUrl: string;
};

export type CreateProCheckoutInput = FindOpenProCheckoutInput & {
  checkoutClaimId: string;
};

export type GetProCheckoutInput = FindOpenProCheckoutInput & {
  checkoutId: string;
};

export type FindProCheckoutByClaimInput = FindOpenProCheckoutInput & {
  checkoutClaimId: string;
};

export type PolarCheckoutSession = {
  id: string;
  url: string;
  expiresAt: Date;
};

export type PolarCheckout = PolarCheckoutSession & {
  status: "open" | "expired" | "confirmed" | "succeeded" | "failed";
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
  status: "incomplete" | "trialing" | "active" | "past_due" | "paused";
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
  findOpenProCheckout(
    input: FindOpenProCheckoutInput,
  ): Promise<PolarCheckoutSession | null>;
  findProCheckoutByClaim(
    input: FindProCheckoutByClaimInput,
  ): Promise<PolarCheckout | null>;
  getProCheckout(input: GetProCheckoutInput): Promise<PolarCheckout>;
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
  customerOwnerEmail?: string;
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
const CUSTOMER_MEMBER_PAGE_LIMIT = 100;
const MAX_CUSTOMER_MEMBER_LIST_PAGES = 10;
const CHECKOUT_PAGE_LIMIT = 100;
const MAX_CHECKOUT_LIST_PAGES = 10;
const CUSTOMER_OWNER_EXTERNAL_ID = "humans-billing-owner";

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

const requireUuidInput = (value: unknown, field: string): string => {
  const id = requireInputString(value, field);
  if (!UUID_V4.test(id)) inputError(field);
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

const requireSubscriptionStatus = (
  value: unknown,
  operation: PolarBillingOperation,
): PolarSubscription["status"] | "unpaid" => {
  switch (value) {
    case "incomplete":
    case "trialing":
    case "active":
    case "past_due":
    case "unpaid":
    case "paused":
      return value;
    default:
      return malformedResponse(operation);
  }
};

const requireCheckoutStatus = (
  value: unknown,
  operation: PolarBillingOperation,
): PolarCheckout["status"] => {
  switch (value) {
    case "open":
    case "expired":
    case "confirmed":
    case "succeeded":
    case "failed":
      return value;
    default:
      return malformedResponse(operation);
  }
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

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

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
  const customerOwnerEmail =
    options.customerOwnerEmail === undefined
      ? undefined
      : requireConfigurationString(
          options.customerOwnerEmail,
          "customerOwnerEmail",
        );
  if (
    customerOwnerEmail !== undefined &&
    (customerOwnerEmail.length > 254 || !EMAIL.test(customerOwnerEmail))
  )
    configurationError("customerOwnerEmail");
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
      allowed.url.hash !== "" ||
      (allowed.url.protocol === "http:" &&
        !isLoopbackHostname(allowed.url.hostname))
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
    method: "GET" | "POST" | "PATCH",
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

    const maxAttempts =
      operation === "create_checkout" || operation === "create_customer_member"
        ? 1
        : MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImplementation(`${baseUrl}${path}`, {
          method,
          headers,
          body: serializedBody,
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
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
      if (retryableStatus && attempt < maxAttempts) {
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

  type CustomerMemberOperation =
    | "get_customer_member"
    | "create_customer_member"
    | "update_customer_member"
    | "list_customer_members";
  type ParsedCustomerMember = {
    id: string;
    email: string;
    externalId: string | null;
    role: "owner" | "billing_manager" | "member";
  };

  const parseCustomerMember = (
    value: unknown,
    operation: CustomerMemberOperation,
    customerId: string,
  ): ParsedCustomerMember => {
    const member = requireResponseObject(value, operation);
    const id = requireUuidResponse(member.id, operation);
    const responseCustomerId = requireUuidResponse(
      member.customer_id,
      operation,
    );
    const email = requireResponseString(member.email, operation);
    const externalId =
      member.external_id === null
        ? null
        : requireResponseString(member.external_id, operation);
    requireResponseDate(member.created_at, operation);
    if (member.modified_at !== null)
      requireResponseDate(member.modified_at, operation);
    if (
      member.name !== null &&
      (typeof member.name !== "string" || member.name.length > 256)
    )
      malformedResponse(operation);
    if (
      responseCustomerId !== customerId ||
      email.length > 254 ||
      email !== email.trim() ||
      !EMAIL.test(email) ||
      (externalId !== null && externalId !== externalId.trim())
    )
      malformedResponse(operation);
    const role = member.role;
    if (role !== "owner" && role !== "billing_manager" && role !== "member")
      return malformedResponse(operation);
    return { id, email, externalId, role };
  };

  const requireServiceCustomerMember = (
    member: ParsedCustomerMember,
    operation: CustomerMemberOperation,
  ): ParsedCustomerMember => {
    if (member.externalId !== CUSTOMER_OWNER_EXTERNAL_ID)
      malformedResponse(operation);
    return member;
  };

  const getServiceCustomerMember = async (
    clerkOrganizationId: string,
    customerId: string,
  ): Promise<ParsedCustomerMember> =>
    requireServiceCustomerMember(
      parseCustomerMember(
        await request(
          "get_customer_member",
          `/customers/external/${encodeURIComponent(clerkOrganizationId)}/members/${encodeURIComponent(CUSTOMER_OWNER_EXTERNAL_ID)}`,
          "GET",
          200,
        ),
        "get_customer_member",
        customerId,
      ),
      "get_customer_member",
    );

  const getCustomerMember = async (
    customerId: string,
    memberId: string,
  ): Promise<ParsedCustomerMember> => {
    const member = parseCustomerMember(
      await request(
        "get_customer_member",
        `/customers/${encodeURIComponent(customerId)}/members/${encodeURIComponent(memberId)}`,
        "GET",
        200,
      ),
      "get_customer_member",
      customerId,
    );
    if (member.id !== memberId) malformedResponse("get_customer_member");
    return member;
  };

  const memberMutationMayHaveSucceeded = (error: unknown): boolean =>
    error instanceof PolarBillingError &&
    (error.code === "conflict" ||
      error.code === "invalid_request" ||
      error.code === "network_error" ||
      error.code === "server_error" ||
      error.code === "malformed_response");

  const recoverCustomerMemberMutation = async (
    error: unknown,
    readMember: () => Promise<ParsedCustomerMember>,
  ): Promise<ParsedCustomerMember> => {
    if (!memberMutationMayHaveSucceeded(error)) throw error;
    try {
      return await readMember();
    } catch (lookupError) {
      if (
        lookupError instanceof PolarBillingError &&
        lookupError.code === "not_found"
      )
        throw error;
      throw lookupError;
    }
  };

  type CustomerMemberPagination = {
    totalCount: number;
    maxPage: number;
  };

  const listCustomerMembers = async (
    clerkOrganizationId: string,
    customerId: string,
  ): Promise<ParsedCustomerMember[]> => {
    const memberIds = new Set<string>();
    const externalIds = new Set<string>();
    const members: ParsedCustomerMember[] = [];
    let expectedPagination: CustomerMemberPagination | undefined;
    for (let page = 1; page <= MAX_CUSTOMER_MEMBER_LIST_PAGES; page += 1) {
      const parameters = new URLSearchParams({
        page: String(page),
        limit: String(CUSTOMER_MEMBER_PAGE_LIMIT),
      });
      const response = requireResponseObject(
        await request(
          "list_customer_members",
          `/customers/external/${encodeURIComponent(clerkOrganizationId)}/members?${parameters.toString()}`,
          "GET",
          200,
        ),
        "list_customer_members",
      );
      const items = response.items;
      const pagination = requireResponseObject(
        response.pagination,
        "list_customer_members",
      );
      if (!Array.isArray(items))
        return malformedResponse("list_customer_members");
      const totalCount = requireResponseInteger(
        pagination.total_count,
        "list_customer_members",
      );
      const maxPage = requireResponseInteger(
        pagination.max_page,
        "list_customer_members",
      );
      const expectedMaxPage = Math.ceil(
        totalCount / CUSTOMER_MEMBER_PAGE_LIMIT,
      );
      if (
        maxPage !== expectedMaxPage ||
        maxPage > MAX_CUSTOMER_MEMBER_LIST_PAGES ||
        (expectedPagination !== undefined &&
          (totalCount !== expectedPagination.totalCount ||
            maxPage !== expectedPagination.maxPage))
      )
        malformedResponse("list_customer_members");
      expectedPagination ??= { totalCount, maxPage };
      const expectedItemCount =
        maxPage === 0
          ? 0
          : page < maxPage
            ? CUSTOMER_MEMBER_PAGE_LIMIT
            : totalCount - (page - 1) * CUSTOMER_MEMBER_PAGE_LIMIT;
      if (page > Math.max(1, maxPage) || items.length !== expectedItemCount)
        malformedResponse("list_customer_members");

      for (const item of items) {
        const member = parseCustomerMember(
          item,
          "list_customer_members",
          customerId,
        );
        if (memberIds.has(member.id))
          malformedResponse("list_customer_members");
        memberIds.add(member.id);
        if (member.externalId !== null) {
          if (externalIds.has(member.externalId))
            malformedResponse("list_customer_members");
          externalIds.add(member.externalId);
        }
        members.push(member);
      }

      if (page >= maxPage) {
        if (members.length !== totalCount)
          malformedResponse("list_customer_members");
        return members;
      }
    }
    return malformedResponse("list_customer_members");
  };

  const demoteCustomerMember = async (
    customerId: string,
    expected: ParsedCustomerMember,
  ): Promise<void> => {
    const requireDemotedMember = (member: ParsedCustomerMember) => {
      if (
        member.id !== expected.id ||
        member.externalId !== expected.externalId ||
        member.role !== "member"
      )
        malformedResponse("update_customer_member");
      return member;
    };

    try {
      requireDemotedMember(
        parseCustomerMember(
          await request(
            "update_customer_member",
            `/customers/${encodeURIComponent(customerId)}/members/${encodeURIComponent(expected.id)}`,
            "PATCH",
            200,
            { role: "member" },
          ),
          "update_customer_member",
          customerId,
        ),
      );
    } catch (updateError) {
      requireDemotedMember(
        await recoverCustomerMemberMutation(updateError, () =>
          getCustomerMember(customerId, expected.id),
        ),
      );
    }
  };

  const requireListedServiceOwner = (
    members: readonly ParsedCustomerMember[],
    serviceMember: ParsedCustomerMember,
  ) => {
    const listedServiceMembers = members.filter(
      (member) => member.externalId === CUSTOMER_OWNER_EXTERNAL_ID,
    );
    if (
      listedServiceMembers.length !== 1 ||
      listedServiceMembers[0]?.id !== serviceMember.id ||
      listedServiceMembers[0].email !== customerOwnerEmail ||
      listedServiceMembers[0].role !== "owner"
    )
      malformedResponse("list_customer_members");
  };

  const requireStableCustomerMembers = (
    before: readonly ParsedCustomerMember[],
    after: readonly ParsedCustomerMember[],
  ) => {
    if (before.length !== after.length)
      malformedResponse("list_customer_members");
    const afterById = new Map(after.map((member) => [member.id, member]));
    for (const member of before) {
      if (afterById.get(member.id)?.externalId !== member.externalId)
        malformedResponse("list_customer_members");
    }
  };

  const ensureServiceCustomerOwner = async (
    clerkOrganizationId: string,
    customerId: string,
  ): Promise<void> => {
    if (customerOwnerEmail === undefined)
      configurationError("customerOwnerEmail");
    let member: ParsedCustomerMember;
    try {
      member = await getServiceCustomerMember(clerkOrganizationId, customerId);
    } catch (error) {
      if (!(error instanceof PolarBillingError) || error.code !== "not_found")
        throw error;
      try {
        member = requireServiceCustomerMember(
          parseCustomerMember(
            await request(
              "create_customer_member",
              `/customers/external/${encodeURIComponent(clerkOrganizationId)}/members`,
              "POST",
              201,
              {
                email: customerOwnerEmail,
                external_id: CUSTOMER_OWNER_EXTERNAL_ID,
                role: "billing_manager",
              },
            ),
            "create_customer_member",
            customerId,
          ),
          "create_customer_member",
        );
      } catch (createError) {
        member = await recoverCustomerMemberMutation(createError, () =>
          getServiceCustomerMember(clerkOrganizationId, customerId),
        );
      }
    }

    if (member.role !== "owner" || member.email !== customerOwnerEmail) {
      const update: JsonObject = { role: "owner" };
      if (member.email !== customerOwnerEmail)
        update.email = customerOwnerEmail;
      try {
        member = requireServiceCustomerMember(
          parseCustomerMember(
            await request(
              "update_customer_member",
              `/customers/external/${encodeURIComponent(clerkOrganizationId)}/members/${encodeURIComponent(CUSTOMER_OWNER_EXTERNAL_ID)}`,
              "PATCH",
              200,
              update,
            ),
            "update_customer_member",
            customerId,
          ),
          "update_customer_member",
        );
      } catch (updateError) {
        member = await recoverCustomerMemberMutation(updateError, () =>
          getServiceCustomerMember(clerkOrganizationId, customerId),
        );
      }
      if (member.role !== "owner" || member.email !== customerOwnerEmail)
        malformedResponse("update_customer_member");
    }

    const before = await listCustomerMembers(clerkOrganizationId, customerId);
    requireListedServiceOwner(before, member);
    for (const customerMember of before) {
      if (
        customerMember.id !== member.id &&
        (customerMember.role === "owner" ||
          customerMember.role === "billing_manager")
      )
        await demoteCustomerMember(customerId, customerMember);
    }

    const after = await listCustomerMembers(clerkOrganizationId, customerId);
    requireStableCustomerMembers(before, after);
    requireListedServiceOwner(after, member);
    if (
      after.filter((customerMember) => customerMember.role === "owner")
        .length !== 1 ||
      after.some(
        (customerMember) =>
          customerMember.id !== member.id &&
          (customerMember.role === "owner" ||
            customerMember.role === "billing_manager"),
      )
    )
      malformedResponse("list_customer_members");
  };

  type ParsedProCheckout = PolarCheckout & {
    checkoutClaimId: string | null;
    successUrl: string;
  };

  const parseProCheckout = (
    value: unknown,
    operation: "create_checkout" | "get_checkout" | "list_checkouts",
    clerkOrganizationId: string,
    expected: { checkoutClaimId?: string; successUrl?: string },
  ): ParsedProCheckout => {
    const response = requireResponseObject(value, operation);
    const id = requireUuidResponse(response.id, operation);
    const responseProductId = requireUuidResponse(
      response.product_id,
      operation,
    );
    const responseOrganizationId = requireUuidResponse(
      response.organization_id,
      operation,
    );
    const responseExternalId = requireResponseString(
      response.external_customer_id,
      operation,
    );
    const responseMetadata = requireResponseObject(
      response.metadata,
      operation,
    );
    requireUuidResponse(response.customer_id, operation);
    const checkoutClaimId =
      responseMetadata.humansCheckoutClaimId === undefined
        ? null
        : requireUuidResponse(
            responseMetadata.humansCheckoutClaimId,
            operation,
          );
    const responseSuccessUrl = requireWebUrl(response.success_url, () =>
      malformedResponse(operation),
    );
    if (
      responseProductId !== proProductId ||
      responseOrganizationId !== organizationId ||
      responseExternalId !== clerkOrganizationId ||
      responseMetadata.humansOrganizationId !== clerkOrganizationId ||
      (expected.successUrl !== undefined &&
        responseSuccessUrl.value !== expected.successUrl) ||
      (expected.checkoutClaimId !== undefined &&
        checkoutClaimId !== expected.checkoutClaimId)
    )
      malformedResponse(operation);
    const checkout = requireWebUrl(response.url, () =>
      malformedResponse(operation),
    );
    if (checkout.url.protocol !== "https:") malformedResponse(operation);
    return {
      id,
      checkoutClaimId,
      successUrl: responseSuccessUrl.value,
      status: requireCheckoutStatus(response.status, operation),
      url: checkout.value,
      expiresAt: requireResponseDate(response.expires_at, operation),
    };
  };

  const parseOpenProCheckout = (
    value: unknown,
    operation: "create_checkout" | "list_checkouts",
    clerkOrganizationId: string,
    expected: { checkoutClaimId?: string; successUrl: string },
  ): PolarCheckoutSession => {
    const {
      checkoutClaimId: _,
      successUrl: __,
      status,
      ...checkout
    } = parseProCheckout(value, operation, clerkOrganizationId, expected);
    if (status !== "open") malformedResponse(operation);
    return checkout;
  };

  type CheckoutPagination = {
    totalCount: number;
    maxPage: number;
  };

  const listProCheckoutPage = async (
    clerkOrganizationId: string,
    parameters: URLSearchParams,
    page: number,
    expectedPagination: CheckoutPagination | undefined,
    checkoutIds: Set<string>,
    checkoutClaimIds: Set<string>,
  ) => {
    const pageParameters = new URLSearchParams(parameters);
    pageParameters.set("page", String(page));
    const response = requireResponseObject(
      await request(
        "list_checkouts",
        `/checkouts/?${pageParameters.toString()}`,
        "GET",
        200,
      ),
      "list_checkouts",
    );
    const items = response.items;
    const pagination = requireResponseObject(
      response.pagination,
      "list_checkouts",
    );
    if (!Array.isArray(items)) return malformedResponse("list_checkouts");
    const totalCount = requireResponseInteger(
      pagination.total_count,
      "list_checkouts",
    );
    const maxPage = requireResponseInteger(
      pagination.max_page,
      "list_checkouts",
    );
    const expectedMaxPage = Math.ceil(totalCount / CHECKOUT_PAGE_LIMIT);
    if (
      maxPage !== expectedMaxPage ||
      maxPage > MAX_CHECKOUT_LIST_PAGES ||
      (expectedPagination !== undefined &&
        (totalCount !== expectedPagination.totalCount ||
          maxPage !== expectedPagination.maxPage))
    )
      malformedResponse("list_checkouts");
    const expectedItemCount =
      maxPage === 0
        ? 0
        : page < maxPage
          ? CHECKOUT_PAGE_LIMIT
          : totalCount - (page - 1) * CHECKOUT_PAGE_LIMIT;
    if (page > Math.max(1, maxPage) || items.length !== expectedItemCount)
      malformedResponse("list_checkouts");

    const checkouts: ParsedProCheckout[] = [];
    for (const item of items) {
      const checkout = parseProCheckout(
        item,
        "list_checkouts",
        clerkOrganizationId,
        {},
      );
      if (checkoutIds.has(checkout.id)) malformedResponse("list_checkouts");
      checkoutIds.add(checkout.id);
      if (checkout.checkoutClaimId !== null) {
        if (checkoutClaimIds.has(checkout.checkoutClaimId))
          malformedResponse("list_checkouts");
        checkoutClaimIds.add(checkout.checkoutClaimId);
      }
      checkouts.push(checkout);
    }
    return { checkouts, pagination: { totalCount, maxPage } };
  };

  const findOpenProCheckout = async (
    clerkOrganizationId: string,
    successUrl: string,
  ) => {
    const parameters = new URLSearchParams({
      organization_id: organizationId,
      product_id: proProductId,
      external_customer_id: clerkOrganizationId,
      status: "open",
      sorting: "-created_at",
      limit: String(CHECKOUT_PAGE_LIMIT),
    });
    const checkoutIds = new Set<string>();
    const checkoutClaimIds = new Set<string>();
    let expectedPagination: CheckoutPagination | undefined;
    let match: ParsedProCheckout | undefined;
    for (let page = 1; page <= MAX_CHECKOUT_LIST_PAGES; page += 1) {
      const result = await listProCheckoutPage(
        clerkOrganizationId,
        parameters,
        page,
        expectedPagination,
        checkoutIds,
        checkoutClaimIds,
      );
      expectedPagination ??= result.pagination;
      for (const checkout of result.checkouts) {
        if (checkout.status !== "open") malformedResponse("list_checkouts");
        if (checkout.successUrl !== successUrl) continue;
        if (match !== undefined) malformedResponse("list_checkouts");
        match = checkout;
      }
      if (page >= result.pagination.maxPage) {
        if (match === undefined) return null;
        const {
          checkoutClaimId: _,
          successUrl: __,
          status: ___,
          ...session
        } = match;
        return session;
      }
    }
    return malformedResponse("list_checkouts");
  };

  const findProCheckoutByClaim = async (
    clerkOrganizationId: string,
    checkoutClaimId: string,
    successUrl: string,
  ) => {
    const parameters = new URLSearchParams({
      organization_id: organizationId,
      product_id: proProductId,
      external_customer_id: clerkOrganizationId,
      sorting: "-created_at",
      limit: String(CHECKOUT_PAGE_LIMIT),
    });
    const checkoutIds = new Set<string>();
    const checkoutClaimIds = new Set<string>();
    let expectedPagination: CheckoutPagination | undefined;
    let match: ParsedProCheckout | undefined;
    for (let page = 1; page <= MAX_CHECKOUT_LIST_PAGES; page += 1) {
      const result = await listProCheckoutPage(
        clerkOrganizationId,
        parameters,
        page,
        expectedPagination,
        checkoutIds,
        checkoutClaimIds,
      );
      expectedPagination ??= result.pagination;
      const checkout = result.checkouts.find(
        (candidate) => candidate.checkoutClaimId === checkoutClaimId,
      );
      if (checkout !== undefined) {
        if (checkout.successUrl !== successUrl)
          malformedResponse("list_checkouts");
        match = checkout;
      }
      if (page >= result.pagination.maxPage) {
        if (match === undefined) return null;
        const {
          checkoutClaimId: _,
          successUrl: __,
          ...claimedCheckout
        } = match;
        return claimedCheckout;
      }
    }
    return malformedResponse("list_checkouts");
  };

  return {
    getCustomer,

    async ensureCustomer(input) {
      const value = assertExactInputKeys(
        input,
        ["clerkOrganizationId", "name"],
        "input",
      );
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const name = requireInputString(value.name, "name");
      if (name.length > 256) inputError("name");
      if (customerOwnerEmail === undefined)
        configurationError("customerOwnerEmail");
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
              external_id: CUSTOMER_OWNER_EXTERNAL_ID,
              email: customerOwnerEmail,
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

    async findOpenProCheckout(input) {
      const value = assertExactInputKeys(
        input,
        ["clerkOrganizationId", "successUrl"],
        "input",
      );
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const successUrl = validateRedirectUrl(value.successUrl, "successUrl");
      return findOpenProCheckout(clerkOrganizationId, successUrl);
    },

    async findProCheckoutByClaim(input) {
      const value = assertExactInputKeys(
        input,
        ["checkoutClaimId", "clerkOrganizationId", "successUrl"],
        "input",
      );
      const checkoutClaimId = requireUuidInput(
        value.checkoutClaimId,
        "checkoutClaimId",
      );
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const successUrl = validateRedirectUrl(value.successUrl, "successUrl");
      return findProCheckoutByClaim(
        clerkOrganizationId,
        checkoutClaimId,
        successUrl,
      );
    },

    async getProCheckout(input) {
      const value = assertExactInputKeys(
        input,
        ["checkoutId", "clerkOrganizationId", "successUrl"],
        "input",
      );
      const checkoutId = requireUuidInput(value.checkoutId, "checkoutId");
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const successUrl = validateRedirectUrl(value.successUrl, "successUrl");
      const {
        checkoutClaimId: _,
        successUrl: __,
        ...checkout
      } = parseProCheckout(
        await request(
          "get_checkout",
          `/checkouts/${encodeURIComponent(checkoutId)}`,
          "GET",
          200,
        ),
        "get_checkout",
        clerkOrganizationId,
        { successUrl },
      );
      if (checkout.id !== checkoutId) malformedResponse("get_checkout");
      return checkout;
    },

    async createProCheckout(input) {
      const value = assertExactInputKeys(
        input,
        ["checkoutClaimId", "clerkOrganizationId", "successUrl"],
        "input",
      );
      const checkoutClaimId = requireUuidInput(
        value.checkoutClaimId,
        "checkoutClaimId",
      );
      const clerkOrganizationId = requireClerkOrganizationId(
        value.clerkOrganizationId,
      );
      const successUrl = validateRedirectUrl(value.successUrl, "successUrl");
      try {
        const response = await request(
          "create_checkout",
          "/checkouts/",
          "POST",
          201,
          {
            products: [proProductId],
            external_customer_id: clerkOrganizationId,
            success_url: successUrl,
            allow_discount_codes: false,
            allow_trial: false,
            metadata: {
              humansCheckoutClaimId: checkoutClaimId,
              humansOrganizationId: clerkOrganizationId,
            },
          },
        );
        return parseOpenProCheckout(
          response,
          "create_checkout",
          clerkOrganizationId,
          { checkoutClaimId, successUrl },
        );
      } catch (error) {
        if (
          error instanceof PolarBillingError &&
          (error.code === "network_error" ||
            error.code === "server_error" ||
            error.code === "malformed_response")
        ) {
          try {
            const recovered = await findProCheckoutByClaim(
              clerkOrganizationId,
              checkoutClaimId,
              successUrl,
            );
            if (recovered?.status === "open") {
              const { status: _, ...checkout } = recovered;
              return checkout;
            }
          } catch {
            // Preserve the original sanitized failure while the caller's lease expires.
          }
        }
        throw error;
      }
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
      const returnUrl =
        value.returnUrl === undefined
          ? undefined
          : validateRedirectUrl(value.returnUrl, "returnUrl");
      const customer = await getCustomer(clerkOrganizationId);
      await ensureServiceCustomerOwner(clerkOrganizationId, customer.id);
      const body: JsonObject = {
        external_customer_id: clerkOrganizationId,
        external_member_id: CUSTOMER_OWNER_EXTERNAL_ID,
      };
      if (returnUrl !== undefined) body.return_url = returnUrl;
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
      const responseCustomer = parseCustomer(
        response.customer,
        "create_customer_session",
        clerkOrganizationId,
        organizationId,
      );
      if (responseCustomer.id !== customerId || customer.id !== customerId)
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
      const customer = await getCustomer(clerkOrganizationId);
      const parameters = new URLSearchParams({
        organization_id: organizationId,
        external_customer_id: clerkOrganizationId,
        product_id: proProductId,
        limit: "100",
      });
      const statuses = [
        "incomplete",
        "trialing",
        "active",
        "past_due",
        "paused",
      ] as const;
      for (const status of statuses) parameters.append("status", status);
      const response = requireResponseObject(
        await request(
          "list_subscriptions",
          `/subscriptions/?${parameters.toString()}`,
          "GET",
          200,
        ),
        "list_subscriptions",
      );
      const items = response.items;
      const pagination = requireResponseObject(
        response.pagination,
        "list_subscriptions",
      );
      if (!Array.isArray(items)) return malformedResponse("list_subscriptions");
      const totalCount = requireResponseInteger(
        pagination.total_count,
        "list_subscriptions",
      );
      const maxPage = requireResponseInteger(
        pagination.max_page,
        "list_subscriptions",
      );
      if (totalCount !== items.length || totalCount > 100 || maxPage > 1)
        malformedResponse("list_subscriptions");

      const ids = new Set<string>();
      const proSubscriptions: PolarSubscription[] = [];
      for (const item of items) {
        const subscription = requireResponseObject(item, "list_subscriptions");
        const id = requireUuidResponse(subscription.id, "list_subscriptions");
        if (ids.has(id)) malformedResponse("list_subscriptions");
        ids.add(id);
        const status = requireSubscriptionStatus(
          subscription.status,
          "list_subscriptions",
        );
        if (status === "unpaid") return malformedResponse("list_subscriptions");
        const productId = requireUuidResponse(
          subscription.product_id,
          "list_subscriptions",
        );
        const customerId = requireUuidResponse(
          subscription.customer_id,
          "list_subscriptions",
        );
        const currentPeriodStart = requireResponseDate(
          subscription.current_period_start,
          "list_subscriptions",
        );
        const currentPeriodEnd = requireResponseDate(
          subscription.current_period_end,
          "list_subscriptions",
        );
        const cancelAtPeriodEnd = subscription.cancel_at_period_end;
        if (currentPeriodStart.getTime() >= currentPeriodEnd.getTime())
          return malformedResponse("list_subscriptions");
        if (typeof cancelAtPeriodEnd !== "boolean")
          return malformedResponse("list_subscriptions");
        if (productId !== proProductId || customerId !== customer.id)
          return malformedResponse("list_subscriptions");
        proSubscriptions.push({
          id,
          status,
          currentPeriodStart,
          currentPeriodEnd,
          cancelAtPeriodEnd,
        });
      }
      if (proSubscriptions.length > 1) malformedResponse("list_subscriptions");
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
