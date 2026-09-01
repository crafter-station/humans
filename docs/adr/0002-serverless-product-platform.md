# Deploy the product across Vercel and Cloudflare

Humans will run its Next.js application on Vercel and its Hono HTTP API, Scalar API documentation, and stateless Streamable HTTP MCP endpoint on Cloudflare Workers. Trigger.dev owns long-running enrichment, Neon hosts PostgreSQL with pgvector, and Drizzle uses the Neon adapter and Drizzle Kit-generated migrations rather than hand-authored migration SQL.
