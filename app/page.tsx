"use client";

import { useChat } from "ai/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Send, Sparkles, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageBubble } from "@/components/MessageBubble";
import { ToolResultRenderer } from "@/components/ToolResultRenderer";
import { useVoice } from "@/hooks/useVoice";

const SUGGESTIONS = [
  "Order a large pepperoni pizza",
  "I want Thai food tonight",
  "Breakfast tacos, fast",
  "Something vegetarian, under $20",
];

const VOICE_MODE_KEY = "lumo.voiceMode";

export default function ChatPage() {
  const [voiceMode, setVoiceMode] = useState(false);

  const {
    messages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    stop,
    append,
  } = useChat({
    api: "/api/chat",
    // `body` is merged into every request. Changing voiceMode mid-session
    // is safe — useChat re-reads the closure on each send.
    body: { voiceMode },
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const lastSpokenIdRef = useRef<string | null>(null);

  // Restore voice mode pref from localStorage
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VOICE_MODE_KEY);
      if (saved === "1") setVoiceMode(true);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(VOICE_MODE_KEY, voiceMode ? "1" : "0");
    } catch {}
  }, [voiceMode]);

  const handleFinalTranscript = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      setInput("");
      append({ role: "user", content: clean });
    },
    [append, setInput]
  );

  const voice = useVoice({
    onFinalTranscript: handleFinalTranscript,
    onInterimTranscript: (t) => setInput(t),
  });

  // Auto-speak new assistant messages when voice mode is on.
  useEffect(() => {
    if (!voiceMode) return;
    if (isLoading) return; // wait until streaming done
    if (!messages.length) return;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant") return;
    if (!last.content) return;
    if (lastSpokenIdRef.current === last.id) return;
    lastSpokenIdRef.current = last.id;
    voice.speak(last.content);
  }, [messages, isLoading, voiceMode, voice]);

  useEffect(() => {
    if (messages.length > 0) setShowSuggestions(false);
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const toggleVoiceMode = () => {
    setVoiceMode((v) => {
      const next = !v;
      if (!next) voice.silence();
      return next;
    });
  };

  const onMicClick = () => {
    if (voice.isListening) {
      voice.stop();
    } else {
      // If assistant is mid-speech, the hook will barge-in and cancel it.
      voice.start();
    }
  };

  return (
    <main className="flex min-h-dvh flex-col bg-gradient-to-b from-ink-50 to-white">
      <Header
        voiceMode={voiceMode}
        onToggleVoice={toggleVoiceMode}
        voiceSupported={voice.support.tts || voice.support.stt}
        isSpeaking={voice.isSpeaking}
      />

      <div
        ref={scrollRef}
        className="chat-scroll flex-1 overflow-y-auto px-4 py-4 sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {messages.length === 0 && <EmptyState />}

          {messages.map((msg) => {
            // Suppress a redundant restaurant-list card when the same
            // assistant turn also produced a menu. See mobile for rationale.
            const invs = msg.toolInvocations ?? [];
            const hasMenu = invs.some(
              (i) =>
                (i as { result?: { kind?: string } }).result?.kind === "menu"
            );
            const visibleInvs = hasMenu
              ? invs.filter(
                  (i) =>
                    (i as { result?: { kind?: string } }).result?.kind !==
                    "restaurants"
                )
              : invs;
            // Cheap pre-render glue-space fix: the Vercel AI SDK concatenates
            // text segments across tool-call boundaries without inserting
            // whitespace, so "near you!" + "Got" → "near you!Got". Patch it
            // up before rendering. Regex targets sentence terminators fused
            // to a following letter.
            const displayContent = msg.content
              ? msg.content.replace(/([.!?])([A-Z])/g, "$1 $2")
              : msg.content;
            return (
              <div key={msg.id} className="flex flex-col gap-2">
                {displayContent && (
                  <MessageBubble role={msg.role}>{displayContent}</MessageBubble>
                )}
                {visibleInvs.map((tc) => (
                  <ToolResultRenderer
                    key={tc.toolCallId}
                    invocation={tc}
                    onQuickReply={(text) => append({ role: "user", content: text })}
                  />
                ))}
              </div>
            );
          })}

          {isLoading && <TypingIndicator />}
        </div>
      </div>

      {showSuggestions && messages.length === 0 && (
        <div className="mx-auto w-full max-w-2xl px-4 sm:px-6">
          <div className="flex flex-wrap gap-2 pb-3">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => append({ role: "user", content: s })}
                className="rounded-full border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-700 shadow-card transition hover:border-lumo-300 hover:text-lumo-700"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <Composer
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isLoading={isLoading}
        onStop={stop}
        onMicClick={onMicClick}
        isListening={voice.isListening}
        sttSupported={voice.support.stt}
        interim={voice.interim}
      />
    </main>
  );
}

function Header({
  voiceMode,
  onToggleVoice,
  voiceSupported,
  isSpeaking,
}: {
  voiceMode: boolean;
  onToggleVoice: () => void;
  voiceSupported: boolean;
  isSpeaking: boolean;
}) {
  return (
    <header className="safe-top sticky top-0 z-10 border-b border-ink-100 bg-white/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-lumo-500 text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-ink-900">Lumo</div>
            <div className="text-xs text-ink-500">Austin · LA · SF · Chicago</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {voiceSupported && (
            <button
              type="button"
              onClick={onToggleVoice}
              aria-pressed={voiceMode}
              aria-label={
                voiceMode
                  ? "Voice mode on — tap to mute"
                  : "Voice mode off — tap to enable spoken replies"
              }
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition",
                voiceMode
                  ? "border-lumo-300 bg-lumo-50 text-lumo-700"
                  : "border-ink-200 bg-white text-ink-500 hover:text-ink-700"
              )}
            >
              {voiceMode ? (
                <Volume2
                  className={cn(
                    "h-3.5 w-3.5",
                    isSpeaking && "animate-pulse text-lumo-600"
                  )}
                />
              ) : (
                <VolumeX className="h-3.5 w-3.5" />
              )}
              Voice
            </button>
          )}
          <div className="text-xs text-ink-500">v0.1 · demo</div>
        </div>
      </div>
    </header>
  );
}

function EmptyState() {
  return (
    <div className="animate-fade-in mt-8 flex flex-col items-center text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-lumo-500 text-white shadow-soft">
        <Sparkles className="h-6 w-6" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
        Hungry? Just ask.
      </h1>
      <p className="mt-2 max-w-sm text-sm text-ink-500">
        Tell Lumo what you want. It finds the restaurant, builds your order,
        and handles delivery — all in one conversation.
      </p>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 text-ink-400">
      <div className="typing-dot" />
      <div className="typing-dot" />
      <div className="typing-dot" />
    </div>
  );
}

function Composer(props: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  isLoading: boolean;
  onStop: () => void;
  onMicClick: () => void;
  isListening: boolean;
  sttSupported: boolean;
  interim: string;
}) {
  const displayValue = props.isListening && props.interim
    ? props.interim
    : props.value;

  return (
    <div className="safe-bottom sticky bottom-0 border-t border-ink-100 bg-white/95 backdrop-blur">
      <form
        onSubmit={props.onSubmit}
        className="mx-auto flex w-full max-w-2xl items-center gap-2 px-4 py-3 sm:px-6"
      >
        <button
          type="button"
          aria-label={
            !props.sttSupported
              ? "Voice input not supported in this browser"
              : props.isListening
                ? "Stop listening"
                : "Start voice input"
          }
          onClick={props.onMicClick}
          disabled={!props.sttSupported}
          className={cn(
            "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition",
            !props.sttSupported
              ? "border-ink-200 bg-white text-ink-400 opacity-60"
              : props.isListening
                ? "border-lumo-400 bg-lumo-50 text-lumo-700"
                : "border-ink-200 bg-white text-ink-600 hover:border-lumo-300 hover:text-lumo-700"
          )}
        >
          {props.isListening ? (
            <>
              <Mic className="h-5 w-5" />
              <span className="absolute inset-0 animate-pulse rounded-full ring-2 ring-lumo-400/60" />
            </>
          ) : !props.sttSupported ? (
            <MicOff className="h-5 w-5" />
          ) : (
            <Mic className="h-5 w-5" />
          )}
        </button>
        <input
          value={displayValue}
          onChange={props.onChange}
          placeholder={
            props.isListening
              ? "Listening…"
              : "What are you hungry for?"
          }
          className={cn(
            "min-w-0 flex-1 rounded-full border bg-white px-4 py-3 text-[15px] text-ink-900 shadow-card placeholder:text-ink-400 focus:outline-none focus:ring-2",
            props.isListening
              ? "border-lumo-400 focus:border-lumo-400 focus:ring-lumo-100"
              : "border-ink-200 focus:border-lumo-400 focus:ring-lumo-100"
          )}
          readOnly={props.isListening}
        />
        <button
          type={props.isLoading ? "button" : "submit"}
          onClick={props.isLoading ? props.onStop : undefined}
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow-soft transition",
            props.isLoading
              ? "bg-ink-400"
              : "bg-lumo-500 hover:bg-lumo-600 active:bg-lumo-700"
          )}
        >
          <Send className="h-5 w-5" />
        </button>
      </form>
    </div>
  );
}
