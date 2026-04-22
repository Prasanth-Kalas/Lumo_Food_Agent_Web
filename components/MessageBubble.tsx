"use client";

import { cn } from "@/lib/utils";

/**
 * A single speech bubble in the chat log.
 * User messages align right with the brand color; assistant messages align
 * left with a soft neutral background. Keep it visually calm — the rich
 * content (restaurant cards, carts, order confirmations) renders in its
 * own siblings via <ToolResultRenderer>, not inside the bubble.
 */
export function MessageBubble({
  role,
  children,
}: {
  role: "user" | "assistant" | "system" | "data" | "tool" | "function";
  children: React.ReactNode;
}) {
  const isUser = role === "user";

  // System / tool / function / data messages are internal plumbing — don't show.
  if (!isUser && role !== "assistant") return null;

  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "animate-fade-in max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed shadow-card",
          isUser
            ? "rounded-br-md bg-lumo-500 text-white"
            : "rounded-bl-md bg-white text-ink-900 ring-1 ring-ink-100"
        )}
      >
        {children}
      </div>
    </div>
  );
}
