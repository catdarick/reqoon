import { describe, expect, it } from "vitest";
import { markdownToHtml, markdownToText } from "./markdown";

describe("descriptions", () => {
  it("renders the Markdown subset specs use", () => {
    expect(markdownToHtml("Use **bold**, *em* and `a<b>`.\n\n- one\n- two `x`")).toBe(
      "<p>Use <strong>bold</strong>, <em>em</em> and <code>a&lt;b&gt;</code>.</p><ul><li>one</li><li>two <code>x</code></li></ul>",
    );
    expect(markdownToHtml("See [docs](https://x.dev/a_b_c).")).toBe('<p>See <a href="https://x.dev/a_b_c">docs</a>.</p>');
    expect(markdownToHtml("```\n<tag> **not bold**\n```")).toBe("<pre><code>&lt;tag&gt; **not bold**</code></pre>");
    expect(markdownToHtml("## Title\ntext")).toBe("<h4>Title</h4><p>text</p>");
  });
  it("passes HTML through for the renderer and leaves snake_case alone", () => {
    const stripe = '<p>Updating the <code>payment_method</code> needs the <a href="/docs/api/payment_intents/confirm">confirm API</a>.</p>';
    expect(markdownToHtml(stripe)).toBe(`<p>${stripe}</p>`);
  });
  it("gives plain text for tooltips", () => {
    expect(markdownToText("<p>Updates a <code>PaymentIntent</code> &amp; more.</p>\n\n<p>Second</p>")).toBe(
      "Updates a PaymentIntent & more.\n\nSecond",
    );
    expect(markdownToText("Use **bold** and [docs](https://x)")).toBe("Use bold and docs");
  });
  it("keeps <placeholders> that aren't HTML tags as text", () => {
    const stripe = "Allowed headers-- Authorization: Basic <api_key> | Authorization: Basic <base64 hash of `api_key:`>";
    expect(markdownToHtml(stripe)).toBe(
      "<p>Allowed headers-- Authorization: Basic &lt;api_key> | Authorization: Basic &lt;base64 hash of <code>api_key:</code>></p>",
    );
    expect(markdownToText(stripe)).toBe("Allowed headers-- Authorization: Basic <api_key> | Authorization: Basic <base64 hash of api_key:>");
    expect(markdownToHtml("Use <b>bold</b> and <id>")).toBe("<p>Use <b>bold</b> and &lt;id></p>");
  });
});
