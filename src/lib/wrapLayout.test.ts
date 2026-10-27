import { describe, expect, it } from "vitest";
import { findAll } from "./textSearch";
import { columnLayout, identityLayout, maxLineLength, origLineEnd, origLineOfRow, rowOfOrigLine, toDisplay, toOrig } from "./wrapLayout";

describe("columnLayout", () => {
  const text = "abcdefghij\nxy\n0123456";
  const l = columnLayout(text, 4);

  it("cuts long lines into rows and remembers the original lines", () => {
    expect(l.doc.toJSON()).toEqual(["abcd", "efgh", "ij", "xy", "0123", "456"]);
    expect([...l.breaks]).toEqual([4, 8, 18]);
    expect([1, 2, 3, 4, 5, 6].map((r) => origLineOfRow(l, r))).toEqual([1, 0, 0, 2, 3, 0]);
    expect([1, 2, 3].map((n) => rowOfOrigLine(l, n))).toEqual([1, 4, 5]);
  });

  it("maps every original offset to the same character on screen and back", () => {
    const shown = l.doc.toString();
    for (let p = 0; p < text.length; p++) {
      const d = toDisplay(l, p);
      expect(shown[d]).toBe(text[p]);
      expect(toOrig(l, d)).toBe(p);
    }
    // The inserted newlines map to the original offset after them.
    expect(toOrig(l, 4)).toBe(4);
    expect(toOrig(l, l.doc.length)).toBe(text.length);
  });

  it("puts range ends at a break at the end of the previous row", () => {
    expect(toDisplay(l, 4, 1)).toBe(5);
    expect(toDisplay(l, 4, -1)).toBe(4);
    expect(origLineEnd(l, 1)).toBe(l.doc.line(3).to);
    expect(origLineEnd(l, 3)).toBe(l.doc.length);
  });

  it("keeps \\r characters, so offsets match the body", () => {
    const crlf = "a\r\nb\r\nc";
    const c = columnLayout(crlf, 10);
    expect(c.doc.toString()).toBe(crlf);
    expect(identityLayout(crlf).doc.length).toBe(crlf.length);
  });

  it("handles empty text and a trailing newline", () => {
    expect(columnLayout("", 5).doc.toJSON()).toEqual([""]);
    expect(columnLayout("abc\n", 2).doc.toJSON()).toEqual(["ab", "c", ""]);
  });
});

describe("maxLineLength", () => {
  it("measures the longest line", () => {
    expect(maxLineLength("ab\nabcd\n")).toBe(4);
    expect(maxLineLength("")).toBe(0);
  });
});

describe("findAll", () => {
  it("finds every case-insensitive match, including regex characters and non-Latin text", () => {
    const h = findAll("Price: 1.5, price 1x5, PRICE", "price");
    expect([...h.pos.subarray(0, h.n)]).toEqual([0, 12, 23]);
    expect(findAll("1.5 1x5", "1.5").n).toBe(1);
    const ru = findAll("Стандарт стандартный", "СТАНДАРТ");
    expect([...ru.pos.subarray(0, ru.n)]).toEqual([0, 9]);
    expect(findAll("abc", "").n).toBe(0);
  });

  it("keeps offsets right after characters whose lowercase is longer", () => {
    const text = "İİİ price";
    const h = findAll(text, "price");
    expect(text.slice(h.pos[0], h.pos[0] + h.len)).toBe("price");
  });

  it("grows past the initial buffer", () => {
    expect(findAll("a".repeat(5000), "a").n).toBe(5000);
  });
});
