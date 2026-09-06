"use client";

import { env } from "@/env";

const publicProductionHost = "humns.co";
const publicApiOrigin = "https://api.humns.co";

type GetToken = () => Promise<string | null>;

export const browserApiOrigin = (
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
) =>
  hostname === publicProductionHost
    ? publicApiOrigin
    : new URL(env.NEXT_PUBLIC_HUMANS_API_URL).origin;

export const fetchHumansApi = async (
  getToken: GetToken,
  path: string,
  init: RequestInit = {},
  hostname?: string,
) => {
  const token = await getToken();
  if (token === null) throw new Error("Authentication is required");

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(new URL(path, `${browserApiOrigin(hostname)}/`).href, {
    ...init,
    headers,
    cache: "no-store",
    redirect: "error",
  });
};
