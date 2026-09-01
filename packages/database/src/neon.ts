import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import { makeDatabaseLayer } from "./service";

export const makeNeonDatabaseLayer = (databaseUrl: string) =>
  makeDatabaseLayer(drizzle(neon(databaseUrl)));
