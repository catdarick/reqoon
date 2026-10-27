import { describe, expect, it } from "vitest";
import { formatJson, formatXml, isXmlResponse } from "./format";

/** Fold pairs as [open, close], in line order. */
const pairs = (folds: Int32Array) => [...folds].flatMap((to, from) => (to ? [[from, to]] : []));

describe("formatXml", () => {
  it("indents nested elements and keeps text-only elements on one line", () => {
    const r = formatXml('<?xml version="1.0"?><a x="1"><b>hi</b><c/><d></d><e><f> text </f></e></a>')!;
    expect(r.text).toBe(
      ['<?xml version="1.0"?>', '<a x="1">', "  <b>hi</b>", "  <c/>", "  <d></d>", "  <e>", "    <f>text</f>", "  </e>", "</a>"].join("\n"),
    );
    expect(pairs(r.folds)).toEqual([
      [2, 9],
      [6, 8],
    ]);
  });

  it("drops whitespace between tags and keeps comments, CDATA and > inside attributes", () => {
    const r = formatXml('<a>\n  <!-- note -->\n  <b v="1>2"/>\n  <c><![CDATA[<raw>]]></c>\n</a>\n')!;
    expect(r.text).toBe(['<a>', "  <!-- note -->", '  <b v="1>2"/>', "  <c><![CDATA[<raw>]]></c>", "</a>"].join("\n"));
  });

  it("puts mixed content on separate lines", () => {
    expect(formatXml("<p>one <b>two</b> three</p>")!.text).toBe(["<p>", "  one", "  <b>two</b>", "  three", "</p>"].join("\n"));
  });

  it("keeps a doctype with an internal subset whole", () => {
    expect(formatXml('<!DOCTYPE a [<!ENTITY e "x">]><a/>')!.text).toBe('<!DOCTYPE a [<!ENTITY e "x">]>\n<a/>');
  });

  it("gives up on unterminated markup", () => {
    expect(formatXml("<a><b</a>")).toBeNull();
    expect(formatXml("<a><!-- open")).toBeNull();
  });
});

describe("isXmlResponse", () => {
  it("goes by content type, then by the XML declaration", () => {
    expect(isXmlResponse("text/xml; charset=utf-8", "")).toBe(true);
    expect(isXmlResponse("application/soap+xml", "")).toBe(true);
    expect(isXmlResponse("text/html", '<?xml version="1.0"?>')).toBe(false);
    expect(isXmlResponse("", ' <?xml version="1.0"?><a/>')).toBe(true);
    expect(isXmlResponse("text/plain", "<a/>")).toBe(false);
  });
});

describe("formatJson", () => {
  const same = (src: string) => expect(formatJson(src)!.text).toBe(JSON.stringify(JSON.parse(src), null, 2));

  it("matches JSON.stringify indentation", () => {
    same('{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[],"f":"x\\"y\\\\","g":{"h":[ ]}}');
    same("[ 1 , true , false , null , -2.5 ]");
    same('"just a string"');
  });

  it("keeps number text as written and records folds", () => {
    const r = formatJson('{"id":12345678901234567890,"x":[1,2]}')!;
    expect(r.text).toBe(['{', '  "id": 12345678901234567890,', '  "x": [', "    1,", "    2", "  ]", "}"].join("\n"));
    expect(pairs(r.folds)).toEqual([
      [1, 7],
      [3, 6],
    ]);
  });

  it("gives up on broken JSON", () => {
    expect(formatJson('{"a":[1}')).toBeNull();
    expect(formatJson('{"a":"x')).toBeNull();
    expect(formatJson('{"a":1')).toBeNull();
  });
});
