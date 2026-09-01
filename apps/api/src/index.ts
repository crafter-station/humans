import { makeNeonDatabaseLayer } from "@humans/database/neon";

import { createApp } from "./app";

export default createApp((bindings) =>
  makeNeonDatabaseLayer(bindings.DATABASE_URL),
);
