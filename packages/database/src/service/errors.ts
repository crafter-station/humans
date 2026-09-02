import { Schema } from "effect";

export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "DatabaseUnavailable",
  {
    cause: Schema.Defect(),
  },
) {}

export class WorkspaceForbidden extends Schema.TaggedError<WorkspaceForbidden>()(
  "WorkspaceForbidden",
  {},
) {}

export class ProfileRejected extends Schema.TaggedError<ProfileRejected>()(
  "ProfileRejected",
  { reason: Schema.String },
) {}

export class SearchRejected extends Schema.TaggedError<SearchRejected>()(
  "SearchRejected",
  {},
) {}

export class SearchChargeRejected extends Schema.TaggedError<SearchChargeRejected>()(
  "SearchChargeRejected",
  {
    reason: Schema.Literals([
      "insufficient_credits",
      "idempotency_conflict",
      "credits_unavailable",
    ]),
  },
) {}

export class ContactRevealRejected extends Schema.TaggedError<ContactRevealRejected>()(
  "ContactRevealRejected",
  { reason: Schema.String },
) {}

export class AbuseControlRejected extends Schema.TaggedError<AbuseControlRejected>()(
  "AbuseControlRejected",
  { reason: Schema.String },
) {}
