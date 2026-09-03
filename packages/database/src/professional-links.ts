import { canonicalGitHubAccountId } from "./github-identity";

export type CanonicalIdentityVerification = {
  github?: {
    accountId: string;
    login: string;
    accountType: "User" | "Bot" | "Organization";
    ownershipVerified: boolean;
    knownMinor: boolean;
  };
  linkedIn?: { username: string; providerUserId: string };
};

export type ProfessionalLinkIdentity =
  | { kind: "github"; login: string }
  | { kind: "linkedin"; username: string }
  | { kind: "x" };

export const isProfessionalLink = (value: string) => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      hostname.includes(".") &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".local") &&
      !hostname.endsWith(".internal") &&
      !hostname.endsWith(".home.arpa") &&
      !/^\d+(?:\.\d+){3}$/.test(hostname) &&
      !(hostname.startsWith("[") && hostname.endsWith("]"))
    );
  } catch {
    return false;
  }
};

export const professionalLinkIdentity = (
  value: string,
): ProfessionalLinkIdentity | undefined => {
  if (!isProfessionalLink(value)) return undefined;
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  const [firstSegment, secondSegment] = segments;
  if (
    (hostname === "github.com" || hostname === "www.github.com") &&
    segments.length === 1 &&
    firstSegment !== undefined &&
    /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(firstSegment)
  ) {
    return { kind: "github", login: firstSegment.toLowerCase() };
  }
  if (
    (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) &&
    segments.length === 2 &&
    firstSegment?.toLowerCase() === "in" &&
    secondSegment !== undefined &&
    /^[a-z\d-]{1,100}$/i.test(secondSegment)
  ) {
    return { kind: "linkedin", username: secondSegment.toLowerCase() };
  }
  if (
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com")
  ) {
    return { kind: "x" };
  }
  return undefined;
};

export const verifiedProfessionalLink = (
  url: string,
  verification: CanonicalIdentityVerification | undefined,
  verifiedAt: Date,
) => {
  const identity = professionalLinkIdentity(url);
  if (
    identity?.kind === "github" &&
    verification?.github?.accountType === "User" &&
    verification.github.ownershipVerified &&
    !verification.github.knownMinor &&
    identity.login === verification.github.login.toLowerCase()
  ) {
    const providerUserId = canonicalGitHubAccountId(
      verification.github.accountId,
    );
    if (providerUserId !== null)
      return {
        verifiedProvider: "github",
        verifiedProviderUserId: providerUserId,
        verifiedAt,
      };
  }
  if (
    identity?.kind === "linkedin" &&
    verification?.linkedIn !== undefined &&
    identity.username === verification.linkedIn.username.toLowerCase() &&
    verification.linkedIn.providerUserId?.trim()
  ) {
    return {
      verifiedProvider: "linkedin",
      verifiedProviderUserId: verification.linkedIn.providerUserId.trim(),
      verifiedAt,
    };
  }
  return undefined;
};
