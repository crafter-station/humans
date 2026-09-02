import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { env } from "@/env";
import styles from "./operations.module.css";

type Item = Record<string, unknown>;
type Overview = {
  imports: Item[];
  enrichment: {
    runs: Item[];
    staleObservations: Item[];
    providerUsage: Item[];
  };
  claims: Item[];
  requests: Item[];
  suppressions: Item[];
  abuse: { signals: Item[]; suspensions: Item[] };
  reconciliations: Item[];
  auditTrail: Item[];
};

const requireOperator = async () => {
  const user = await currentUser();
  if (user?.publicMetadata.humansRole !== "operator") notFound();
  return user.id;
};

const operatorRequest = async (path: string, body?: unknown) => {
  await requireOperator();
  const token = await (await auth()).getToken();
  if (!token) notFound();
  const response = await fetch(`${env.HUMANS_API_URL}/v1/operator${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "X-Correlation-ID": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(`Operator API request failed (${response.status})`);
  return response.json();
};

async function reviewClaim(formData: FormData) {
  "use server";
  await operatorRequest(`/claims/${formData.get("id")}/review`, {
    approved: formData.get("decision") === "approve",
    reason: formData.get("reason"),
  });
  revalidatePath("/operations");
}

async function reviewRequest(formData: FormData) {
  "use server";
  await operatorRequest(`/profile-requests/${formData.get("id")}/review`, {
    approved: formData.get("decision") === "confirm",
    reason: formData.get("reason"),
    correction:
      formData.get("kind") === "correction"
        ? Object.fromEntries(
            ["name", "currentCompany", "githubAccountId", "githubLogin"]
              .map((key) => [key, formData.get(key)])
              .filter(([, fieldValue]) => fieldValue !== ""),
          )
        : undefined,
  });
  revalidatePath("/operations");
}

async function suppressProfile(formData: FormData) {
  "use server";
  await operatorRequest("/suppressions", {
    canonicalProviderId: formData.get("canonicalProviderId"),
    reason: formData.get("reason"),
  });
  revalidatePath("/operations");
}

async function retryReconciliation(formData: FormData) {
  "use server";
  await operatorRequest(`/reconciliations/${formData.get("id")}/retry`, {
    reason: formData.get("reason"),
  });
  revalidatePath("/operations");
}

async function adjustCredits(formData: FormData) {
  "use server";
  await operatorRequest("/credit-adjustments", {
    organizationId: formData.get("organizationId"),
    amount: Number(formData.get("amount")),
    idempotencyKey: formData.get("idempotencyKey"),
    reason: formData.get("reason"),
  });
  revalidatePath("/operations");
}

async function suspendPrincipal(formData: FormData) {
  "use server";
  await operatorRequest("/suspensions", {
    principalType: formData.get("principalType"),
    principalId: formData.get("principalId"),
    reason: formData.get("reason"),
  });
  revalidatePath("/operations");
}

async function revokeAccess(formData: FormData) {
  "use server";
  const kind = formData.get("kind");
  const id = formData.get("principalId");
  const path =
    kind === "member"
      ? `/members/${id}/revoke-sessions`
      : `/organizations/${id}/revoke-keys`;
  await operatorRequest(path, {});
  revalidatePath("/operations");
}

const value = (item: Item, key: string) => {
  const result = item[key];
  if (result === null || result === undefined) return "-";
  return typeof result === "object" ? JSON.stringify(result) : String(result);
};

function DataTable({ rows, columns }: { rows: Item[]; columns: string[] }) {
  if (rows.length === 0)
    return <p className={styles.empty}>Nothing waiting.</p>;
  return (
    <div className={styles.tableWrap}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? `${index}`)}>
              {columns.map((column) => (
                <td key={column}>{value(row, column)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function OperationsPage() {
  await requireOperator();
  const overview = (await operatorRequest("/overview")) as Overview;
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>SYSTEM OPERATIONS</p>
          <h1>Directory control room</h1>
        </div>
        <p>
          Inspect queues, resolve reviewed changes, and trace every
          intervention.
        </p>
      </header>

      <section className={styles.metrics}>
        <Metric label="Pending claims" count={overview.claims.length} />
        <Metric label="Profile requests" count={overview.requests.length} />
        <Metric
          label="Active suspensions"
          count={overview.abuse.suspensions.length}
        />
        <Metric
          label="Stale Observations"
          count={overview.enrichment.staleObservations.length}
        />
      </section>

      <Section
        title="Import runs"
        note="Row failures and resumability are retained by run ID."
      >
        <DataTable
          rows={overview.imports}
          columns={[
            "id",
            "status",
            "validRows",
            "invalidRows",
            "startedAt",
            "finishedAt",
            "duplicateCandidates",
            "rowFailures",
          ]}
        />
      </Section>
      <Section
        title="Enrichment"
        note="Provider usage excludes provider payloads."
      >
        <DataTable
          rows={overview.enrichment.providerUsage}
          columns={["provider", "runs", "attempts", "durationMs"]}
        />
        <DataTable
          rows={overview.enrichment.runs}
          columns={[
            "id",
            "profileId",
            "provider",
            "stage",
            "status",
            "retryClassification",
            "terminalClassification",
            "attempts",
            "pipelineVersion",
          ]}
        />
      </Section>

      <section className={styles.split}>
        <Section title="Reviewed claims">
          {overview.claims.map((claim) => (
            <DecisionForm
              key={String(claim.id)}
              item={claim}
              action={reviewClaim}
              decisions={["approve", "reject"]}
            />
          ))}
          {overview.claims.length === 0 && (
            <p className={styles.empty}>Nothing waiting.</p>
          )}
        </Section>
        <Section title="Correction and removal">
          {overview.requests.map((request) => (
            <DecisionForm
              key={String(request.id)}
              item={request}
              action={reviewRequest}
              decisions={["confirm", "reject"]}
            />
          ))}
          {overview.requests.length === 0 && (
            <p className={styles.empty}>Nothing waiting.</p>
          )}
        </Section>
      </section>

      <Section title="Suppression Records">
        <form action={suppressProfile} className={styles.actionForm}>
          <input
            name="canonicalProviderId"
            placeholder="GitHub account ID"
            required
          />
          <input name="reason" placeholder="Reason" required />
          <button type="submit">Suppress Profile</button>
        </form>
        <DataTable
          rows={overview.suppressions}
          columns={[
            "canonicalProvider",
            "canonicalProviderId",
            "reason",
            "createdAt",
          ]}
        />
      </Section>

      <section className={styles.split}>
        <Section title="Abuse signals">
          <form action={revokeAccess} className={styles.actionForm}>
            <select name="kind">
              <option value="member">Member sessions</option>
              <option value="organization">Organization keys</option>
            </select>
            <input name="principalId" placeholder="Principal ID" required />
            <button type="submit">Revoke access</button>
          </form>
          <DataTable
            rows={overview.abuse.signals}
            columns={[
              "memberId",
              "organizationId",
              "apiKeyId",
              "kind",
              "profileId",
              "createdAt",
            ]}
          />
        </Section>
        <Section title="Active suspensions">
          <form action={suspendPrincipal} className={styles.actionForm}>
            <select name="principalType">
              <option value="member">Member</option>
              <option value="organization">Organization</option>
              <option value="api_key">API key</option>
            </select>
            <input name="principalId" placeholder="Principal ID" required />
            <input name="reason" placeholder="Reason" required />
            <button type="submit">Suspend</button>
          </form>
          <DataTable
            rows={overview.abuse.suspensions}
            columns={[
              "id",
              "principalType",
              "principalId",
              "reason",
              "automatic",
              "createdAt",
            ]}
          />
        </Section>
      </section>

      <Section title="Credit reconciliation">
        <form action={adjustCredits} className={styles.actionForm}>
          <input
            type="hidden"
            name="idempotencyKey"
            value={crypto.randomUUID()}
          />
          <input name="organizationId" placeholder="Organization ID" required />
          <input
            name="amount"
            type="number"
            placeholder="Credit adjustment"
            required
          />
          <input name="reason" placeholder="Adjustment reason" required />
          <button type="submit">Adjust Credits</button>
        </form>
        {overview.reconciliations.map((item) => (
          <form
            action={retryReconciliation}
            className={styles.queueItem}
            key={String(item.id)}
          >
            <input type="hidden" name="id" value={String(item.id)} />
            <code>
              {value(item, "organizationId")} / local{" "}
              {value(item, "localCredits")} / Polar{" "}
              {value(item, "polarCredits")}
            </code>
            <input name="reason" placeholder="Retry reason" required />
            <button type="submit">Queue retry</button>
          </form>
        ))}
        {overview.reconciliations.length === 0 && (
          <p className={styles.empty}>No reconciliation differences.</p>
        )}
      </Section>
      <Section title="Operator audit trail">
        <DataTable
          rows={overview.auditTrail}
          columns={[
            "createdAt",
            "operatorId",
            "action",
            "subjectType",
            "subjectId",
            "reason",
            "correlationId",
          ]}
        />
      </Section>
    </main>
  );
}

function Metric({ label, count }: { label: string; count: number }) {
  return (
    <article>
      <strong>{count}</strong>
      <span>{label}</span>
    </article>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </div>
      {children}
    </section>
  );
}

function DecisionForm({
  item,
  action,
  decisions,
}: {
  item: Item;
  action: (data: FormData) => Promise<void>;
  decisions: string[];
}) {
  return (
    <form action={action} className={styles.queueItem}>
      <input type="hidden" name="id" value={String(item.id)} />
      <input type="hidden" name="kind" value={String(item.kind ?? "claim")} />
      <code>
        {value(item, "profileId")} / {value(item, "memberId")}
      </code>
      <input name="reason" placeholder="Decision reason" required />
      {item.kind === "correction" && (
        <div className={styles.correctionFields}>
          <input name="name" placeholder="Corrected name" />
          <input name="currentCompany" placeholder="Corrected company" />
          <input name="githubAccountId" placeholder="Corrected GitHub ID" />
          <input name="githubLogin" placeholder="Corrected GitHub login" />
        </div>
      )}
      <div>
        {decisions.map((decision) => (
          <button key={decision} name="decision" value={decision} type="submit">
            {decision}
          </button>
        ))}
      </div>
    </form>
  );
}
