/**
 * Streaming TTS endpoint — OpenAI gpt-4o-mini-tts.
 *
 * Two entry points, one backend:
 *   POST { text, voice?, instructions? }
 *     — for the web client, which streams the body into a MediaSource.
 *   GET  ?text=...&voice=...
 *     — for the mobile client, which hands the URL to expo-av's native
 *       player (AVPlayer / ExoPlayer) for progressive MP3 playback. GET
 *       is required because expo-av only accepts a URI, not a method +
 *       body.
 *
 * Streaming matters: time-to-first-audio is what makes the agent feel
 * alive vs. a voicemail.
 *
 * Voice: "sage" by default — warm, conversational American English. The
 * `instructions` field lets us steer prosody per-utterance without
 * retraining. Text sanitization happens server-side so every client gets
 * the same clean input without re-implementing the regex soup.
 */

import { sanitizeForTTS } from "@/lib/tts-sanitize";

export const runtime = "nodejs";
export const maxDuration = 30;

// Default voice personality — see system prompt & brand voice guidelines.
// Locked to "friendly local American" per product decision. Override
// per-call by passing `voice` (one of: alloy, ash, ballad, coral, echo,
// fable, nova, onyx, sage, shimmer) or `instructions`.
const DEFAULT_VOICE = "sage";
const DEFAULT_INSTRUCTIONS =
  "Speak warmly and casually, like a competent friend helping someone order food. " +
  "Use contractions. Keep pacing quick but relaxed. Slight smile in the voice. " +
  "Avoid robotic pauses between sentences. American English.";

// Valid OpenAI TTS voices. Anything outside this set falls back to the
// default — prevents junk query params from silently re-routing.
const ALLOWED_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
]);

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }
  return synthesize({
    text: (body.text as string) ?? "",
    voice: (body.voice as string) ?? DEFAULT_VOICE,
    instructions: (body.instructions as string) ?? DEFAULT_INSTRUCTIONS,
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  return synthesize({
    text: url.searchParams.get("text") ?? "",
    voice: url.searchParams.get("voice") ?? DEFAULT_VOICE,
    instructions: url.searchParams.get("instructions") ?? DEFAULT_INSTRUCTIONS,
  });
}

async function synthesize(params: {
  text: string;
  voice: string;
  instructions: string;
}): Promise<Response> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return jsonError(503, "OPENAI_API_KEY not configured");
    }

    const cleaned = sanitizeForTTS(params.text);
    if (!cleaned) return jsonError(400, "text required");

    const voice = ALLOWED_VOICES.has(params.voice) ? params.voice : DEFAULT_VOICE;

    // Hard cap to keep costs and latency bounded. gpt-4o-mini-tts pricing
    // is ~$0.015 per 1k input chars — 4000 chars ≈ $0.06 per call.
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
        instructions: params.instructions,
        response_format: "mp3",
        // stream_format: "audio" gives us plain MP3 frames we can pipe
        // directly into a media element. "sse" would give JSON events
        // which we don't need here.
        stream_format: "audio",
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      console.error("[/api/tts] upstream error", upstream.status, errText);
      return jsonError(502, "TTS upstream failed", { status: upstream.status });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        // Small hint to the client that this is streamed, not a full
        // buffer. expo-av's native player uses this to start playback
        // without waiting for Content-Length.
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err) {
    console.error("[/api/tts] error", err);
    return jsonError(500, "TTS failed");
  }
}

function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
