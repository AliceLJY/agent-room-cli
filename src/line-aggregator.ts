/**
 * Buffers terminal input so a paste becomes "fill the box, send on Enter" text
 * instead of auto-firing line by line.
 *
 * Model: a paste fills a draft; Enter sends it. A paste's content (including
 * its own newlines) is accumulated and never sent on its own — only an Enter
 * the user actually pressed sends the staged draft. This lets one message be
 * built from several pastes before sending (2026-06-21 request).
 *
 * A paste is recognised two ways:
 *  - Primary — bracketed paste (DEC mode 2004). The terminal wraps a paste in
 *    ESC[200~ / ESC[201~; the caller drives beginPaste() / endPaste(). The
 *    block is staged into the draft on endPaste() — whole no matter how large
 *    or how slowly chunked — and waits for Enter.
 *  - Fallback — terminals without bracketed paste just stream `line` events; a
 *    25ms quiet window coalesces a burst (a human can't press Enter twice that
 *    fast) and sends it. Multi-paste accumulation isn't available there, but a
 *    block still arrives as one message.
 *
 * The final pasted line has no trailing newline, so readline never fires a
 * `line` event for it — it sits in readline's edit buffer. The optional
 * `drainResidual` hook hands that tail back so it joins the rest.
 *
 * Interior lines are kept verbatim. Only fully blank leading/trailing lines
 * are stripped when sending.
 */
export class LineAggregator {
  private draft: string[] = []; // staged pasted lines, awaiting the user's Enter
  private pending: string[] = []; // lines in the current paste or 25ms window
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pasting = false;

  constructor(
    private readonly onSubmit: (text: string) => void,
    private readonly windowMs = 25,
    // Returns (and clears) the line readline still holds in its edit buffer —
    // the pasted final line that never fired a `line` event.
    private readonly drainResidual?: () => string | null,
    // Notified when a bracketed paste stages content, so the UI can hint that
    // text is waiting for Enter. Receives the staged draft's line count.
    private readonly onDraftChange?: (lineCount: number) => void,
  ) {}

  push(line: string): void {
    this.pending.push(line);
    // Inside a bracketed paste, endPaste() decides what happens — don't arm
    // the window (a slow, chunked paste must not send mid-stream).
    if (this.pasting) return;
    // Outside a paste, a `line` event is the user's Enter (or, on a bare
    // terminal, a pasted line); the 25ms window sends draft + collected lines.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  /** Terminal signalled the start of a bracketed paste (ESC[200~). */
  beginPaste(): void {
    this.pasting = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Terminal signalled the end of a bracketed paste (ESC[201~). */
  endPaste(): void {
    this.pasting = false;
    const residual = this.drainResidual?.();
    if (residual) this.pending.push(residual);
    // Stage the pasted block and wait for Enter rather than sending now.
    this.draft.push(...this.pending.splice(0, this.pending.length));
    this.onDraftChange?.(this.draft.length);
  }

  /** Send draft + collected lines (25ms window elapsed, or shutdown). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const residual = this.drainResidual?.();
    if (residual) this.pending.push(residual);
    const lines = [
      ...this.draft.splice(0, this.draft.length),
      ...this.pending.splice(0, this.pending.length),
    ];
    if (lines.length === 0) return;
    const text = trimOuterBlankLines(lines).join("\n");
    if (!text.trim()) return;
    this.onSubmit(text);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pasting = false;
    this.draft.length = 0;
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
