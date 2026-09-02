import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type DrizzleDatabase =
  | NeonDatabase<typeof import("../schema")>
  | NodePgDatabase<typeof import("../schema")>;

export type Transaction = Parameters<
  Parameters<DrizzleDatabase["transaction"]>[0]
>[0];

export type MemberProjection = {
  clerkId: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
};

export type OrganizationProjection = {
  clerkId: string;
  name: string;
  slug: string | null;
};

export type MembershipProjection = {
  clerkId: string;
  memberId: string;
  organizationId: string;
  role: string;
};

export type ClerkProjectionEvent = { id: string; sourceUpdatedAt: number } & (
  | { type: "member.upsert"; member: MemberProjection }
  | { type: "member.delete"; memberId: string }
  | { type: "organization.upsert"; organization: OrganizationProjection }
  | { type: "organization.delete"; organizationId: string }
  | {
      type: "membership.upsert";
      member: MemberProjection;
      membership: MembershipProjection;
      organization: OrganizationProjection;
    }
  | { type: "membership.delete"; memberId: string; organizationId: string }
);

export type Workspace = {
  memberId: string;
  organizationId: string;
  organizationName: string;
  role: string;
};

export type ProvisionedWorkspace = {
  member: MemberProjection;
  membership: MembershipProjection;
  organization: OrganizationProjection;
};

export type GitHubVerification = {
  accountId: string;
  login: string;
  accountType: "User" | "Bot" | "Organization";
  ownsNonForkRepository: boolean;
  contributedPubliclySince: Date | null;
  ownershipVerified: boolean;
  knownMinor: boolean;
};

export type ProfileInput = {
  name: string;
  currentCompany: string | null;
  professionalLinks: string[];
  statements: Record<string, string | string[]>;
  adultAttestation: boolean;
  privateCodeAttestation: boolean;
  searchable: boolean;
};

export type MemberProfile = ProfileInput & {
  memberId: string;
  githubAccountId: string;
  githubLogin: string;
  eligibilityBasis:
    | "owned_repository"
    | "public_contribution"
    | "private_attestation";
  searchabilityReason:
    | "member_opt_in"
    | "member_opt_out"
    | "operator_suppression";
  contactSuppressions: Array<
    "professional-email" | "direct-professional-phone"
  >;
};
