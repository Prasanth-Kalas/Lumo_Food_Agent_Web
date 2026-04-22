import { anthropic } from "@ai-sdk/anthropic";
import { streamText, convertToCoreMessages } from "ai";
import { buildSystemPrompt, inferMetroFromAddress } from "@/lib/system-prompt";
import { tools } from "@/lib/tools";
import { METROS, type Metro } from "@/lib/types";

// Next.js App Router streaming route.
// The mobile app and the web UI both hit this endpoint.

export const runtime = "nodejs";
export const maxDuration = 60;

// All US metros Lumo currently serves. Override via env if you want to limit
// the list in a particular environment (staging, a private demo, etc.).
const ALL_METROS: Metro[] = [
  "austin",
  "los_angeles",
  "san_francisco",
  "chicago",
];

function parseServiceMetros(): Metro[] {
  const env = process.env.SERVICE_METROS;
  if (!env) return ALL_METROS;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Metro => s in METROS);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages = body.messages ?? [];
    const userProfile = body.userProfile ?? {
      address: "123 Main St, Austin, TX 78701",
      dietary: "No restrictions",
    };

    const activeMetros = parseServiceMetros();
    const serviceCities = activeMetros
      .map((m) => METROS[m].label)
      .join(" · ");
    const userMetro: Metro = userProfile.metro
      ? (userProfile.metro as Metro)
      : inferMetroFromAddress(userProfile.address);

    const systemPrompt = buildSystemPrompt({
      serviceCities,
      userAddress: userProfile.address,
      userMetro,
      userDietary: userProfile.dietary,
      today: new Date().toISOString().slice(0, 10),
    });

    const result = streamText({
      model: anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
      system: systemPrompt,
      messages: convertToCoreMessages(messages),
      tools,
      maxSteps: 6,
      temperature: 0.3,
    });

    return result.toDataStreamResponse();
  } catch (err) {
    console.error("[/api/chat] error", err);
    return new Response(
      JSON.stringify({ error: "Agent failed. Please try again." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
