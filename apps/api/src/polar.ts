import { Webhook } from "standardwebhooks";
import { z } from "zod";

import type { Bindings } from "./app";

export type PolarSubscriptionEvent = {
  eventId: string;
  occurredAt: Date;
  organizationId: string;
  subscriptionId: string;
  active: boolean;
};

export type PolarBoundary = {
  verifySubscriptionWebhook(
    request: Request,
    bindings: Bindings,
  ): Promise<PolarSubscriptionEvent | null>;
};

const subscriptionEvent = z.object({
  type: z.string(),
  timestamp: z.iso.datetime(),
  data: z.object({
    id: z.string().min(1),
    status: z.string(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  }),
});

export const polarBoundary: PolarBoundary = {
  async verifySubscriptionWebhook(request, bindings) {
    if (!bindings.POLAR_WEBHOOK_SECRET)
      throw new Error("Polar webhook signing secret is not configured");
    const eventId = request.headers.get("webhook-id");
    if (!eventId) throw new Error("Polar webhook ID is missing");
    const verified = new Webhook(bindings.POLAR_WEBHOOK_SECRET).verify(
      await request.text(),
      Object.fromEntries(request.headers),
    );
    const event = subscriptionEvent.parse(verified);
    if (!event.type.startsWith("subscription.")) return null;
    const organizationId = event.data.metadata.humansOrganizationId;
    if (typeof organizationId !== "string" || organizationId === "")
      throw new Error("Polar subscription is not linked to an Organization");
    return {
      eventId,
      occurredAt: new Date(event.timestamp),
      organizationId,
      subscriptionId: event.data.id,
      active:
        event.data.status === "active" || event.data.status === "trialing",
    };
  },
};
