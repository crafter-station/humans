import { describe, expect, it, vi } from "vitest";

import { handleMcpRequest } from "../src/mcp";

describe("Humans MCP", () => {
  it("exposes the protected Profile tools with explicit Credit costs", async () => {
    const response = await mcpRequest("tools/list", {}, async () =>
      Response.json({}),
    );

    expect(response.status).toBe(200);
    const tools = (await response.json()).result.tools as Array<{
      name: string;
      description: string;
    }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_profiles",
      "get_profile",
      "list_search_facets",
      "reveal_profile_email",
      "reveal_profile_phone",
    ]);
    expect(
      tools.find((tool) => tool.name === "search_profiles")?.description,
    ).toContain("one Organization Credit");
    expect(
      tools.find((tool) => tool.name === "reveal_profile_email")?.description,
    ).toContain("5 Organization Credits");
    expect(
      tools.find((tool) => tool.name === "reveal_profile_phone")?.description,
    ).toContain("10 Organization Credits");
  });

  const operations: Array<{
    tool: string;
    args: Record<string, unknown>;
    path: string;
    method: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  }> = [
    {
      tool: "search_profiles",
      args: {
        query: "TypeScript builders",
        pageSize: 20,
        idempotencyKey: "mcp:search",
      },
      path: "/v1/search",
      method: "POST",
      body: { query: "TypeScript builders", pageSize: 20 },
      idempotencyKey: "mcp:search",
    },
    {
      tool: "get_profile",
      args: { profileId: "profile/a" },
      path: "/v1/profiles/profile%2Fa",
      method: "GET",
    },
    {
      tool: "list_search_facets",
      args: {},
      path: "/v1/search/facets",
      method: "GET",
    },
  ];

  it.each(operations)(
    "delegates $tool to its versioned API operation",
    async ({
      tool,
      args,
      path: expectedPath,
      method,
      body,
      idempotencyKey,
    }) => {
      const callApi = vi.fn<
        (path: string, init?: RequestInit) => Promise<Response>
      >(async () => Response.json({ operation: expectedPath }));
      const response = await mcpRequest(
        "tools/call",
        { name: tool, arguments: args },
        callApi,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: {
          isError: false,
          structuredContent: { operation: expectedPath },
        },
      });
      expect(callApi).toHaveBeenCalledOnce();
      const call = callApi.mock.calls[0];
      if (call === undefined) throw new Error("Expected an API call");
      const [path, init] = call;
      expect(path).toBe(expectedPath);
      expect(init?.method ?? "GET").toBe(method);
      if (body !== undefined) {
        expect(JSON.parse(String(init?.body))).toEqual(body);
        expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
          idempotencyKey,
        );
      }
    },
  );

  it.each([
    {
      tool: "reveal_profile_email",
      args: {
        profileId: "profile-a",
        observationId: "email-a",
        idempotencyKey: "mcp:email",
      },
      type: "professional-email",
    },
    {
      tool: "reveal_profile_phone",
      args: { profileId: "profile-a", idempotencyKey: "mcp:phone" },
      type: "direct-professional-phone",
    },
  ])(
    "delegates $tool directly to the protected action",
    async ({ tool, args, type }) => {
      const callApi = vi.fn(async () => Response.json({}));
      const revealContact = vi.fn(async () =>
        Response.json({ revealed: true }),
      );

      const response = await mcpRequest(
        "tools/call",
        { name: tool, arguments: args },
        callApi,
        revealContact,
      );

      expect(response.status).toBe(200);
      expect(callApi).not.toHaveBeenCalled();
      expect(revealContact).toHaveBeenCalledWith({
        profileId: args.profileId,
        type,
        observation: {
          valid: true,
          observationId:
            "observationId" in args ? args.observationId : undefined,
        },
        idempotencyKey: args.idempotencyKey,
      });
    },
  );

  it("preserves structured API errors for an agent to relay", async () => {
    const response = await mcpRequest(
      "tools/call",
      {
        name: "search_profiles",
        arguments: {
          filters: { skills: ["TypeScript"] },
          idempotencyKey: "mcp:limited",
        },
      },
      async () =>
        Response.json(
          {
            error: {
              code: "rate_limited",
              message: "The Organization request limit was exceeded",
            },
          },
          {
            status: 429,
            headers: { "Retry-After": "30", "RateLimit-Remaining": "0" },
          },
        ),
    );

    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: { code: "rate_limited" },
          httpStatus: 429,
          retryAfter: "30",
          rateLimit: { remaining: "0" },
        },
      },
    });
  });
});

const mcpRequest = (
  method: string,
  params: Record<string, unknown>,
  callApi: Parameters<typeof handleMcpRequest>[1]["callApi"],
  revealContact: Parameters<
    typeof handleMcpRequest
  >[1]["revealContact"] = async () => Response.json({}),
) =>
  handleMcpRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    { callApi, revealContact },
  );
