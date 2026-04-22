/**
 * Strip formatting the agent might emit so the TTS model speaks cleanly.
 *
 * The agent is tuned for a chat UI — it occasionally drops markdown, emoji,
 * list bullets, or tool-result JSON into plain text. None of that should be
 * read aloud. We also collapse whitespace and trim so the TTS first-byte
 * latency isn't spent on silence.
 */

export function sanitizeForTTS(raw: string): string {
  let s = raw;

  // Remove fenced code / JSON blocks — they're visual, not speakable.
  s = s.replace(/```[\s\S]*?```/g, " ");

  // Strip inline backticks but keep the text inside them.
  s = s.replace(/`([^`]+)`/g, "$1");

  // Markdown bold/italic → plain text.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");

  // Markdown links [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Bullet points and numbered list prefixes.
  s = s.replace(/^\s*[-*•]\s+/gm, "");
  s = s.replace(/^\s*\d+\.\s+/gm, "");

  // Headings → plain text
  s = s.replace(/^#{1,6}\s+/gm, "");

  // Emoji — strip via a unicode range. Users didn't say "read the burger emoji."
  s = s.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu,
    " "
  );

  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}
