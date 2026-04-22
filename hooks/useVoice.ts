"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useVoice — neural STT + TTS with barge-in.
 *
 * STT: MediaRecorder captures opus/webm, POSTs to /api/stt (Deepgram
 *      Nova-3 en-US), receives final transcript. Simple VAD auto-stops
 *      after ~1.2s of silence, or hard cap at 15s.
 * TTS: POST /api/tts, stream MP3 frames into a MediaSource buffer for
 *      sub-second time-to-first-audio. OpenAI gpt-4o-mini-tts, "sage"
 *      voice, warm-friendly-American instructions.
 * Barge-in: start() hard-cancels any ongoing TTS playback so the user
 *      can interrupt Lumo mid-sentence. silence() cancels passively.
 *
 * Preserves the surface of the previous Web-Speech-based hook so
 * `app/page.tsx` doesn't need to change.
 */

export type VoiceSupport = {
  stt: boolean;
  tts: boolean;
};

export type UseVoiceOptions = {
  onFinalTranscript: (text: string) => void;
  onInterimTranscript?: (text: string) => void;
};

export type UseVoiceReturn = {
  support: VoiceSupport;
  isListening: boolean;
  isSpeaking: boolean;
  interim: string;
  start: () => void;
  stop: () => void;
  speak: (text: string) => void;
  /**
   * Progressive TTS. Call this repeatedly as an assistant message
   * streams in — the hook will fire `/api/tts` per completed sentence,
   * append MP3 frames into a single MediaSource, and start playback as
   * soon as the first chunk is ready. Time-to-first-audio is dominated
   * by the first sentence boundary, not the full message length.
   *
   * Call with `isFinal=true` once streaming ends to flush any
   * trailing unspoken text and close the MediaSource.
   */
  speakStreaming: (messageId: string, text: string, isFinal: boolean) => void;
  silence: () => void;
};

// Silence threshold in RMS (0..1). Tuned on a MacBook built-in mic in a
// normal room. Lower = more sensitive to quiet speech; higher = more
// tolerant of room noise.
const VAD_RMS_THRESHOLD = 0.012;
const VAD_SILENCE_MS = 1200;
const MAX_RECORD_MS = 15_000;

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return undefined;
}

function detectSupport(): VoiceSupport {
  if (typeof window === "undefined") return { stt: false, tts: false };
  const hasMediaRecorder = typeof MediaRecorder !== "undefined";
  const hasGetUserMedia = !!navigator?.mediaDevices?.getUserMedia;
  const hasMediaSource = typeof (window as Window & { MediaSource?: unknown }).MediaSource !== "undefined";
  return {
    stt: hasMediaRecorder && hasGetUserMedia,
    tts: hasMediaSource, // We stream MP3 through MediaSource. Fallback uses a full-buffer blob.
  };
}

export function useVoice(opts: UseVoiceOptions): UseVoiceReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [support, setSupport] = useState<VoiceSupport>({ stt: false, tts: false });

  const optsRef = useRef(opts);
  optsRef.current = opts;

  // STT state
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadRafRef = useRef<number | null>(null);
  const lastVoiceAtRef = useRef<number>(0);
  const maxStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  // TTS state
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  // Progressive TTS session (for speakStreaming). Separate from the
  // one-shot `speak()` state above so a late fallback to speak() can
  // still work if a caller prefers it.
  const streamSessionRef = useRef<StreamSession | null>(null);

  useEffect(() => {
    setSupport(detectSupport());
    return () => {
      // Cleanup everything on unmount
      teardownStt();
      teardownTts();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- STT ----------

  const teardownStt = useCallback(() => {
    if (vadRafRef.current != null) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
    if (maxStopTimerRef.current) {
      clearTimeout(maxStopTimerRef.current);
      maxStopTimerRef.current = null;
    }
    try {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
    } catch {}
    recorderRef.current = null;
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    streamRef.current = null;
    try {
      analyserRef.current?.disconnect();
    } catch {}
    analyserRef.current = null;
    try {
      audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;
    chunksRef.current = [];
  }, []);

  const stop = useCallback(() => {
    // User-initiated stop. Recorder's onstop handler will upload + emit
    // transcript. Don't tear down the stream until after onstop fires.
    setIsListening(false);
    setInterim("");
    if (maxStopTimerRef.current) {
      clearTimeout(maxStopTimerRef.current);
      maxStopTimerRef.current = null;
    }
    if (vadRafRef.current != null) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
    try {
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      } else {
        // Recorder already ended (or never started) — just clean up.
        teardownStt();
      }
    } catch {
      teardownStt();
    }
  }, [teardownStt]);

  const cancelListening = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    if (!support.stt) return;

    // Barge-in: kill any in-flight speech as soon as the user reaches
    // for the mic. This is what makes the agent feel interruptible.
    // Covers both the one-shot `speak()` path and the progressive
    // `speakStreaming()` path.
    const sess = streamSessionRef.current;
    if (sess) {
      sess.disposed = true;
      for (const ac of sess.aborts) {
        try {
          ac.abort();
        } catch {}
      }
      streamSessionRef.current = null;
    }
    silenceTts(
      audioElRef,
      mediaSourceRef,
      sourceBufferRef,
      objectUrlRef,
      ttsAbortRef,
      ttsReaderRef,
      setIsSpeaking
    );

    if (isListening) return;
    cancelledRef.current = false;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      console.warn("[useVoice] mic permission denied", err);
      return;
    }
    streamRef.current = stream;

    const mime = pickMimeType();
    mimeRef.current = mime || null;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      console.warn("[useVoice] MediaRecorder init failed", err);
      teardownStt();
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };

    recorder.onstart = () => {
      setIsListening(true);
      lastVoiceAtRef.current = performance.now();

      // Hard cap so we never hang on a stuck stream.
      maxStopTimerRef.current = setTimeout(() => {
        try {
          if (recorderRef.current?.state === "recording") recorderRef.current.stop();
        } catch {}
      }, MAX_RECORD_MS);

      // VAD: auto-stop after sustained silence.
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        analyserRef.current = analyser;

        const buf = new Uint8Array(analyser.fftSize);

        const tick = () => {
          if (!analyserRef.current || !recorderRef.current) return;
          analyser.getByteTimeDomainData(buf);
          // RMS around the 128 midpoint for Uint8 time-domain data.
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / buf.length);
          const now = performance.now();
          if (rms > VAD_RMS_THRESHOLD) {
            lastVoiceAtRef.current = now;
          } else if (now - lastVoiceAtRef.current > VAD_SILENCE_MS) {
            // Sustained silence — auto-stop. User can also tap to stop.
            try {
              if (recorderRef.current?.state === "recording") recorderRef.current.stop();
            } catch {}
            return;
          }
          vadRafRef.current = requestAnimationFrame(tick);
        };
        vadRafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        // VAD is a nice-to-have; if AudioContext fails we just rely on
        // the hard cap + tap-to-stop.
        console.warn("[useVoice] VAD init failed", err);
      }
    };

    recorder.onerror = (ev) => {
      console.warn("[useVoice] recorder error", ev);
      teardownStt();
      setIsListening(false);
    };

    recorder.onstop = async () => {
      const chunks = chunksRef.current;
      const mimeType = mimeRef.current || chunks[0]?.type || "audio/webm";
      teardownStt();
      setIsListening(false);
      setInterim("");

      if (cancelledRef.current) {
        cancelledRef.current = false;
        return;
      }
      if (!chunks.length) return;

      const blob = new Blob(chunks, { type: mimeType });
      // Discard anything suspiciously short — single-click noise, not
      // speech. Deepgram also charges per request, might as well filter.
      if (blob.size < 2000) return;

      try {
        const res = await fetch("/api/stt", {
          method: "POST",
          headers: { "Content-Type": mimeType },
          body: blob,
        });
        if (!res.ok) {
          console.warn("[useVoice] STT failed", res.status);
          return;
        }
        const data = (await res.json()) as { transcript?: string; empty?: boolean };
        const text = (data.transcript || "").trim();
        if (text) optsRef.current.onFinalTranscript(text);
      } catch (err) {
        console.warn("[useVoice] STT network error", err);
      }
    };

    try {
      // timeslice so ondataavailable fires periodically — lets us
      // tear down cleanly mid-recording if needed.
      recorder.start(250);
    } catch (err) {
      console.warn("[useVoice] recorder.start() failed", err);
      teardownStt();
      setIsListening(false);
    }
  }, [support.stt, isListening, teardownStt]);

  // ---------- TTS ----------

  const teardownTts = useCallback(() => {
    silenceTts(
      audioElRef,
      mediaSourceRef,
      sourceBufferRef,
      objectUrlRef,
      ttsAbortRef,
      ttsReaderRef,
      setIsSpeaking
    );
  }, []);

  const silence = useCallback(() => {
    // Kill both the one-shot speak() path AND the progressive
    // speakStreaming() path so barge-in works regardless of which one
    // is active.
    const sess = streamSessionRef.current;
    if (sess) {
      sess.disposed = true;
      for (const ac of sess.aborts) {
        try {
          ac.abort();
        } catch {}
      }
      try {
        sess.audio.pause();
        sess.audio.src = "";
        sess.audio.load();
      } catch {}
      try {
        if (sess.ms.readyState === "open") sess.ms.endOfStream();
      } catch {}
      try {
        URL.revokeObjectURL(sess.url);
      } catch {}
      streamSessionRef.current = null;
    }
    teardownTts();
  }, [teardownTts]);

  const speak = useCallback(
    async (text: string) => {
      if (!support.tts) return;
      const clean = (text || "").trim();
      if (!clean) return;

      // Interrupt any in-flight speech before starting a new one.
      teardownTts();

      const abort = new AbortController();
      ttsAbortRef.current = abort;

      let res: Response;
      try {
        res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: clean }),
          signal: abort.signal,
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.warn("[useVoice] TTS fetch failed", err);
        }
        return;
      }
      if (!res.ok || !res.body) {
        console.warn("[useVoice] TTS upstream error", res.status);
        return;
      }

      // Set up a MediaSource the <audio> element can consume while we
      // append chunks from the streaming response. This is how we get
      // sub-second time-to-first-audio.
      const audio = new Audio();
      audioElRef.current = audio;
      audio.onended = () => setIsSpeaking(false);
      audio.onerror = () => setIsSpeaking(false);

      const ms = new MediaSource();
      mediaSourceRef.current = ms;
      const url = URL.createObjectURL(ms);
      objectUrlRef.current = url;
      audio.src = url;

      ms.addEventListener(
        "sourceopen",
        async () => {
          let sb: SourceBuffer;
          try {
            sb = ms.addSourceBuffer("audio/mpeg");
          } catch (err) {
            console.warn("[useVoice] addSourceBuffer failed", err);
            teardownTts();
            return;
          }
          sourceBufferRef.current = sb;

          const reader = res.body!.getReader();
          ttsReaderRef.current = reader;

          const appendChunk = (chunk: Uint8Array) =>
            new Promise<void>((resolve, reject) => {
              const onDone = () => {
                sb.removeEventListener("updateend", onDone);
                sb.removeEventListener("error", onErr);
                resolve();
              };
              const onErr = (e: Event) => {
                sb.removeEventListener("updateend", onDone);
                sb.removeEventListener("error", onErr);
                reject(e);
              };
              sb.addEventListener("updateend", onDone);
              sb.addEventListener("error", onErr);
              try {
                // Copy into a fresh ArrayBuffer-backed Uint8Array to
                // satisfy TS's BufferSource narrowing (SourceBuffer
                // refuses SharedArrayBuffer-backed views).
                const copy = new Uint8Array(chunk.byteLength);
                copy.set(chunk);
                sb.appendBuffer(copy);
              } catch (e) {
                reject(e);
              }
            });

          try {
            // Kick off playback as soon as we have the first chunk —
            // the browser buffers the rest while Lumo starts talking.
            let first = true;
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.byteLength) {
                await appendChunk(value);
                if (first) {
                  first = false;
                  setIsSpeaking(true);
                  audio.play().catch((err) => {
                    // Autoplay can be blocked on some browsers. Surface
                    // quietly — text is still in the chat.
                    console.warn("[useVoice] audio.play blocked", err);
                  });
                }
              }
            }
            if (ms.readyState === "open") {
              try {
                ms.endOfStream();
              } catch {}
            }
          } catch (err) {
            if ((err as Error).name !== "AbortError") {
              console.warn("[useVoice] TTS stream error", err);
            }
            teardownTts();
          }
        },
        { once: true }
      );
    },
    [support.tts, teardownTts]
  );

  // ---------- Progressive TTS ----------

  const teardownStreamSession = useCallback(() => {
    const sess = streamSessionRef.current;
    if (!sess) return;
    sess.disposed = true;
    for (const ac of sess.aborts) {
      try {
        ac.abort();
      } catch {}
    }
    try {
      sess.audio.pause();
      sess.audio.src = "";
      sess.audio.load();
    } catch {}
    try {
      if (sess.ms.readyState === "open") sess.ms.endOfStream();
    } catch {}
    try {
      URL.revokeObjectURL(sess.url);
    } catch {}
    streamSessionRef.current = null;
    // Also clear the shared refs that silenceTts operates on, so
    // barge-in from start() still works correctly.
    if (audioElRef.current === sess.audio) audioElRef.current = null;
    if (mediaSourceRef.current === sess.ms) mediaSourceRef.current = null;
    if (sourceBufferRef.current === sess.sb) sourceBufferRef.current = null;
    if (objectUrlRef.current === sess.url) objectUrlRef.current = null;
    setIsSpeaking(false);
  }, []);

  const dispatchNext = useCallback(async (sess: StreamSession): Promise<void> => {
    if (sess.disposed) return;
    if (sess.inflight) return;

    const text = sess.latestText;
    const isFinal = sess.latestFinal;
    const tail = text.slice(sess.sentIndex);

    let cut: number;
    if (isFinal) {
      cut = tail.length;
    } else {
      cut = findBoundaryIndex(tail);
      if (cut <= 0) return; // no boundary yet, wait for more text
    }
    if (cut <= 0) {
      if (isFinal) {
        try {
          if (sess.ms.readyState === "open") sess.ms.endOfStream();
        } catch {}
      }
      return;
    }

    const chunk = tail.slice(0, cut).trim();
    sess.sentIndex += cut;
    if (!chunk) {
      // All whitespace — try again in case more boundaries are queued.
      return dispatchNext(sess);
    }

    sess.inflight = true;
    const ac = new AbortController();
    sess.aborts.push(ac);

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk }),
        signal: ac.signal,
      });
      if (sess.disposed) return;
      if (!res.ok || !res.body) {
        console.warn("[useVoice] TTS upstream error", res.status);
        return;
      }

      const reader = res.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done || sess.disposed) break;
        if (value && value.byteLength) {
          await appendToSourceBuffer(sess, value);
          if (sess.disposed) break;
          if (!sess.started) {
            sess.started = true;
            setIsSpeaking(true);
            sess.audio.play().catch((err) => {
              console.warn("[useVoice] audio.play blocked", err);
            });
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.warn("[useVoice] TTS stream error", err);
      }
    } finally {
      sess.inflight = false;
    }

    if (sess.disposed) return;

    // If text grew while we were fetching, dispatch the next chunk.
    if (sess.sentIndex < sess.latestText.length || sess.latestFinal) {
      // Use latest state — caller may have updated isFinal since entry.
      if (sess.latestFinal && sess.sentIndex >= sess.latestText.length) {
        try {
          if (sess.ms.readyState === "open") sess.ms.endOfStream();
        } catch {}
      } else {
        await dispatchNext(sess);
      }
    }
  }, []);

  const speakStreaming = useCallback(
    (messageId: string, text: string, isFinal: boolean) => {
      if (!support.tts) return;
      const clean = text || "";
      if (!clean.trim() && !isFinal) return;

      const current = streamSessionRef.current;

      // Different message → tear down and restart. Happens when the
      // assistant starts a new reply before the previous one finishes
      // playing.
      if (current && current.messageId !== messageId) {
        teardownStreamSession();
      }

      let sess = streamSessionRef.current;

      if (!sess) {
        // Wait until we have something worth starting on. If this isn't
        // the final call and there's no sentence boundary yet, hold off.
        const firstBoundary = findBoundaryIndex(clean);
        if (!isFinal && firstBoundary <= 0) return;
        if (!isFinal && clean.trim().length < 4) return;

        // Hard-cancel any old one-shot `speak()` session first so only
        // one MediaSource is live at a time.
        silenceTts(
          audioElRef,
          mediaSourceRef,
          sourceBufferRef,
          objectUrlRef,
          ttsAbortRef,
          ttsReaderRef,
          setIsSpeaking
        );

        const audio = new Audio();
        const ms = new MediaSource();
        const url = URL.createObjectURL(ms);
        audio.src = url;
        audio.onended = () => setIsSpeaking(false);
        audio.onerror = () => setIsSpeaking(false);

        sess = {
          messageId,
          sentIndex: 0,
          latestText: clean,
          latestFinal: isFinal,
          audio,
          ms,
          sb: null,
          url,
          aborts: [],
          pendingAppend: Promise.resolve(),
          inflight: false,
          started: false,
          disposed: false,
        };
        streamSessionRef.current = sess;
        audioElRef.current = audio;
        mediaSourceRef.current = ms;
        objectUrlRef.current = url;

        ms.addEventListener(
          "sourceopen",
          () => {
            if (!sess || sess.disposed) return;
            try {
              sess.sb = ms.addSourceBuffer("audio/mpeg");
              sourceBufferRef.current = sess.sb;
            } catch (err) {
              console.warn("[useVoice] addSourceBuffer failed", err);
              teardownStreamSession();
              return;
            }
            // Kick off the first dispatch now that the buffer is live.
            dispatchNext(sess);
          },
          { once: true }
        );
        return;
      }

      // Session exists — just update the latest known state and kick
      // the dispatcher. If a fetch is in flight, it'll pick up the new
      // text when it finishes.
      sess.latestText = clean;
      sess.latestFinal = isFinal;
      if (sess.sb && !sess.inflight) {
        dispatchNext(sess);
      }
    },
    [support.tts, teardownStreamSession, dispatchNext]
  );

  return {
    support,
    isListening,
    isSpeaking,
    interim,
    start,
    stop: isListening ? stop : cancelListening,
    speak,
    speakStreaming,
    silence,
  };
}

// --- progressive TTS session ----------------------------------------

type StreamSession = {
  messageId: string;
  /** Number of chars of latestText already dispatched to /api/tts. */
  sentIndex: number;
  /** Latest known message text from the caller. */
  latestText: string;
  /** Whether streaming has finished (so we can flush the tail). */
  latestFinal: boolean;
  audio: HTMLAudioElement;
  ms: MediaSource;
  sb: SourceBuffer | null;
  url: string;
  aborts: AbortController[];
  /** Serializes `SourceBuffer.appendBuffer` calls — MSE rejects
   *  overlapping appends. */
  pendingAppend: Promise<void>;
  /** Is a `/api/tts` fetch currently in flight? */
  inflight: boolean;
  /** Has audio.play() already been kicked off? */
  started: boolean;
  /** Torn down — short-circuit any late async callbacks. */
  disposed: boolean;
};

/**
 * Find the last "safe" place in `text` to end a TTS chunk. We prefer
 * sentence terminators; if nothing obvious shows up after the first
 * few chars, we settle for a clause break (`; : ,`) once the tail
 * gets long enough that waiting longer would hurt perceived latency
 * more than a slightly awkward cut helps prosody.
 *
 * Returns the char index AFTER the boundary (so `text.slice(0, idx)`
 * is the full chunk including its punctuation + trailing whitespace),
 * or -1 if no acceptable boundary exists yet.
 */
function findBoundaryIndex(text: string): number {
  if (!text) return -1;

  // Primary: sentence-end followed by whitespace or end of string.
  // Need `\n` too because the model sometimes ends a turn on a bare
  // newline without punctuation (e.g. after a tool-triggered card).
  const strong = /[.!?…](\s|$)|\n/g;
  let lastStrong = -1;
  let m: RegExpExecArray | null;
  while ((m = strong.exec(text)) !== null) {
    // Include the terminator itself; skip trailing whitespace so the
    // next chunk starts cleanly.
    let end = m.index + m[0].length;
    while (end < text.length && /\s/.test(text[end])) end++;
    lastStrong = end;
  }
  if (lastStrong > 0) return lastStrong;

  // Fallback: if we've accumulated a long clause with no sentence
  // terminator, cut on a clause break so time-to-first-audio stays
  // bounded. Threshold picked so typical greetings ("Hey!" = 4 chars)
  // still wait for their real terminator.
  if (text.length >= 80) {
    const weak = /[;:](\s)/g;
    let lastWeak = -1;
    while ((m = weak.exec(text)) !== null) {
      let end = m.index + m[0].length;
      while (end < text.length && /\s/.test(text[end])) end++;
      lastWeak = end;
    }
    if (lastWeak > 0) return lastWeak;
  }

  // Last resort: comma after 120 chars. Better to speak than to stall.
  if (text.length >= 120) {
    const idx = text.lastIndexOf(", ");
    if (idx > 20) return idx + 2;
  }

  return -1;
}

/**
 * Append an MP3 chunk to the session's SourceBuffer, serializing on
 * the session's `pendingAppend` so multiple concurrent fetches don't
 * race into `SourceBuffer.appendBuffer` (which throws if the buffer
 * is still updating).
 */
async function appendToSourceBuffer(
  sess: StreamSession,
  chunk: Uint8Array
): Promise<void> {
  const sb = sess.sb;
  if (!sb) return;
  const job = sess.pendingAppend.then(
    () =>
      new Promise<void>((resolve, reject) => {
        const onDone = () => {
          sb.removeEventListener("updateend", onDone);
          sb.removeEventListener("error", onErr);
          resolve();
        };
        const onErr = (e: Event) => {
          sb.removeEventListener("updateend", onDone);
          sb.removeEventListener("error", onErr);
          reject(e);
        };
        sb.addEventListener("updateend", onDone);
        sb.addEventListener("error", onErr);
        try {
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          sb.appendBuffer(copy);
        } catch (e) {
          sb.removeEventListener("updateend", onDone);
          sb.removeEventListener("error", onErr);
          reject(e);
        }
      })
  );
  sess.pendingAppend = job.catch(() => {});
  return job;
}

// --- helpers ---------------------------------------------------------

// Hard-cancel any in-flight TTS playback and cleanup. Extracted as a
// plain fn so start() can call it atomically for barge-in without
// depending on React state closure order.
function silenceTts(
  audioElRef: React.MutableRefObject<HTMLAudioElement | null>,
  mediaSourceRef: React.MutableRefObject<MediaSource | null>,
  sourceBufferRef: React.MutableRefObject<SourceBuffer | null>,
  objectUrlRef: React.MutableRefObject<string | null>,
  ttsAbortRef: React.MutableRefObject<AbortController | null>,
  ttsReaderRef: React.MutableRefObject<ReadableStreamDefaultReader<Uint8Array> | null>,
  setIsSpeaking: (v: boolean) => void
) {
  try {
    ttsAbortRef.current?.abort();
  } catch {}
  ttsAbortRef.current = null;

  try {
    ttsReaderRef.current?.cancel().catch(() => {});
  } catch {}
  ttsReaderRef.current = null;

  const audio = audioElRef.current;
  if (audio) {
    try {
      audio.pause();
      audio.src = "";
      audio.load();
    } catch {}
  }
  audioElRef.current = null;

  const ms = mediaSourceRef.current;
  if (ms) {
    try {
      if (ms.readyState === "open") ms.endOfStream();
    } catch {}
  }
  mediaSourceRef.current = null;
  sourceBufferRef.current = null;

  const url = objectUrlRef.current;
  if (url) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
  objectUrlRef.current = null;

  setIsSpeaking(false);
}
