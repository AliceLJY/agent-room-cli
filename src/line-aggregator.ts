/**
 * Aggregates readline `line` events that arrive in a short burst (a terminal
 * paste) into one multi-line submission.
 *
 * Why: `readline` emits one `line` event per pasted line, so a pasted
 * design/diff/log used to become N separate room messages (observed in the
 * 2026-04-23 dev room transcript, where one reply arrived as 6 fragments).
 * A human typing Enter twice within the window is practically impossible at
 * 25ms, so the window only ever merges pastes.
 *
 * Interior lines are kept verbatim — indentation matters for code. Only
 * fully blank leading/trailing lines are stripped.
 */
export class LineAggregator {
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onSubmit: (text: string) => void,
    private readonly windowMs = 25,
  ) {}

  push(line: string): void {
    this.pending.push(line);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  /** Flush immediately (e.g. on shutdown) instead of waiting for the window. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const lines = this.pending.splice(0, this.pending.length);
    const text = trimOuterBlankLines(lines).join("\n");
    if (!text.trim()) return;
    this.onSubmit(text);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.length = 0;
  }
}

function trimOuterBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}
