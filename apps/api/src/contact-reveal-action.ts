import {
  contactRevealLogFields,
  type ContactDetailType,
} from "@humans/database/contact-reveals";

import type { ApiKeyIdentity, SessionIdentity } from "./clerk";

type Actor = {
  memberId: string;
  organizationId: string;
  keyId?: string;
};

type Reveal = {
  observationId: string;
  type: ContactDetailType;
  value: string;
  price: number;
  previouslyPurchased: boolean;
};

export type ContactRevealFailure = {
  ok: false;
  status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 422 | 429 | 503;
  error: { code: string; message: string };
};

type Dependencies<Environment> = {
  authenticateSession(
    request: Request,
    environment: Environment,
  ): Promise<SessionIdentity | null>;
  authenticateApiKey(
    request: Request,
    environment: Environment,
  ): Promise<ApiKeyIdentity | null>;
  requireWorkspace(actor: Actor): Promise<void>;
  enforcePrincipalRateLimits(
    actor: Actor,
  ): Promise<ContactRevealFailure | null>;
  recordActivity(
    actor: Actor,
    kind: "organization_access" | "reveal",
    source: "web" | "api" | "mcp",
    details?: { profileId?: string },
  ): Promise<void>;
  purchase(input: {
    memberId: string;
    organizationId: string;
    profileId: string;
    type: ContactDetailType;
    idempotencyKey: string;
    observationId?: string;
    apiKeyId?: string;
    source: "web" | "api" | "mcp";
    correlationId: string;
  }): Promise<Reveal>;
  log?: (fields: Record<string, unknown>) => void;
};

type Command<Environment> = {
  authentication:
    | { kind: "session"; request: Request }
    | { kind: "api-key"; request: Request; actor?: ApiKeyIdentity };
  environment: Environment;
  profileId: string | undefined;
  type: ContactDetailType | null;
  observation: { valid: true; observationId?: string } | { valid: false };
  idempotencyKey: string | undefined;
  source: "web" | "api" | "mcp";
  correlationId: string;
};

type ValidCommand<Environment> = Command<Environment> & {
  profileId: string;
  type: ContactDetailType;
  observation: { valid: true; observationId?: string };
  idempotencyKey: string;
};

export const createContactRevealAction = <Environment>(
  dependencies: Dependencies<Environment>,
) => ({
  async execute(
    command: Command<Environment>,
  ): Promise<{ ok: true; reveal: Reveal } | ContactRevealFailure> {
    try {
      const actor = await authenticateActor(command, dependencies);
      if ("ok" in actor) return actor;

      await dependencies.requireWorkspace(actor);
      const limited = await dependencies.enforcePrincipalRateLimits(actor);
      if (limited !== null) return limited;
      await dependencies.recordActivity(
        actor,
        "organization_access",
        command.source,
      );
      await dependencies.recordActivity(actor, "reveal", command.source, {
        ...(command.profileId === undefined
          ? {}
          : { profileId: command.profileId }),
      });
      const validated = validate(command);
      if ("ok" in validated) return validated;

      const reveal = await dependencies.purchase({
        memberId: actor.memberId,
        organizationId: actor.organizationId,
        profileId: validated.profileId,
        type: validated.type,
        idempotencyKey: validated.idempotencyKey,
        observationId: validated.observation.observationId,
        apiKeyId: actor.keyId,
        source: command.source,
        correlationId: command.correlationId,
      });
      dependencies.log?.({
        ...contactRevealLogFields({
          memberId: actor.memberId,
          organizationId: actor.organizationId,
          profileId: validated.profileId,
          observationId: reveal.observationId,
          type: validated.type,
          result: reveal.previouslyPurchased ? "reopened" : "finalized",
        }),
        ...(actor.keyId === undefined ? {} : { apiKeyId: actor.keyId }),
      });
      return { ok: true, reveal };
    } catch (error) {
      return toContactRevealFailure(error);
    }
  },
});

const authenticateActor = async <Environment>(
  command: Command<Environment>,
  dependencies: Dependencies<Environment>,
): Promise<Actor | ContactRevealFailure> => {
  if (command.authentication.kind === "session") {
    const session = await dependencies.authenticateSession(
      command.authentication.request,
      command.environment,
    );
    return session?.organizationId
      ? {
          memberId: session.memberId,
          organizationId: session.organizationId,
        }
      : failure(401, "unauthorized", "Authentication is required");
  }

  const apiKey =
    command.authentication.actor ??
    (await dependencies.authenticateApiKey(
      command.authentication.request,
      command.environment,
    ));
  if (apiKey === null)
    return failure(401, "unauthorized", "Authentication is required");
  const requiredScopes = ["profiles:read", "contacts:reveal"] as const;
  if (!requiredScopes.every((scope) => apiKey.scopes.includes(scope)))
    return failure(
      403,
      "forbidden",
      `API key requires ${requiredScopes.join(" and ")}`,
    );
  return {
    keyId: apiKey.keyId,
    memberId: apiKey.memberId,
    organizationId: apiKey.organizationId,
  };
};

export const toContactRevealFailure = (
  error: unknown,
): ContactRevealFailure => {
  if (
    tagged(error, "WorkspaceForbidden") ||
    tagged(error, "AbuseControlRejected")
  )
    return failure(403, "forbidden", "Organization access is denied");
  const reason = taggedReason(error, "ContactRevealRejected");
  if (reason === "forbidden")
    return failure(403, reason, "Contact Reveal access is denied");
  if (reason === "not_found")
    return failure(404, reason, "No valid Contact Detail was found");
  if (reason === "insufficient_credits")
    return failure(402, reason, "The Organization has insufficient Credits");
  if (reason === "credits_unavailable")
    return failure(
      403,
      reason,
      "The Organization has no active Credit entitlement",
    );
  if (reason === "idempotency_conflict")
    return failure(409, reason, "The idempotency key was already used");
  if (reason === "invalid_contact_detail")
    return failure(410, reason, "The Contact Detail is invalid");
  if (reason === "daily_limit")
    return failure(
      429,
      reason,
      "The Organization daily Contact Reveal limit was reached",
    );
  return failure(503, "service_unavailable", "Service unavailable");
};

const validate = <Environment>(
  command: Command<Environment>,
): ContactRevealFailure | ValidCommand<Environment> => {
  if (
    command.profileId &&
    command.type !== null &&
    command.idempotencyKey &&
    command.idempotencyKey.length <= 200 &&
    (command.source === "web" || command.observation.valid)
  ) {
    return {
      ...command,
      profileId: command.profileId,
      type: command.type,
      observation: command.observation.valid
        ? command.observation
        : { valid: true },
      idempotencyKey: command.idempotencyKey,
    };
  }
  return command.source === "web"
    ? failure(
        400,
        "invalid_reveal",
        "A Contact Detail type and idempotency key are required",
      )
    : failure(422, "invalid_reveal", "Request validation failed");
};

const failure = <Status extends ContactRevealFailure["status"]>(
  status: Status,
  code: string,
  message: string,
): ContactRevealFailure => ({ ok: false, status, error: { code, message } });

const tagged = (error: unknown, tag: string) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === tag;

const taggedReason = (error: unknown, tag: string) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === tag &&
  "reason" in error &&
  typeof error.reason === "string"
    ? error.reason
    : null;
