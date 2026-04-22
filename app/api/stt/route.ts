/**
 * Speech-to-text endpoint — Deepgram Nova-3 (en-US).
 *
 * The client POSTs raw audio bytes (webm/opus from MediaRecorder on web,
 * m4a/aac from expo-av on mobile) with the original Content-Type header.
 * We proxy straight to Deepgram — no re-encoding — and return the top
 * transcript alternative plus confidence as JSON.
 *
 * This is the "utterance" path: record → stop → transcribe. It's simple,
 * reliable, and good enough for the natural-turn chat pattern. A future
 * upgrade could swap to Deepgram's streaming WebSocket for interim
 * transcripts on long dictations, but for ordering food the user's turns
 * are short (2–8 seconds) and batch is fine.
 *
 * Why Nova-3: best US-English accuracy in Deepgram's catalog, handles
 * disfluencies ("uh", "um", restarts), and smart_format gives us
 * punctuation + number formatting out of the box so the LLM gets clean
 * input ("I want 2 large pepperonis" not "i want two large pepperonis").
 */

export const runtime = "nodejs";
export const maxDuration = 30;

// Keep requests bounded. 10 MB is plenty for ~60s of opus at reasonable
// bitrates — orders of magnitude more than any realistic spoken turn.
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    if (!process.env.DEEPGRAM_API_KEY) {
      return jsonError(503, "DEEPGRAM_API_KEY not configured");
    }

    const contentType = req.headers.get("content-type") || "application/octet-stream";
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_BYTES) {
      return jsonError(413, "audio too large");
    }

    const audio = await req.arrayBuffer();
    if (!audio || audio.byteLength === 0) {
      return jsonError(400, "empty audio body");
    }
    if (audio.byteLength > MAX_BYTES) {
      return jsonError(413, "audio too large");
    }

    // Build Deepgram URL with the options that make the transcript
    // immediately usable by the LLM: punctuation, numerals, no profanity
    // masking (users might order "damn good burger" — don't censor).
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", "nova-3");
    url.searchParams.set("language", "en-US");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("numerals", "true");
    // Mild noise suppression — users are ordering from restaurants, cars,
    // couches. "true" is Deepgram's recommended default for consumer audio.
    url.searchParams.set("filler_words", "false");

    const upstream = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": contentType,
      },
      body: audio,
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.error("[/api/stt] upstream error", upstream.status, errText);
      return jsonError(502, "STT upstream failed", { status: upstream.status });
    }

    const data = (await upstream.json()) as DeepgramResponse;
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const transcript = (alt?.transcript || "").trim();
    const confidence = typeof alt?.confidence === "number" ? alt.confidence : null;
    const durationSec = data?.metadata?.duration ?? null;

    if (!transcript) {
      // Empty transcript is legitimate — silence or unintelligible audio.
      // Return 200 with empty string so the client can show a gentle
      // "Didn't catch that" hint rather than treating it as a hard error.
      return Response.json({
        transcript: "",
        confidence,
        duration_sec: durationSec,
        empty: true,
      });
    }

    return Response.json({
      transcript,
      confidence,
      duration_sec: durationSec,
    });
  } catch (err) {
    console.error("[/api/stt] error", err);
    return jsonError(500, "STT failed");
  }
}

function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Minimal subset of the Deepgram prerecorded-listen response shape we touch.
interface DeepgramResponse {
  metadata?: {
    duration?: number;
  };
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
      }>;
    }>;
  };
}
