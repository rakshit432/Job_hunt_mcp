import { describe, it, expect } from "vitest";
import { fillTemplate, cleanLine, buildIntro } from "../src/services/templating.js";

describe("templating", () => {
  it("fills placeholders and splits subject and body", () => {
    const out = fillTemplate("Subject: Hi {x}\n\nBody {x}", { x: "Z" });
    expect(out).toEqual({ subject: "Hi Z", body: "Body Z" });
  });

  it("fails when a placeholder has no value", () => {
    expect(() => fillTemplate("Subject: {x}\n\nB", {})).toThrow(/no value/);
  });

  it("collapses whitespace, caps length and drops trailing period", () => {
    expect(cleanLine("a\n\n  b.", 10)).toBe("a b");
    expect(cleanLine("abcdef", 3)).toBe("abc");
  });

  it("builds the full intro with focus and observation", () => {
    expect(buildIntro("Acme", "Seed", "clinic scheduling.", "the simple UX")).toBe(
      "I came across Acme and found your work on clinic scheduling interesting. I particularly liked the simple UX."
    );
  });

  it("builds a shorter intro with focus only", () => {
    expect(buildIntro("Acme", null, "clinic scheduling")).toBe(
      "I came across Acme and found your work on clinic scheduling interesting."
    );
  });

  it("falls back to a generic intro", () => {
    expect(buildIntro("Acme", "Seed")).toBe(
      "I came across Acme after your Seed announcement and was interested in what you're building."
    );
  });
});

