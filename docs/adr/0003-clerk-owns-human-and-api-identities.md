# Use Clerk for Members, Organizations, and API keys

Clerk will own Member authentication, Organization membership, and Organization-scoped API keys. Browser sessions authenticate the application, while scoped and revocable Clerk API keys authenticate read-only HTTP API and MCP clients; internal service communication remains a separate machine-authentication concern.
