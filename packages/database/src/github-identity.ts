import { sql } from "drizzle-orm";

import type { Transaction } from "./service/types";

const maximumGitHubAccountId = BigInt(Number.MAX_SAFE_INTEGER);

export const canonicalGitHubAccountId = (value: string) => {
  if (!/^[0-9]+$/.test(value)) return null;
  const accountId = BigInt(value);
  if (accountId <= 0n || accountId > maximumGitHubAccountId) return null;
  return accountId.toString();
};

export const lockGitHubIdentity = async (
  transaction: Transaction,
  accountId: string,
) => {
  const canonicalAccountId = canonicalGitHubAccountId(accountId);
  if (canonicalAccountId === null) throw new Error("invalid_github_account_id");
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`github:${canonicalAccountId}`}))`,
  );
  return canonicalAccountId;
};
