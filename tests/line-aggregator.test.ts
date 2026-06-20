import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineAggregator } from "../src/line-aggregator.js";

describe("LineAggregator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits a single typed line after the window", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25);
    agg.push("hello room");
    expect(out).toEqual([]);
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["hello room"]);
  });

  it("merges a burst of pasted lines into one multi-line submission", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25);
    agg.push("line one");
    vi.advanceTimersByTime(2);
    agg.push("  indented line two");
    vi.advanceTimersByTime(2);
    agg.push("line three");
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["line one\n  indented line two\nline three"]);
  });

  it("keeps interior blank lines and indentation verbatim", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25);
    agg.push("function f() {");
    agg.push("    return 1;");
    agg.push("");
    agg.push("}");
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["function f() {\n    return 1;\n\n}"]);
  });

  it("strips leading/trailing blank lines only", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25);
    agg.push("");
    agg.push("body");
    agg.push("   ");
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["body"]);
  });

  it("treats slow consecutive lines as separate submissions", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25);
    agg.push("first");
    vi.advanceTimersByTime(200);
    agg.push("second");
    vi.advanceTimersByTime(200);
    expect(out).toEqual(["first", "second"]);
  });

  it("drops whitespace-only submissions", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25);
    agg.push("   ");
    vi.advanceTimersByTime(25);
    expect(out).toEqual([]);
  });

  it("flush() submits pending lines immediately", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25);
    agg.push("/exit");
    agg.flush();
    expect(out).toEqual(["/exit"]);
    vi.advanceTimersByTime(50);
    expect(out).toEqual(["/exit"]);
  });

  it("appends a readline residual tail (pasted last line without a newline)", () => {
    const out: string[] = [];
    // The pasted final line never fired a `line` event; it comes back via the
    // residual hook so the whole paste is submitted as one message.
    const agg = new LineAggregator((t) => out.push(t), 25, () => "gamma");
    agg.push("alpha");
    agg.push("beta");
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["alpha\nbeta\ngamma"]);
  });

  it("keeps prior behavior when there is no residual tail", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25, () => null);
    agg.push("alpha");
    agg.push("beta");
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["alpha\nbeta"]);
  });

  it("strips a whitespace-only residual tail", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25, () => "   ");
    agg.push("alpha");
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["alpha"]);
  });

  it("bracketed paste stages the block and sends only on Enter", () => {
    const out: string[] = [];
    // drainResidual is one-shot in real life (it clears readline's buffer),
    // so model that: the tail comes back once, then it's gone.
    let tail: string | null = "末行";
    const agg = new LineAggregator((t) => out.push(t), 25, () => {
      const v = tail;
      tail = null;
      return v;
    });
    agg.beginPaste();
    agg.push("行一");
    agg.push("行二");
    agg.endPaste(); // staged, NOT sent
    vi.advanceTimersByTime(200);
    expect(out).toEqual([]); // paste end alone does not send
    agg.push(""); // user presses Enter (a `line` event outside the paste)
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["行一\n行二\n末行"]);
  });

  it("stays whole across slow chunked delivery, still only sends on Enter", () => {
    const out: string[] = [];
    const agg = new LineAggregator((t) => out.push(t), 25, () => null);
    agg.beginPaste();
    agg.push("行一");
    vi.advanceTimersByTime(100); // chunk gap >> 25ms window
    agg.push("行二");
    vi.advanceTimersByTime(100);
    agg.push("行三");
    agg.endPaste();
    vi.advanceTimersByTime(200);
    expect(out).toEqual([]); // still staged, not split, not sent
    agg.push(""); // Enter
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["行一\n行二\n行三"]);
  });

  it("accumulates several pastes into one message on Enter", () => {
    const out: string[] = [];
    let tail = "甲三末";
    const agg = new LineAggregator((t) => out.push(t), 25, () => {
      const v = tail;
      tail = "";
      return v;
    });
    agg.beginPaste();
    agg.push("甲一");
    agg.push("甲二");
    agg.endPaste();
    tail = "乙二末";
    agg.beginPaste();
    agg.push("乙一");
    agg.endPaste();
    vi.advanceTimersByTime(200);
    expect(out).toEqual([]); // nothing sent until Enter
    agg.push(""); // Enter
    vi.advanceTimersByTime(25);
    expect(out).toEqual(["甲一\n甲二\n甲三末\n乙一\n乙二末"]);
  });

  it("reports staged line count via onDraftChange", () => {
    const out: string[] = [];
    const counts: number[] = [];
    const agg = new LineAggregator(
      (t) => out.push(t),
      25,
      () => null,
      (n) => counts.push(n),
    );
    agg.beginPaste();
    agg.push("a");
    agg.push("b");
    agg.endPaste();
    expect(counts).toEqual([2]);
    agg.beginPaste();
    agg.push("c");
    agg.endPaste();
    expect(counts).toEqual([2, 3]); // accumulates across pastes
  });
});
