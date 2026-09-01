import { sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

type DrizzleDatabase = {
  execute(query: SQL): PromiseLike<unknown>;
};

export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "DatabaseUnavailable",
  {
    cause: Schema.Defect(),
  },
) {}

export class Database extends Context.Service<
  Database,
  {
    readonly check: Effect.Effect<void, DatabaseUnavailable>;
  }
>()("@humans/database/Database") {}

export const makeDatabaseLayer = (database: DrizzleDatabase) => {
  const check = Effect.tryPromise({
    try: async () => {
      await database.execute(sql`select null::vector`);
    },
    catch: (cause) => new DatabaseUnavailable({ cause }),
  }).pipe(Effect.withSpan("Database.check"));

  return Layer.succeed(Database, Database.of({ check }));
};
