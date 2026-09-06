import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ProfileControlContract,
  parseProfileControlClaimReceipt,
  parseProfileControlState,
  profileIdentityFingerprint,
  readProfileControlClaimReceipt,
  readProfileControlState,
  removeProfileControlState,
  writeProfileControlClaimReceipt,
  writeProfileControlState,
} from "./profile-control-state";

const contract: ProfileControlContract = {
  deploymentUrl: "https://acceptance.humns.co/",
  memberId: "user_profile_owner",
  observationId: "22222222-2222-4222-8222-222222222222",
  organizationId: "org_profile_owner",
  profileId: "11111111-1111-4111-8111-111111111111",
  release: "a".repeat(40),
  runPhase: "staged-claim",
  searcherMemberId: "user_profile_searcher",
  searcherOrganizationId: "org_profile_searcher",
};
const identity = profileIdentityFingerprint(contract.profileId, "12345678");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Profile control state", () => {
  it("persists and validates a mode-600 rollback record", () => {
    const file = temporaryFile();
    writeProfileControlState(contract, false, identity, file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readProfileControlState(contract, file)).toMatchObject({
      ...contract,
      environment: "production",
      originalSearchability: false,
      profileIdentityFingerprint: identity,
    });
    expect(() =>
      readProfileControlState(
        { ...contract, observationId: "33333333-3333-4333-8333-333333333333" },
        file,
      ),
    ).toThrow("different Production fixture");

    removeProfileControlState(file);
    expect(readProfileControlState(contract, file)).toBeNull();
  });

  it("persists a mode-600 staged claim receipt for post-promotion checks", () => {
    const file = temporaryFile();
    writeProfileControlClaimReceipt(contract, identity, file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(
      readProfileControlClaimReceipt(
        {
          ...contract,
          deploymentUrl: "https://humns.co/",
          runPhase: "post-promotion",
        },
        file,
      ),
    ).toMatchObject({
      memberId: contract.memberId,
      profileId: contract.profileId,
      profileIdentityFingerprint: identity,
      sourceDeploymentUrl: contract.deploymentUrl,
    });
  });

  it("rejects malformed rollback records", () => {
    expect(() =>
      parseProfileControlState({
        ...contract,
        environment: "preview",
        originalSearchability: false,
        profileIdentityFingerprint: identity,
        recordedAt: new Date().toISOString(),
        version: 2,
      }),
    ).toThrow("rollback state is invalid");
  });

  it("rejects a claim receipt recorded from the public alias", () => {
    expect(() =>
      parseProfileControlClaimReceipt({
        environment: "production",
        memberId: contract.memberId,
        observationId: contract.observationId,
        organizationId: contract.organizationId,
        profileId: contract.profileId,
        profileIdentityFingerprint: identity,
        recordedAt: new Date().toISOString(),
        release: contract.release,
        sourceDeploymentUrl: "https://humns.co/",
        version: 1,
      }),
    ).toThrow("claim receipt is invalid");
  });
});

const temporaryFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "humans-profile-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "profile-control.json");
};
