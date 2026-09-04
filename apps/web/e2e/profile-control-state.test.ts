import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ProfileControlContract,
  parseProfileControlState,
  readProfileControlState,
  removeProfileControlState,
  writeProfileControlState,
} from "./profile-control-state";

const contract: ProfileControlContract = {
  deploymentUrl: "https://humans-abcdefghi-crafter-station.vercel.app/",
  memberId: "user_profile_owner",
  observationId: "22222222-2222-4222-8222-222222222222",
  profileId: "11111111-1111-4111-8111-111111111111",
  release: "a".repeat(40),
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Profile control rollback state", () => {
  it("persists and validates a mode-600 rollback record", () => {
    const file = temporaryFile();
    writeProfileControlState(contract, false, file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readProfileControlState(contract, file)).toMatchObject({
      ...contract,
      environment: "production",
      originalSearchability: false,
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

  it("rejects malformed rollback records", () => {
    expect(() =>
      parseProfileControlState({
        ...contract,
        environment: "preview",
        originalSearchability: false,
        recordedAt: new Date().toISOString(),
        version: 1,
      }),
    ).toThrow("rollback state is invalid");
  });
});

const temporaryFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "humans-profile-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "profile-control.json");
};
