import { auth } from "@clerk/nextjs/server";

const forward = async (request: Request, path: string) => {
  const session = await auth();
  const token = await session.getToken();
  if (token === null) {
    return Response.json(
      {
        error: { code: "unauthorized", message: "Authentication is required" },
      },
      { status: 401 },
    );
  }

  return fetch(
    `${process.env.HUMANS_API_URL ?? "http://localhost:8787"}${path}`,
    {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(request.method === "GET"
          ? {}
          : { "content-type": "application/json" }),
      },
      body: request.method === "GET" ? undefined : await request.text(),
    },
  );
};

export const GET = (request: Request) => forward(request, "/v1/profile");
export const PUT = (request: Request) => forward(request, "/v1/profile");
export const PATCH = (request: Request) =>
  forward(request, "/v1/profile/searchability");
