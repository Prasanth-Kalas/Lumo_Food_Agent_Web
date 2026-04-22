import { anthropic } from "@ai-sdk/anthropic";
import { streamText, convertToCoreMessages } from "ai";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { tools } from "@/lib/tools";

// Next.js App Router streaming route.
// The mobile app and the web UI both hit this endpoint.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages = body.messages ?? [];
    const userProfile = body.userProfile ?? {
      address: "123 Main St, Austin, TX 78701",
      dietary: "No restrictions",
    };

    const systemPrompt = buildSystemPrompt({
      serviceCity: process.env.SERVICE_CITY ?? "Austin, TX",
      userAddress: userProfile.address,
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
