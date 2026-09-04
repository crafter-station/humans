import { API_TARGETS, TRIGGER_TARGETS } from "./release-manifest.mjs";

export const assertProductionDeployConfirmation = ({
  confirmation,
  environment,
  release,
  service,
  target,
}) => {
  if (!/^[0-9a-f]{40}$/.test(release)) {
    throw new Error("The deployment release must be a full Git commit SHA");
  }
  const expectedTarget =
    service === "api"
      ? API_TARGETS[environment]
      : service === "trigger"
        ? TRIGGER_TARGETS[environment]
        : undefined;
  if (!expectedTarget || target !== expectedTarget) {
    throw new Error(
      "The deployment service, target, and environment do not match",
    );
  }
  if (environment !== "production") return;
  const expected = `production:${service}:${target}:${release}`;
  if (confirmation !== expected) {
    throw new Error(
      `Set HUMANS_PRODUCTION_DEPLOY_CONFIRMATION=${expected} to deploy Production`,
    );
  }
};
