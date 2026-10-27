// OpenAPI descriptions are CommonMark, which allows raw HTML; specs use both (Stripe writes HTML,
// most others Markdown). This covers the subset descriptions actually use: paragraphs, lists,
// headings, fenced code, `code`, **bold**, *emphasis* and [links](url). The result is HTML that
// the Markdown component turns into React elements through a tag whitelist; it is never injected.

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Element names treated as HTML. Anything else in angle brackets is a placeholder meant as text
// ("Authorization: Basic <api_key>"), which a parser would otherwise swallow as an unknown tag.
const HTML_TAGS = new Set(
  ("a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre " +
    "s samp section small span strong sub summary sup table tbody td th thead tr tt u ul var " +
    "script style iframe object embed template noscript").split(" "),
);
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;

function isHtmlTag(s: string, at = 0): RegExpExecArray | null {
  TAG.lastIndex = at;
  const m = TAG.exec(s);
  return m && HTML_TAGS.has(m[2].toLowerCase()) ? m : null;
}

/** Escapes every "<" that doesn't open a real HTML tag or comment. */
function escapeStrayAngles(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "<") {
      out += s[i];
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      if (end >= 0) {
        i = end + 2; // comments are dropped
        continue;
      }
    }
    const m = isHtmlTag(s, i);
    if (m) {
      out += m[0];
      i += m[0].length - 1;
    } else out += "&lt;";
  }
  return out;
}

function inline(s: string): string {
  const code: string[] = [];
  // Code spans first, so their contents are left alone by the other rules.
  let out = s.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${code.push(escapeHtml(c)) - 1}\u0000`);
  out = out
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>");
  return escapeStrayAngles(out).replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[Number(i)]}</code>`);
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

export function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join("\n"))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(`<h4>${inline(heading[1])}</h4>`);
      continue;
    }
    if (LIST_ITEM.test(line) && !para.length) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && lines[i].trim(); i++) {
        if (LIST_ITEM.test(lines[i])) items.push(lines[i].replace(LIST_ITEM, ""));
        else if (items.length) items[items.length - 1] += "\n" + lines[i].trim(); // continuation line
      }
      i--;
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join("");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text for tooltips and one-line previews. */
export function markdownToText(src: string): string {
  return src
    .replace(/<\/(p|li|h\d|pre|div)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, (m) => (isHtmlTag(m) ? "" : m))
    .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\[([^\]\n]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a, b) => a ?? b)
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
