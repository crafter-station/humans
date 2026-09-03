import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { contactRevealPrices } from "@humans/database/contact-reveals";
import { z } from "zod";

import { interpretedFiltersSchema } from "./natural-search";

type ApiCall = (path: string, init?: RequestInit) => Promise<Response>;
type RevealContact = (input: {
  profileId: string;
  type: "professional-email" | "direct-professional-phone";
  observation: { valid: true; observationId?: string };
  idempotencyKey: string;
}) => Promise<Response>;

type McpOperations = {
  callApi: ApiCall;
  revealContact: RevealContact;
};

const profileId = z.string().min(1).describe("The Profile identifier");
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .describe("A unique key for safely retrying this chargeable operation");

const searchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(4)
      .max(500)
      .optional()
      .describe("Natural-language Profile search criteria"),
    filters: interpretedFiltersSchema
      .optional()
      .describe("Structured Profile search filters"),
    cursor: z.string().min(1).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    idempotencyKey,
  })
  .strict()
  .refine(
    (input) => (input.query === undefined) !== (input.filters === undefined),
    {
      message: "Provide exactly one of query or filters",
    },
  );

export const handleMcpRequest = async (
  request: Request,
  operations: McpOperations,
) => {
  const server = createMcpServer(operations);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
};

const createMcpServer = ({ callApi, revealContact }: McpOperations) => {
  const server = new McpServer({ name: "Humans", version: "1.0.0" });

  server.registerTool(
    "search_profiles",
    {
      title: "Search Profiles",
      description:
        "Search protected Humans Profiles with natural-language criteria or structured filters. Each successful page costs one Organization Credit. Pages contain at most 100 Profiles and cursors cannot traverse beyond 1,000 results.",
      inputSchema: searchInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ idempotencyKey: key, ...input }) =>
      apiResult(
        await callApi("/v1/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get Profile",
      description:
        "Read one protected Humans Profile by identifier. Requires profiles:read and costs zero Credits.",
      inputSchema: { profileId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ profileId: id }) =>
      apiResult(await callApi(`/v1/profiles/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "list_search_facets",
    {
      title: "List Search Facets",
      description:
        "List available protected Profile search facets. Requires profiles:read and costs zero Credits.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => apiResult(await callApi("/v1/search/facets")),
  );

  const registerReveal = (
    name: "reveal_profile_email" | "reveal_profile_phone",
    contact: "email" | "phone",
    cost: 5 | 10,
  ) =>
    server.registerTool(
      name,
      {
        title:
          contact === "email" ? "Reveal Profile Email" : "Reveal Profile Phone",
        description: `Intentionally purchase and reveal a provider-verified professional ${contact}. Requires profiles:read and contacts:reveal. A new purchase costs ${cost} Organization Credits; a previously purchased valid Contact Reveal costs zero Credits. Suppressed or invalid Contact Details are not returned.`,
        inputSchema: {
          profileId,
          observationId: z
            .string()
            .min(1)
            .optional()
            .describe("A specific Contact Detail Observation to reveal"),
          idempotencyKey,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async ({ profileId: id, observationId, idempotencyKey: key }) =>
        apiResult(
          await revealContact({
            profileId: id,
            type:
              contact === "email"
                ? "professional-email"
                : "direct-professional-phone",
            observation: { valid: true, observationId },
            idempotencyKey: key,
          }),
        ),
    );

  registerReveal(
    "reveal_profile_email",
    "email",
    contactRevealPrices["professional-email"],
  );
  registerReveal(
    "reveal_profile_phone",
    "phone",
    contactRevealPrices["direct-professional-phone"],
  );
  return server;
};

const apiResult = async (response: Response): Promise<CallToolResult> => {
  const body = (await response.json()) as Record<string, unknown>;
  const rateLimit = {
    limit: response.headers.get("RateLimit-Limit"),
    remaining: response.headers.get("RateLimit-Remaining"),
    reset: response.headers.get("RateLimit-Reset"),
  };
  const result = response.ok
    ? rateLimit.limit === null
      ? body
      : { ...body, rateLimit }
    : {
        ...body,
        httpStatus: response.status,
        retryAfter: response.headers.get("Retry-After"),
        rateLimit,
      };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: !response.ok,
  };
};
