import { makeNeonDatabaseLayer } from "@humans/database/neon";

import { createApp } from "./app";

export default createApp((bindings) =>
  makeNeonDatabaseLayer(
    bindings.DATABASE_URL,
    bindings.SEARCH_CURSOR_SECRET ?? bindings.CLERK_SECRET_KEY,
  ),
);
