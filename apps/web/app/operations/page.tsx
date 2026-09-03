import { auth, currentUser } from "@clerk/nextjs/server";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { NativeSelect } from "@repo/ui/components/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table";
import { Textarea } from "@repo/ui/components/textarea";
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
  creditUsageDeadLetters: Item[];
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

const optionalText = (formData: FormData, name: string) => {
  const value = String(formData.get(name) ?? "").trim();
  return value || undefined;
};

const optionalList = (formData: FormData, name: string) => {
  const value = optionalText(formData, name);
  return value
    ?.split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
};

async function reviewClaim(formData: FormData) {
  "use server";
  await operatorRequest(`/claims/${formData.get("id")}/review`, {
    approved: formData.get("decision") === "approve",
    reason: formData.get("reason"),
    evidenceReference: formData.get("evidenceReference") || undefined,
  });
  revalidatePath("/operations");
}

async function reviewRequest(formData: FormData) {
  "use server";
  const approved = formData.get("decision") === "confirm";
  await operatorRequest(`/profile-requests/${formData.get("id")}/review`, {
    approved,
    reason: formData.get("reason"),
    correction:
      approved && formData.get("kind") === "correction"
        ? {
            name: optionalText(formData, "name"),
            currentCompany:
              formData.get("clearCurrentCompany") === "on"
                ? null
                : optionalText(formData, "currentCompany"),
            headline:
              formData.get("clearHeadline") === "on"
                ? null
                : optionalText(formData, "headline"),
            currentResidence:
              formData.get("clearCurrentResidence") === "on"
                ? null
                : optionalText(formData, "currentResidence"),
            roles:
              formData.get("clearRoles") === "on"
                ? []
                : optionalList(formData, "roles"),
            skills:
              formData.get("clearSkills") === "on"
                ? []
                : optionalList(formData, "skills"),
            seniority:
              formData.get("clearSeniority") === "on"
                ? null
                : optionalText(formData, "seniority"),
            experienceYears:
              formData.get("clearExperienceYears") === "on"
                ? null
                : optionalText(formData, "experienceYears") === undefined
                  ? undefined
                  : Number(optionalText(formData, "experienceYears")),
            opportunityStatus: optionalText(formData, "opportunityStatus"),
            professionalLinks: optionalList(formData, "professionalLinks"),
            invalidContactObservationIds: optionalList(
              formData,
              "invalidContactObservationIds",
            ),
          }
        : undefined,
  });
  revalidatePath("/operations");
}

async function verifyRequest(formData: FormData) {
  "use server";
  await operatorRequest(`/profile-requests/${formData.get("id")}/verify`, {
    reason: formData.get("reason"),
    verificationMethod: formData.get("verificationMethod"),
    evidenceReference: formData.get("evidenceReference"),
  });
  revalidatePath("/operations");
}

async function processRequest(formData: FormData) {
  "use server";
  if (formData.get("decision") === "verify") {
    await verifyRequest(formData);
    return;
  }
  await reviewRequest(formData);
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

async function redriveCreditUsage(formData: FormData) {
  "use server";
  await operatorRequest("/credit-usage/redrive", {
    ids: [formData.get("id")],
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
      <Table className={styles.dataTable}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={String(row.id ?? `${index}`)}>
              {columns.map((column) => (
                <TableCell key={column}>{value(row, column)}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
              action={processRequest}
              decisions={
                request.status === "awaiting_verification"
                  ? ["verify", "dismiss"]
                  : ["confirm", "reject"]
              }
            />
          ))}
          {overview.requests.length === 0 && (
            <p className={styles.empty}>Nothing waiting.</p>
          )}
        </Section>
      </section>

      <Section title="Suppression Records">
        <form action={suppressProfile} className={styles.actionForm}>
          <Input
            name="canonicalProviderId"
            placeholder="GitHub account ID"
            required
          />
          <Input name="reason" placeholder="Reason" required />
          <Button type="submit">Suppress Profile</Button>
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
            <NativeSelect name="kind">
              <option value="member">Member sessions</option>
              <option value="organization">Organization keys</option>
            </NativeSelect>
            <Input name="principalId" placeholder="Principal ID" required />
            <Button type="submit">Revoke access</Button>
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
            <NativeSelect name="principalType">
              <option value="member">Member</option>
              <option value="organization">Organization</option>
              <option value="api_key">API key</option>
            </NativeSelect>
            <Input name="principalId" placeholder="Principal ID" required />
            <Input name="reason" placeholder="Reason" required />
            <Button type="submit">Suspend</Button>
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
          <Input
            type="hidden"
            name="idempotencyKey"
            value={crypto.randomUUID()}
          />
          <Input name="organizationId" placeholder="Organization ID" required />
          <Input
            name="amount"
            type="number"
            placeholder="Credit adjustment"
            required
          />
          <Input name="reason" placeholder="Adjustment reason" required />
          <Button type="submit">Adjust Credits</Button>
        </form>
        {overview.reconciliations.map((item) => (
          <form
            action={retryReconciliation}
            className={styles.queueItem}
            key={String(item.id)}
          >
            <Input type="hidden" name="id" value={String(item.id)} />
            <code>
              {value(item, "organizationId")} / local{" "}
              {value(item, "localCredits")} / Polar{" "}
              {value(item, "polarCredits")}
            </code>
            <Input name="reason" placeholder="Retry reason" required />
            <Button type="submit">Queue retry</Button>
          </form>
        ))}
        {overview.reconciliations.length === 0 && (
          <p className={styles.empty}>No reconciliation differences.</p>
        )}
        {overview.creditUsageDeadLetters.map((item) => (
          <form
            action={redriveCreditUsage}
            className={styles.queueItem}
            key={String(item.id)}
          >
            <Input type="hidden" name="id" value={String(item.id)} />
            <code>
              Failed usage {value(item, "id")} / attempts{" "}
              {value(item, "attempts")} / {value(item, "lastErrorCode")}
            </code>
            <Input name="reason" placeholder="Redrive reason" required />
            <Button type="submit">Redrive usage</Button>
          </form>
        ))}
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
      <Card className={styles.metricCard}>
        <CardContent>
          <strong>{count}</strong>
          <span>{label}</span>
        </CardContent>
      </Card>
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
    <section className={styles.panelSection}>
      <Card className={styles.panel}>
        <CardHeader className={styles.panelHead}>
          <CardTitle>
            <h2>{title}</h2>
          </CardTitle>
          {note && (
            <CardDescription>
              <p>{note}</p>
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className={styles.panelContent}>{children}</CardContent>
      </Card>
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
  const formId = String(item.id);

  return (
    <form action={action} className={styles.queueItem}>
      <Input type="hidden" name="id" value={String(item.id)} />
      <Input type="hidden" name="kind" value={String(item.kind ?? "claim")} />
      <code>
        {value(item, "profileId")} / {value(item, "memberId")}
      </code>
      {item.status !== undefined && <span>{value(item, "status")}</span>}
      {item.githubAccountId !== undefined && (
        <span>Claimant GitHub ID: {value(item, "githubAccountId")}</span>
      )}
      {item.requesterEmail !== undefined && (
        <span>Requester: {value(item, "requesterEmail")}</span>
      )}
      {item.details !== undefined && <p>{value(item, "details")}</p>}
      <Input name="reason" placeholder="Decision reason" required />
      {item.kind === undefined && (
        <Input
          name="evidenceReference"
          placeholder="Evidence reference for approval"
        />
      )}
      {item.status === "awaiting_verification" && (
        <>
          <Input
            name="verificationMethod"
            placeholder="Verification method"
            required
          />
          <Input
            name="evidenceReference"
            placeholder="Verification evidence reference"
            required
          />
        </>
      )}
      {item.kind === "correction" && (
        <div className={styles.correctionFields}>
          <Input name="name" placeholder="Corrected name" />
          <Input name="currentCompany" placeholder="Corrected company" />
          <label htmlFor={`${formId}-clear-current-company`}>
            <Input
              id={`${formId}-clear-current-company`}
              name="clearCurrentCompany"
              type="checkbox"
            />{" "}
            Clear company
          </label>
          <Input name="headline" placeholder="Corrected headline" />
          <label htmlFor={`${formId}-clear-headline`}>
            <Input
              id={`${formId}-clear-headline`}
              name="clearHeadline"
              type="checkbox"
            />{" "}
            Clear headline
          </label>
          <Input name="currentResidence" placeholder="Corrected residence" />
          <label htmlFor={`${formId}-clear-current-residence`}>
            <Input
              id={`${formId}-clear-current-residence`}
              name="clearCurrentResidence"
              type="checkbox"
            />{" "}
            Clear residence
          </label>
          <Input name="roles" placeholder="Corrected roles, comma-separated" />
          <label htmlFor={`${formId}-clear-roles`}>
            <Input
              id={`${formId}-clear-roles`}
              name="clearRoles"
              type="checkbox"
            />{" "}
            Clear roles
          </label>
          <Input
            name="skills"
            placeholder="Corrected skills, comma-separated"
          />
          <label htmlFor={`${formId}-clear-skills`}>
            <Input
              id={`${formId}-clear-skills`}
              name="clearSkills"
              type="checkbox"
            />{" "}
            Clear skills
          </label>
          <Input name="seniority" placeholder="Corrected seniority" />
          <label htmlFor={`${formId}-clear-seniority`}>
            <Input
              id={`${formId}-clear-seniority`}
              name="clearSeniority"
              type="checkbox"
            />{" "}
            Clear seniority
          </label>
          <Input
            name="experienceYears"
            min="0"
            max="100"
            step="0.5"
            type="number"
            placeholder="Corrected years of experience"
          />
          <label htmlFor={`${formId}-clear-experience-years`}>
            <Input
              id={`${formId}-clear-experience-years`}
              name="clearExperienceYears"
              type="checkbox"
            />{" "}
            Clear years of experience
          </label>
          <NativeSelect name="opportunityStatus" defaultValue="">
            <option value="">Keep opportunity status</option>
            <option value="open">Open</option>
            <option value="not_open">Not open</option>
            <option value="unspecified">Unspecified</option>
          </NativeSelect>
          <Textarea
            name="professionalLinks"
            placeholder="Corrected Professional Links, one per line"
          />
          <Textarea
            name="invalidContactObservationIds"
            placeholder="Invalid Contact Detail Observation IDs, one per line"
          />
        </div>
      )}
      <div>
        {decisions.map((decision) => (
          <Button
            key={decision}
            name="decision"
            value={decision}
            type="submit"
            formNoValidate={decision === "dismiss"}
          >
            {decision}
          </Button>
        ))}
      </div>
    </form>
  );
}
