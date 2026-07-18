import { createServerFn } from "@tanstack/react-start";

// Calls Lovable AI Gateway (OpenAI-compatible) with the exact prompt shape
// used by the original askClaude() helper: a single user message plus a system
// prompt, returning the assistant text.
export const askAI = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { prompt?: unknown; system?: unknown };
    if (typeof v?.prompt !== "string") throw new Error("prompt required");
    return {
      prompt: v.prompt,
      system: typeof v.system === "string" ? v.system : "",
    };
  })
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          ...(data.system ? [{ role: "system", content: data.system }] : []),
          { role: "user", content: data.prompt },
        ],
      }),
    });

    if (res.status === 429) throw new Error("Rate limit — try again in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted.");
    if (!res.ok) throw new Error(`AI gateway error ${res.status}`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (json.choices?.[0]?.message?.content ?? "").trim();
  });