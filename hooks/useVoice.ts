"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cleanForSpeech,
  createRecognizer,
  detectVoiceSupport,
  speak as ttsSpeak,
  stopSpeaking,
  warmUpVoices,
  type RecognizerLike,
  type VoiceSupport,
} from "@/lib/voice";

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

export function useVoice(opts: UseVoiceOptions): UseVoiceReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [support, setSupport] = useState<VoiceSupport>({
    stt: false,
    tts: false,
  });

  const recognizerRef = useRef<RecognizerLike | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Detect on mount (needs window)
  useEffect(() => {
    setSupport(detectVoiceSupport());
    warmUpVoices();
    return () => {
      recognizerRef.current?.abort();
      stopSpeaking();
    };
  }, []);

  const start = useCallback(() => {
    if (!support.stt) return;

    // Barge-in: if Lumo is talking, stop her the moment the user hits mic.
    stopSpeaking();
    setIsSpeaking(false);

    const r = createRecognizer();
    if (!r) return;
    recognizerRef.current = r;

    r.onstart = () => {
      setIsListening(true);
    };
    r.onresult = (e: any) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interimText += res[0].transcript;
      }
      if (interimText) {
        setInterim(interimText);
        optsRef.current.onInterimTranscript?.(interimText);
      }
      if (finalText) {
        setInterim("");
        optsRef.current.onFinalTranscript(finalText.trim());
      }
    };
    r.onerror = (e: any) => {
      // "no-speech" / "aborted" are benign — just end the turn
      if (e?.error && e.error !== "no-speech" && e.error !== "aborted") {
        console.warn("[useVoice] STT error:", e.error);
      }
      setIsListening(false);
      setInterim("");
    };
    r.onend = () => {
      setIsListening(false);
      setInterim("");
    };

    try {
      r.start();
    } catch (err) {
      // start() throws if called twice in a row before onend fires
      console.warn("[useVoice] start() failed:", err);
      setIsListening(false);
    }
  }, [support.stt]);

  const stop = useCallback(() => {
    recognizerRef.current?.stop();
    setIsListening(false);
    setInterim("");
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!support.tts) return;
      const clean = cleanForSpeech(text);
      if (!clean) return;
      ttsSpeak(clean, {
        onStart: () => setIsSpeaking(true),
        onEnd: () => setIsSpeaking(false),
      });
    },
    [support.tts]
  );

  const silence = useCallback(() => {
    stopSpeaking();
    setIsSpeaking(false);
  }, []);

  return {
    support,
    isListening,
    isSpeaking,
    interim,
    start,
    stop,
    speak,
    silence,
  };
}
