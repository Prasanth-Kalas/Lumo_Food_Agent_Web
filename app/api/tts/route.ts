/**
 * Streaming TTS endpoint — OpenAI gpt-4o-mini-tts.
 *
 * The client POSTs { text, voice?, instructions? } and we stream back an
 * audio/mpeg response it can pipe into MediaSource (web) or expo-av (mobile).
 * Streaming matters: time-to-first-audio is what makes the agent feel alive
 * vs. a voicemail.
 *
 * Voice: "sage" by default — warm, conversational American English. The
 * `instructions` field lets us steer prosody per-utterance without retraining.
 *
 * Text sanitization happens server-side so every client gets the same clean
 * input without re-implementing the regex soup.
 */

import { sanitizeForTTS } from "@/lib/tts-sanitize";

export const runtime = "nodejs";
export const maxDuration = 30;

// Default voice personality — see system prompt & brand voice guidelines.
// Locked to "friendly local American" per product decision. Override per-call
// by passing `voice` (one of: alloy, ash, ballad, coral, echo, fable, nova,
// onyx, sage, shimmer) or `instructions`.
const DEFAULT_VOICE = "sage";
const DEFAULT_INSTRUCTIONS =
  "Speak warmly and casually, like a competent friend helping someone order food. " +
  "Use contractions. Keep pacing quick but relaxed. Slight smile in the voice. " +
  "Avoid robotic pauses between sentences. American English.";

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const rawText: string = body.text ?? "";
    const voice: string = body.voice ?? DEFAULT_VOICE;
    const instructions: string = body.instructions ?? DEFAULT_INSTRUCTIONS;

    const cleaned = sanitizeForTTS(rawText);
    if (!cleaned) {
      return new Response(JSON.stringify({ error: "text required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Hard cap to keep costs and latency bounded. gpt-4o-mini-tts pricing is
    // ~$0.015 per 1k input chars — 4000 chars ≈ $0.06 per call, worst case.
    const input = cleaned.slice(0, 4000);

    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input,
        instructions,
        response_format: "mp3",
        // stream_format: "audio" gives us plain MP3 frames we can pipe
        // directly into a media element. "sse" would give JSON events which
        // we don't need here.
        stream_format: "audio",
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      console.error("[/api/tts] upstream error", upstream.status, errText);
      return new Response(
        JSON.stringify({
          error: "TTS upstream failed",
          status: upstream.status,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        // Small hint to the client that this is streamed, not a full buffer.
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err) {
    console.error("[/api/tts] error", err);
    return new Response(JSON.stringify({ error: "TTS failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
