// lib/llm-client.ts
// Shared "call whichever LLM provider is configured" primitive.
//
// Before this file existed, lib/allocation-engine.ts and lib/llm-bootstrap.ts
// each had their own separate provider-switching fetch logic (same three
// providers, same env vars, independently implemented). A third copy was about
// to be added for chat intent classification (lib/intent-classifier.ts) — this
// file exists so that doesn't happen; all three now share one implementation.
//
// Provider names are canonicalized to lowercase ("claude" | "openai" | "grok").
// This is a real behavior change for lib/llm-bootstrap.ts: it previously
// compared process.env.LLM_PROVIDER with strict === against "CLAUDE" (uppercase),
// while this repo's real .env has LLM_PROVIDER="claude" (lowercase) — every
// branch was false, so bootstrapAnswer()'s LLM fallback silently never fired,
// always returning its canned failure string. Canonicalizing here fixes that,
// since lib/allocation-engine.ts's already-working lowercase comparison proves
// lowercase is the correct convention to standardize on.

export type LLMProviderName = "claude" | "openai" | "grok";

const VALID_PROVIDERS: LLMProviderName[] = ["claude", "openai", "grok"];

/** Normalizes any case/whitespace variant to a valid provider name, defaulting to "claude". */
export function resolveProvider(explicit?: string | null): LLMProviderName {
  const candidate = (explicit || process.env.LLM_PROVIDER || "claude").trim().toLowerCase();
  return (VALID_PROVIDERS as string[]).includes(candidate) ? (candidate as LLMProviderName) : "claude";
}

interface ProviderConfig {
  url: string;
  model: string;
  formatRequest: (prompt: string, apiKey: string, systemPrompt?: string, maxTokens?: number) => RequestInit;
  parseResponse: (data: Record<string, unknown>) => string;
}

const PROVIDERS: Record<LLMProviderName, ProviderConfig> = {
  claude: {
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-3-haiku-20240307",
    formatRequest: (prompt, apiKey, systemPrompt, maxTokens = 500) => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: maxTokens,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    }),
    parseResponse: (data) => {
      const content = data.content as Array<{ text: string }>;
      return content?.[0]?.text || "";
    },
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    formatRequest: (prompt, apiKey, systemPrompt, maxTokens = 500) => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: prompt },
        ],
        max_tokens: maxTokens,
      }),
    }),
    parseResponse: (data) => {
      const choices = data.choices as Array<{ message: { content: string } }>;
      return choices?.[0]?.message?.content || "";
    },
  },
  grok: {
    url: "https://api.x.ai/v1/chat/completions",
    model: "grok-beta",
    formatRequest: (prompt, apiKey, systemPrompt, maxTokens = 500) => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-beta",
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: prompt },
        ],
        max_tokens: maxTokens,
      }),
    }),
    parseResponse: (data) => {
      const choices = data.choices as Array<{ message: { content: string } }>;
      return choices?.[0]?.message?.content || "";
    },
  },
};

/**
 * Sends `prompt` to whichever LLM provider is configured and returns the raw
 * text response. No response parsing/business logic here — callers regex/JSON
 * parse the returned text themselves (structured-JSON callers vs free-text
 * callers want different things from the same raw response).
 *
 * Throws on missing API key, unreachable provider, or non-2xx response —
 * matches lib/llm-bootstrap.ts's original callExternalLLM() contract; callers
 * are expected to try/catch (both existing callers already do).
 */
export async function callLLM(
  prompt: string,
  opts: { provider?: string; apiKey?: string; systemPrompt?: string; maxTokens?: number } = {}
): Promise<string> {
  const provider = resolveProvider(opts.provider);
  const apiKey = opts.apiKey || process.env.LLM_API_KEY;

  if (!apiKey) {
    throw new Error("LLM_API_KEY is not configured");
  }

  const config = PROVIDERS[provider];
  const requestInit = config.formatRequest(prompt, apiKey, opts.systemPrompt, opts.maxTokens);

  const response = await fetch(config.url, requestInit);
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`${provider} API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return config.parseResponse(data);
}
