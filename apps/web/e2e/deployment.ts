import type { BrowserContext } from "@playwright/test";

import { establishVercelBypass } from "./vercel-bypass";

export type ReleaseEnvironment = "preview" | "production";

const immutableDeployment =
  /^humans-[a-z0-9]{9}-crafter-station\.vercel\.app$/i;
const publicProductionUrl = "https://humans.crafter.run/";
const productionAcceptanceUrl = "https://acceptance.humans.crafter.run/";

export const requiredEnvironment = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for browser acceptance`);
  return value;
};

export const environmentForProject = (projectName: string) => {
  if (projectName === "preview-chromium") return "preview" as const;
  if (projectName === "production-chromium") return "production" as const;
  throw new Error("The browser project is not an acceptance environment");
};

export const deploymentUrl = (environment: ReleaseEnvironment) => {
  const variable =
    environment === "preview"
      ? "PLAYWRIGHT_PREVIEW_URL"
      : "PLAYWRIGHT_PRODUCTION_URL";
  const value = requiredEnvironment(variable);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid URL`);
  }
  const configuredProductionAcceptanceUrl =
    process.env.HUMANS_PRODUCTION_ACCEPTANCE_URL?.trim();
  const validHost =
    environment === "preview"
      ? immutableDeployment.test(url.hostname)
      : value === publicProductionUrl ||
        (configuredProductionAcceptanceUrl === productionAcceptanceUrl &&
          value === configuredProductionAcceptanceUrl);
  if (
    url.protocol !== "https:" ||
    !validHost ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      environment === "preview"
        ? "PLAYWRIGHT_PREVIEW_URL must be an immutable Humans Vercel deployment"
        : "PLAYWRIGHT_PRODUCTION_URL must be the public Humans origin or fixed Production acceptance canary",
    );
  }
  return url;
};

export const prepareDeploymentContext = async (
  context: BrowserContext,
  environment: ReleaseEnvironment,
) => {
  const url = deploymentUrl(environment);
  const bypassed =
    environment === "preview" && immutableDeployment.test(url.hostname);
  if (bypassed) {
    await establishVercelBypass(
      context,
      url,
      requiredEnvironment("VERCEL_AUTOMATION_BYPASS_SECRET"),
    );
  }
  return { bypassed, url };
};

export const requiredHttpsUrl = (name: string) => {
  let url: URL;
  try {
    url = new URL(requiredEnvironment(name));
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${name} must be an HTTPS URL without credentials`);
  }
  return url.href;
};

export const requiredClerkId = (name: string, prefix: "org" | "user") => {
  const value = requiredEnvironment(name);
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value)) {
    throw new Error(`${name} is not a valid Clerk identifier`);
  }
  return value;
};

export const requiredUuid = (name: string) => {
  const value = requiredEnvironment(name);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${name} is not a valid UUID`);
  }
  return value;
};
