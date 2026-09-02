import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";

import type { Bindings } from "../src/app";
import { polarBoundary } from "../src/polar";

describe("Polar webhook boundary", () => {
  const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  const bindings = { POLAR_WEBHOOK_SECRET: secret } as Bindings;

  it("derives subscription state only from a signed Polar event", async () => {
    const timestamp = new Date("2026-09-02T12:00:00Z");
    const signedAt = new Date();
    const payload = JSON.stringify({
      type: "subscription.updated",
      timestamp: timestamp.toISOString(),
      data: {
        id: "subscription_one",
        status: "active",
        metadata: { humansOrganizationId: "organization_one" },
      },
    });
    const webhook = new Webhook(secret);
    const eventId = "polar_event_one";
    const signature = webhook.sign(eventId, signedAt, payload);
    const request = new Request("http://localhost/webhooks/polar", {
      method: "POST",
      body: payload,
      headers: {
        "webhook-id": eventId,
        "webhook-signature": signature,
        "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
      },
    });

    await expect(
      polarBoundary.verifySubscriptionWebhook(request, bindings),
    ).resolves.toEqual({
      eventId,
      occurredAt: timestamp,
      organizationId: "organization_one",
      subscriptionId: "subscription_one",
      active: true,
    });
  });

  it("rejects a forged subscription event", async () => {
    await expect(
      polarBoundary.verifySubscriptionWebhook(
        new Request("http://localhost/webhooks/polar", {
          method: "POST",
          body: JSON.stringify({
            type: "subscription.updated",
            timestamp: new Date().toISOString(),
            data: {
              id: "subscription_forged",
              status: "active",
              metadata: { humansOrganizationId: "organization_victim" },
            },
          }),
          headers: {
            "webhook-id": "forged",
            "webhook-signature": "forged",
            "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
          },
        }),
        bindings,
      ),
    ).rejects.toThrow();
  });
});
