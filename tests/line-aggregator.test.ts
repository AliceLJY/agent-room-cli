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
});
