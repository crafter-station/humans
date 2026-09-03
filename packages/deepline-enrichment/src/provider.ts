import {
  DEEPLINE_BASE_URL,
  DEEPLINE_CAREER_TOOL_ID,
  DEEPLINE_IDENTITY_TOOL_ID,
  type DeeplineCareerResult,
  type DeeplineDate,
  type DeeplineEducation,
  type DeeplineIdentityContext,
  type DeeplineIdentityResult,
  type DeeplinePosition,
  type DeeplineProvider,
  DeeplineProviderError,
  type DeeplineProviderResult,
  type DeeplineToolId,
  DeeplineTransportError,
  InvalidDeeplineContractError,
  InvalidDeeplineInputError,
  InvalidDeeplineResultError,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const owns = (value: Record<string, unknown>, key: string) =>
  Object.hasOwn(value, key);
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

const invalidContract = (message: string): never => {
  throw new InvalidDeeplineContractError(message);
};

const invalidResult = (message: string): never => {
  throw new InvalidDeeplineResultError(message);
};

const jsonSchemaFor = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value))
    throw new InvalidDeeplineContractError(`Invalid Deepline ${label} schema`);
  const schema = isRecord(value.jsonSchema) ? value.jsonSchema : value;
  if (!isRecord(schema))
    throw new InvalidDeeplineContractError(`Invalid Deepline ${label} schema`);
  return schema;
};

const schemaTypes = (schema: Record<string, unknown>) => {
  if (typeof schema.type === "string") return [schema.type];
  if (
    Array.isArray(schema.type) &&
    schema.type.every((type) => typeof type === "string")
  )
    return schema.type;
  return [];
};

const valueType = (value: unknown) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
};

const schemaMatches = (
  value: unknown,
  schema: Record<string, unknown>,
): boolean => {
  const types = schemaTypes(schema);
  const actualType = valueType(value);
  if (
    types.length > 0 &&
    !types.includes(actualType) &&
    !(actualType === "integer" && types.includes("number"))
  )
    return false;
  if (owns(schema, "const") && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (
    typeof value === "string" &&
    typeof schema.minLength === "number" &&
    value.length < schema.minLength
  )
    return false;
  if (typeof value === "string" && schema.format === "uri") {
    try {
      new URL(value);
    } catch {
      return false;
    }
  }
  if (isRecord(value)) {
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (field) => typeof field !== "string" || !owns(value, field),
        ))
    )
      return false;
    if (schema.properties !== undefined && !isRecord(schema.properties))
      return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      const property = properties[key];
      if (property === undefined) {
        if (schema.additionalProperties === false) return false;
        continue;
      }
      if (!isRecord(property) || !schemaMatches(item, property)) return false;
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    if (!isRecord(items)) return false;
    if (value.some((item) => !schemaMatches(item, items))) return false;
  }
  if (
    schema.allOf !== undefined &&
    (!Array.isArray(schema.allOf) ||
      schema.allOf.some(
        (part) => !isRecord(part) || !schemaMatches(value, part),
      ))
  )
    return false;
  if (
    schema.anyOf !== undefined &&
    (!Array.isArray(schema.anyOf) ||
      !schema.anyOf.some(
        (part) => isRecord(part) && schemaMatches(value, part),
      ))
  )
    return false;
  return true;
};

const propertiesFor = (
  schema: Record<string, unknown>,
  label: string,
): Record<string, unknown> => {
  const properties = schema.properties;
  if (!isRecord(properties))
    throw new InvalidDeeplineContractError(
      `Invalid Deepline ${label} properties`,
    );
  return properties;
};

const propertyFor = (
  schema: Record<string, unknown>,
  field: string,
  label: string,
): Record<string, unknown> => {
  const property = propertiesFor(schema, label)[field];
  if (!isRecord(property))
    throw new InvalidDeeplineContractError(
      `Deepline ${label} is missing ${field}`,
    );
  return property;
};

const assertType = (
  schema: Record<string, unknown>,
  type: string,
  label: string,
) => {
  if (!schemaTypes(schema).includes(type))
    invalidContract(`Deepline ${label} has an incompatible type`);
};

const assertRequired = (
  schema: Record<string, unknown>,
  field: string,
  label: string,
) => {
  if (!Array.isArray(schema.required) || !schema.required.includes(field))
    invalidContract(`Deepline ${label} must require ${field}`);
};

type ToolContract = {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

const parseToolContract = (
  value: unknown,
  expectedToolId: DeeplineToolId,
): ToolContract => {
  if (
    !isRecord(value) ||
    value.toolId !== expectedToolId ||
    value.operationId !== expectedToolId
  )
    throw new InvalidDeeplineContractError(
      `Invalid Deepline contract for ${expectedToolId}`,
    );
  return {
    inputSchema: jsonSchemaFor(value.inputSchema, "input"),
    outputSchema: jsonSchemaFor(value.outputSchema, "output"),
  };
};

const assertOutputRoot = (schema: Record<string, unknown>) => {
  assertType(schema, "object", "output");
  assertRequired(schema, "data", "output");
  const data = propertyFor(schema, "data", "output");
  assertType(data, "object", "output.data");
  return data;
};

const assertIdentityContract = (contract: ToolContract) => {
  assertType(contract.inputSchema, "object", "identity input");
  assertRequired(contract.inputSchema, "full_name", "identity input");
  for (const field of ["full_name", "company_name", "company_domain", "email"])
    assertType(
      propertyFor(contract.inputSchema, field, "identity input"),
      "string",
      `identity input.${field}`,
    );
  const data = assertOutputRoot(contract.outputSchema);
  for (const field of ["linkedin_url", "github_url", "x_url"])
    assertType(
      propertyFor(data, field, "identity output.data"),
      "string",
      `identity output.data.${field}`,
    );
};

const assertCareerContract = (contract: ToolContract) => {
  assertType(contract.inputSchema, "object", "career input");
  assertType(
    propertyFor(contract.inputSchema, "url", "career input"),
    "string",
    "career input.url",
  );
  assertType(
    propertyFor(contract.inputSchema, "main", "career input"),
    "string",
    "career input.main",
  );
  const element = propertyFor(
    assertOutputRoot(contract.outputSchema),
    "element",
    "career output.data",
  );
  assertType(element, "object", "career output.data.element");
  assertType(
    propertyFor(element, "headline", "career output.data.element"),
    "string",
    "career output.data.element.headline",
  );
  for (const field of ["currentPosition", "experience", "education", "skills"])
    assertType(
      propertyFor(element, field, "career output.data.element"),
      "array",
      `career output.data.element.${field}`,
    );
};

const assertPayloadMatchesContract = (
  payload: Record<string, unknown>,
  schema: Record<string, unknown>,
  toolId: DeeplineToolId,
) => {
  if (!schemaMatches(payload, schema))
    invalidContract(`Deepline input contract changed for ${toolId}`);
};

const optionalNonEmpty = (value: unknown, field: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new InvalidDeeplineInputError(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new InvalidDeeplineInputError(`${field} must not be empty`);
  return normalized;
};

const identityPayload = (context: DeeplineIdentityContext) => {
  if (!isRecord(context))
    throw new InvalidDeeplineInputError("identity must be an object");
  const fullName = optionalNonEmpty(context.fullName, "fullName");
  if (fullName === undefined)
    throw new InvalidDeeplineInputError("fullName is required");
  const companyName = optionalNonEmpty(context.companyName, "companyName");
  const companyDomain = optionalNonEmpty(
    context.companyDomain,
    "companyDomain",
  );
  const email = optionalNonEmpty(context.email, "email");
  return {
    full_name: fullName,
    ...(companyName === undefined ? {} : { company_name: companyName }),
    ...(companyDomain === undefined ? {} : { company_domain: companyDomain }),
    ...(email === undefined ? {} : { email }),
  };
};

const linkedInUrl = (value: unknown) => {
  if (typeof value !== "string")
    throw new InvalidDeeplineInputError("linkedInUrl must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidDeeplineInputError("linkedInUrl must be a valid URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com"))
  )
    throw new InvalidDeeplineInputError(
      "linkedInUrl must be an HTTPS LinkedIn URL",
    );
  return url.toString();
};

const resultUrl = (
  value: unknown,
  field: "linkedin_url" | "github_url" | "x_url",
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new InvalidDeeplineResultError(
      `Invalid Deepline identity result field ${field}`,
    );
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const validHost =
      field === "linkedin_url"
        ? hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")
        : field === "github_url"
          ? hostname === "github.com"
          : hostname === "x.com" || hostname === "twitter.com";
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !validHost
    )
      invalidResult(`Invalid Deepline identity result field ${field}`);
    return url.toString();
  } catch {
    return invalidResult(`Invalid Deepline identity result field ${field}`);
  }
};

export const parseDeeplineIdentityResult = (
  value: unknown,
): DeeplineIdentityResult => {
  if (!isRecord(value) || !isRecord(value.data))
    throw new InvalidDeeplineResultError("Invalid Deepline identity result");
  const data = value.data;
  return {
    linkedinUrl: resultUrl(data.linkedin_url, "linkedin_url"),
    githubUrl: resultUrl(data.github_url, "github_url"),
    xUrl: resultUrl(data.x_url, "x_url"),
  };
};

const optionalString = (
  value: Record<string, unknown>,
  field: string,
  nullable = false,
): string | null | undefined => {
  const item = value[field];
  if (item === undefined || (nullable && item === null)) return item;
  if (typeof item !== "string")
    throw new InvalidDeeplineResultError(
      `Invalid Deepline career result field ${field}`,
    );
  return item;
};

const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new InvalidDeeplineResultError(
      `Invalid Deepline career result field ${field}`,
    );
  return value;
};

const date = (
  value: unknown,
  field: string,
): DeeplineDate | null | undefined => {
  if (value === undefined || value === null) return value;
  if (!isRecord(value))
    throw new InvalidDeeplineResultError(
      `Invalid Deepline career result field ${field}`,
    );
  const month = optionalString(value, "month", true);
  const text = optionalString(value, "text");
  const year = value.year;
  if (year !== undefined && year !== null && !Number.isInteger(year))
    invalidResult(`Invalid Deepline career result field ${field}.year`);
  return {
    ...(month === undefined ? {} : { month: month as string | null }),
    ...(text === undefined ? {} : { text: text as string }),
    ...(year === undefined ? {} : { year: year as number | null }),
  };
};

const positions = (value: unknown, field: string): DeeplinePosition[] => {
  if (!Array.isArray(value))
    throw new InvalidDeeplineResultError(
      `Invalid Deepline career result field ${field}`,
    );
  return value.map((item, index) => {
    if (!isRecord(item))
      throw new InvalidDeeplineResultError(
        `Invalid Deepline career result field ${field}[${index}]`,
      );
    const companyId = optionalString(item, "companyId");
    const companyName = optionalString(item, "companyName");
    const companyLinkedinUrl = optionalString(item, "companyLinkedinUrl");
    const position = optionalString(item, "position");
    const description = optionalString(item, "description", true);
    const duration = optionalString(item, "duration");
    const employmentType = optionalString(item, "employmentType", true);
    const location = optionalString(item, "location", true);
    const workplaceType = optionalString(item, "workplaceType", true);
    const startDate = date(item.startDate, `${field}[${index}].startDate`);
    const endDate = date(item.endDate, `${field}[${index}].endDate`);
    const skills =
      item.skills === undefined || item.skills === null
        ? item.skills
        : stringArray(item.skills, `${field}[${index}].skills`);
    return {
      ...(companyId === undefined ? {} : { companyId: companyId as string }),
      ...(companyName === undefined
        ? {}
        : { companyName: companyName as string }),
      ...(companyLinkedinUrl === undefined
        ? {}
        : { companyLinkedinUrl: companyLinkedinUrl as string }),
      ...(position === undefined ? {} : { position: position as string }),
      ...(description === undefined
        ? {}
        : { description: description as string | null }),
      ...(duration === undefined ? {} : { duration: duration as string }),
      ...(employmentType === undefined
        ? {}
        : { employmentType: employmentType as string | null }),
      ...(location === undefined
        ? {}
        : { location: location as string | null }),
      ...(workplaceType === undefined
        ? {}
        : { workplaceType: workplaceType as string | null }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(endDate === undefined ? {} : { endDate }),
      ...(skills === undefined ? {} : { skills }),
    };
  });
};

const education = (value: unknown): DeeplineEducation[] => {
  if (!Array.isArray(value))
    throw new InvalidDeeplineResultError(
      "Invalid Deepline career result field education",
    );
  return value.map((item, index) => {
    if (!isRecord(item))
      throw new InvalidDeeplineResultError(
        `Invalid Deepline career result field education[${index}]`,
      );
    const schoolId = optionalString(item, "schoolId", true);
    const schoolName = optionalString(item, "schoolName");
    const schoolLinkedinUrl = optionalString(item, "schoolLinkedinUrl");
    const degree = optionalString(item, "degree", true);
    const fieldOfStudy = optionalString(item, "fieldOfStudy", true);
    const period = optionalString(item, "period", true);
    const startDate = date(item.startDate, `education[${index}].startDate`);
    const endDate = date(item.endDate, `education[${index}].endDate`);
    const skills =
      item.skills === undefined
        ? undefined
        : stringArray(item.skills, `education[${index}].skills`);
    return {
      ...(schoolId === undefined
        ? {}
        : { schoolId: schoolId as string | null }),
      ...(schoolName === undefined ? {} : { schoolName: schoolName as string }),
      ...(schoolLinkedinUrl === undefined
        ? {}
        : { schoolLinkedinUrl: schoolLinkedinUrl as string }),
      ...(degree === undefined ? {} : { degree: degree as string | null }),
      ...(fieldOfStudy === undefined
        ? {}
        : { fieldOfStudy: fieldOfStudy as string | null }),
      ...(period === undefined ? {} : { period: period as string | null }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(endDate === undefined ? {} : { endDate }),
      ...(skills === undefined ? {} : { skills }),
    };
  });
};

const skills = (value: unknown): string[] => {
  if (!Array.isArray(value))
    throw new InvalidDeeplineResultError(
      "Invalid Deepline career result field skills",
    );
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.name !== "string")
      throw new InvalidDeeplineResultError(
        `Invalid Deepline career result field skills[${index}]`,
      );
    return item.name;
  });
};

export const parseDeeplineCareerResult = (
  value: unknown,
  fallbackLinkedInUrl: string,
): DeeplineCareerResult => {
  if (
    !isRecord(value) ||
    !isRecord(value.data) ||
    !isRecord(value.data.element)
  )
    throw new InvalidDeeplineResultError("Invalid Deepline career result");
  const element = value.data.element;
  if (typeof element.headline !== "string")
    throw new InvalidDeeplineResultError(
      "Invalid Deepline career result field headline",
    );
  const sourceRecordId =
    typeof element.id === "string" && element.id.length > 0
      ? element.id
      : fallbackLinkedInUrl;
  if (element.id !== undefined && typeof element.id !== "string")
    throw new InvalidDeeplineResultError(
      "Invalid Deepline career result field id",
    );
  return {
    sourceRecordId,
    headline: element.headline,
    currentPosition: positions(element.currentPosition, "currentPosition"),
    experience: positions(element.experience, "experience"),
    education: education(element.education),
    skills: skills(element.skills),
  };
};

const executionResult = (value: unknown): { result: unknown; raw: unknown } => {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !isRecord(value.toolResponse)
  )
    throw new InvalidDeeplineResultError("Invalid Deepline execution envelope");
  const response = value.toolResponse;
  if (!owns(response, "raw"))
    throw new InvalidDeeplineResultError("Invalid Deepline execution envelope");
  return {
    result: response.raw,
    raw: response.rawV2 === undefined ? response.raw : response.rawV2,
  };
};

export const parseRetryAfter = (value: string | null, now: Date) => {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const timestamp = now.getTime() + Number(trimmed) * 1_000;
    return Number.isSafeInteger(timestamp) ? new Date(timestamp) : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(Math.max(timestamp, now.getTime()));
};

export type DeeplineFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CreateDeeplineProviderOptions = {
  apiKey: string;
  fetch?: DeeplineFetch;
  baseUrl?: string;
  now?: () => Date;
};

export const createDeeplineProvider = (
  options: CreateDeeplineProviderOptions,
): DeeplineProvider => {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0)
    throw new InvalidDeeplineInputError("Deepline API key is required");
  const apiKey = options.apiKey.trim();
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl ?? DEEPLINE_BASE_URL);
  } catch {
    throw new InvalidDeeplineInputError("Deepline base URL must be valid");
  }
  if (baseUrl.protocol !== "https:")
    throw new InvalidDeeplineInputError("Deepline base URL must use HTTPS");
  if (baseUrl.username || baseUrl.password)
    throw new InvalidDeeplineInputError(
      "Deepline base URL must not contain credentials",
    );

  const request = async (
    path: string,
    init: RequestInit,
    responseKind: "contract" | "result",
  ) => {
    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        redirect: "error",
        ...init,
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...init.headers,
        },
      });
    } catch {
      throw new DeeplineTransportError();
    }
    if (!response.ok)
      throw new DeeplineProviderError(
        `Deepline request failed with status ${response.status}`,
        response.status,
        parseRetryAfter(response.headers.get("Retry-After"), now()),
      );
    try {
      return await response.json();
    } catch {
      if (responseKind === "contract")
        invalidContract("Deepline returned invalid contract JSON");
      return invalidResult("Deepline returned invalid result JSON");
    }
  };

  const discover = async (toolId: DeeplineToolId) => {
    const params = new URLSearchParams({ grep: toolId, compact: "false" });
    const catalog = await request(
      `/api/v2/tools?${params}`,
      { method: "GET" },
      "contract",
    );
    if (!isRecord(catalog) || !Array.isArray(catalog.tools))
      throw new InvalidDeeplineContractError("Invalid Deepline tool catalog");
    const tools = catalog.tools;
    const selected = tools.find(
      (tool) => isRecord(tool) && tool.toolId === toolId,
    );
    if (selected === undefined)
      invalidContract(`Approved Deepline tool ${toolId} was not discovered`);
    return parseToolContract(selected, toolId);
  };

  const describe = async (toolId: DeeplineToolId) =>
    parseToolContract(
      await request(
        `/api/v2/integrations/${encodeURIComponent(toolId)}/get`,
        { method: "GET" },
        "contract",
      ),
      toolId,
    );

  const execute = async <TValue, TToolId extends DeeplineToolId>(
    toolId: TToolId,
    payload: Record<string, unknown>,
    validateContract: (contract: ToolContract) => void,
    parseResult: (value: unknown) => TValue,
  ): Promise<DeeplineProviderResult<TValue, TToolId>> => {
    validateContract(await discover(toolId));
    const contract = await describe(toolId);
    validateContract(contract);
    assertPayloadMatchesContract(payload, contract.inputSchema, toolId);
    const execution = executionResult(
      await request(
        `/api/v2/integrations/${encodeURIComponent(toolId)}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload }),
        },
        "result",
      ),
    );
    if (!schemaMatches(execution.result, contract.outputSchema))
      throw new InvalidDeeplineResultError(
        `Deepline result did not match the described contract for ${toolId}`,
      );
    return { toolId, raw: execution.raw, value: parseResult(execution.result) };
  };

  return {
    resolveIdentity: async (context) =>
      execute(
        DEEPLINE_IDENTITY_TOOL_ID,
        identityPayload(context),
        assertIdentityContract,
        parseDeeplineIdentityResult,
      ),
    getLinkedInCareer: async (value) => {
      const url = linkedInUrl(value);
      return execute(
        DEEPLINE_CAREER_TOOL_ID,
        { url, main: "true" },
        assertCareerContract,
        (result) => parseDeeplineCareerResult(result, url),
      );
    },
  };
};
