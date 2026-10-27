import { Fragment, ReactNode, useMemo } from "react";
import { markdownToHtml } from "../lib/markdown";

// Tags kept as they are; anything else (script, img, iframe, style, unknown) keeps only its text.
const KEEP = new Set(["p", "br", "strong", "b", "em", "i", "code", "pre", "ul", "ol", "li", "blockquote", "h4", "table", "thead", "tbody", "tr", "th", "td"]);
const RENAME: Record<string, string> = { h1: "h4", h2: "h4", h3: "h4", h5: "h4", h6: "h4", tt: "code", kbd: "code" };
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript"]);

function convert(node: Node, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag)) return null;
  const children = [...el.childNodes].map(convert);
  if (tag === "a") {
    // Links stay text: navigating would replace the app, and relative URLs point nowhere here.
    const href = el.getAttribute("href") ?? "";
    return (
      <span key={key} className="md-link" title={href}>
        {children}
      </span>
    );
  }
  const name = RENAME[tag] ?? tag;
  if (!KEEP.has(name)) return <Fragment key={key}>{children}</Fragment>;
  if (name === "p" && !el.textContent?.trim()) return null;
  const Tag = name as keyof JSX.IntrinsicElements;
  return name === "br" ? <br key={key} /> : <Tag key={key}>{children}</Tag>;
}

/** Renders an OpenAPI description (Markdown with optional HTML) without injecting markup. */
export default function Markdown({ text, className }: { text: string; className?: string }) {
  const nodes = useMemo(() => {
    const doc = new DOMParser().parseFromString(markdownToHtml(text), "text/html");
    return [...doc.body.childNodes].map(convert);
  }, [text]);
  return <div className={`md ${className ?? ""}`}>{nodes}</div>;
}
