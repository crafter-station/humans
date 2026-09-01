# Separate provider enrichment stages

GitHub will provide canonical GitHub identity and repository evidence, TikHub will provide public LinkedIn career data, and Deepline will provide fallback identity resolution and missing enrichment. Each Trigger.dev stage is independently idempotent, retryable, refreshable, and rate-limited so a late failure does not repeat successful or costly provider work; AI maps evidence into taxonomy and summaries but never invents identity facts.
