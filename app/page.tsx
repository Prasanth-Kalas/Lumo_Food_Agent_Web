"use client";

import { useChat } from "ai/react";
import { useEffect, useRef, useState } from "react";
import { Mic, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageBubble } from "@/components/MessageBubble";
import { ToolResultRenderer } from "@/components/ToolResultRenderer";

const SUGGESTIONS = [
  "Order a large pepperoni pizza",
  "I want Thai food tonight",
  "Breakfast tacos, fast",
  "Something vegetarian, under $20",
];

export default function ChatPage() {
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    stop,
    append,
  } = useChat({ api: "/api/chat" });

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(true);

  useEffect(() => {
    if (messages.length > 0) setShowSuggestions(false);
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  return (
    <main className="flex min-h-dvh flex-col bg-gradient-to-b from-ink-50 to-white">
      <Header />

      <div
        ref={scrollRef}
        className="chat-scroll flex-1 overflow-y-auto px-4 py-4 sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {messages.length === 0 && <EmptyState />}

          {messages.map((msg) => (
            <div key={msg.id} className="flex flex-col gap-2">
              {msg.content && (
                <MessageBubble role={msg.role}>{msg.content}</MessageBubble>
              )}
              {msg.toolInvocations?.map((tc) => (
                <ToolResultRenderer
                  key={tc.toolCallId}
                  invocation={tc}
                  onQuickReply={(text) => append({ role: "user", content: text })}
                />
              ))}
            </div>
          ))}

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
      />
    </main>
  );
}

function Header() {
  return (
    <header className="safe-top sticky top-0 z-10 border-b border-ink-100 bg-white/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-lumo-500 text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-ink-900">Lumo</div>
            <div className="text-xs text-ink-500">Austin, TX · open now</div>
          </div>
        </div>
        <div className="text-xs text-ink-500">v0.1 · demo</div>
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
}) {
  return (
    <div className="safe-bottom sticky bottom-0 border-t border-ink-100 bg-white/95 backdrop-blur">
      <form
        onSubmit={props.onSubmit}
        className="mx-auto flex w-full max-w-2xl items-center gap-2 px-4 py-3 sm:px-6"
      >
        <button
          type="button"
          aria-label="Voice input (coming soon)"
          disabled
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-ink-200 bg-white text-ink-400 opacity-60"
        >
          <Mic className="h-5 w-5" />
        </button>
        <input
          value={props.value}
          onChange={props.onChange}
          placeholder="What are you hungry for?"
          className="min-w-0 flex-1 rounded-full border border-ink-200 bg-white px-4 py-3 text-[15px] text-ink-900 shadow-card placeholder:text-ink-400 focus:border-lumo-400 focus:outline-none focus:ring-2 focus:ring-lumo-100"
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
