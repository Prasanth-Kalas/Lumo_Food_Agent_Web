"use client";

// Thin wrapper around the browser's Web Speech APIs.
// Works on Chrome desktop + Android Chrome + iOS Safari 14.5+.
// We keep this dependency-free so we can swap to Deepgram/ElevenLabs later
// without rewriting the UI.

export type VoiceSupport = {
  stt: boolean;
  tts: boolean;
};

export function detectVoiceSupport(): VoiceSupport {
  if (typeof window === "undefined") return { stt: false, tts: false };
  const SR =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;
  return {
    stt: !!SR,
    tts: "speechSynthesis" in window,
  };
}

export type RecognizerLike = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
};

export function createRecognizer(): RecognizerLike | null {
  if (typeof window === "undefined") return null;
  const SR =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR() as RecognizerLike;
  r.lang = "en-US";
  r.continuous = false; // single utterance; we restart on each turn
  r.interimResults = true; // stream partials while the user speaks
  return r;
}

// ---------- TTS ----------

let voiceCache: SpeechSynthesisVoice[] | null = null;

function getVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  if (voiceCache && voiceCache.length) return voiceCache;
  const v = window.speechSynthesis.getVoices();
  if (v.length) voiceCache = v;
  return v;
}

// Some browsers (Chrome) load voices asynchronously. Prime them once.
export function warmUpVoices() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const pick = () => {
    voiceCache = window.speechSynthesis.getVoices();
  };
  pick();
  window.speechSynthesis.onvoiceschanged = pick;
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = getVoices();
  if (!voices.length) return null;
  // Preference order: warm US English neural-ish voices first
  const prefer = [
    /Samantha/i,
    /Google US English/i,
    /Microsoft (Aria|Jenny|Guy)/i,
    /Alex/i,
    /en-US/i,
    /en[-_]/i,
  ];
  for (const re of prefer) {
    const hit = voices.find((v) => re.test(v.name) || re.test(v.lang));
    if (hit) return hit;
  }
  return voices[0];
}

export type SpeakOptions = {
  rate?: number; // 0.1 - 10, default 1.05
  pitch?: number; // 0 - 2, default 1
  onStart?: () => void;
  onEnd?: () => void;
};

export function speak(text: string, opts: SpeakOptions = {}) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const clean = text.trim();
  if (!clean) return;

  // Always cancel anything in flight — we don't queue, we replace.
  window.speechSynthesis.cancel();

  const utt = new SpeechSynthesisUtterance(clean);
  utt.rate = opts.rate ?? 1.05;
  utt.pitch = opts.pitch ?? 1;
  utt.lang = "en-US";
  const v = pickVoice();
  if (v) utt.voice = v;
  utt.onstart = () => opts.onStart?.();
  utt.onend = () => opts.onEnd?.();
  utt.onerror = () => opts.onEnd?.();

  window.speechSynthesis.speak(utt);
}

export function stopSpeaking() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
}

// Strip markdown + tool-card placeholders from assistant text before TTS.
// The assistant's prose can include **bold** and hyphens from lists — we want
// the spoken version to sound natural, not robotic.
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[\s]*[-•]\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
