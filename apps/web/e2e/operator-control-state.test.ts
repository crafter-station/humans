import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  beginOperatorControl,
  markOperatorControlApplied,
  type OperatorControlContract,
  parseOperatorControlState,
  readOperatorControlState,
  removeOperatorControlState,
} from "./operator-control-state";

const contract: OperatorControlContract = {
  deploymentUrl: "https://humans-abcdefghi-crafter-station.vercel.app/",
  operatorId: "user_operator",
  organizationId: "org_release",
  release: "a".repeat(40),
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Operator Credit rollback state", () => {
  it("persists rollback intent before recording the applied balance", () => {
    const file = temporaryFile();
    const pending = beginOperatorControl(contract, 99, file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(pending).toMatchObject({ originalBalance: 99, phase: "pending" });
    const applied = markOperatorControlApplied(contract, 100, file);
    expect(applied).toMatchObject({
      adjustedBalance: 100,
      originalBalance: 99,
      phase: "applied",
    });
    expect(readOperatorControlState(contract, file)).toEqual(applied);

    removeOperatorControlState(contract, file);
    expect(readOperatorControlState(contract, file)).toBeNull();
  });

  it("rejects a mismatched fixture and invalid compensation delta", () => {
    const file = temporaryFile();
    beginOperatorControl(contract, 99, file);

    expect(() =>
      readOperatorControlState(
        { ...contract, organizationId: "org_other" },
        file,
      ),
    ).toThrow("different Preview fixture");
    expect(() => markOperatorControlApplied(contract, 101, file)).toThrow(
      "Applied Operator Credit adjustment is invalid",
    );
  });

  it("rejects malformed rollback state", () => {
    expect(() =>
      parseOperatorControlState({
        ...contract,
        adjustment: 1,
        environment: "preview",
        forwardIdempotencyKey: crypto.randomUUID(),
        forwardReason: "forward",
        originalBalance: 99,
        phase: "applied",
        recordedAt: new Date().toISOString(),
        release: contract.release,
        rollbackIdempotencyKey: crypto.randomUUID(),
        rollbackReason: "rollback",
        version: 1,
      }),
    ).toThrow("rollback state is invalid");
  });
});

const temporaryFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "humans-operator-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "operator-control.json");
};
