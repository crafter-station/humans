import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

import { verifyDeployment } from "./verify-deployment.mjs";

const projectId = "prj_1rRwDoknIk65eWIHIScwyuuHDthI";
const apiDirectory = new URL("../../api", import.meta.url);
const verified = verifyDeployment("preview");
const origin = new URL(verified.deploymentUrl).origin;
const issuedAt = Date.now();
if (
  verified.deploymentCreatedAt > issuedAt + 5_000 ||
  issuedAt - verified.deploymentCreatedAt > 24 * 60 * 60_000
) {
  throw new Error("The Preview deployment is too old to attest");
}
const key = randomBytes(32).toString("base64url");
const payload = {
  deploymentCreatedAt: verified.deploymentCreatedAt,
  deploymentId: verified.deploymentId,
  deploymentUrl: origin,
  environment: "preview",
  expiresAt: issuedAt + 7 * 24 * 60 * 60_000,
  issuedAt,
  projectId,
  release: verified.release,
  target: null,
};
const attestation = JSON.stringify({
  ...payload,
  signature: createHmac("sha256", key)
    .update(JSON.stringify(payload))
    .digest("base64url"),
});

putSecrets({
  BILLING_APP_ORIGIN: origin,
  BILLING_APP_ORIGIN_ATTESTATION: attestation,
  BILLING_APP_ORIGIN_ATTESTATION_KEY: key,
});
console.log(
  `Configured the Preview billing origin for ${verified.deploymentId} (${verified.release})`,
);

function putSecrets(secrets) {
  const result = spawnSync(
    "bunx",
    ["wrangler", "secret", "bulk", "--env", "preview"],
    {
      cwd: apiDirectory,
      encoding: "utf8",
      env: process.env,
      input: `${JSON.stringify(secrets)}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler exited with status ${result.status}`);
  }
}
