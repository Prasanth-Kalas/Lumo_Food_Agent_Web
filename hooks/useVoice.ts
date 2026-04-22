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

  return {
    support,
    isListening,
    isSpeaking,
    interim,
    start,
    stop: isListening ? stop : cancelListening,
    speak,
    silence,
  };
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
