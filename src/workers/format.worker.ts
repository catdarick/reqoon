import { FormatKind, formatText } from "../lib/format";

self.onmessage = (e: MessageEvent<{ id: number; kind: FormatKind; text: string }>) => {
  const result = formatText(e.data.kind, e.data.text);
  // The fold table moves without a copy; the text is copied, which is cheaper than decoding on the page.
  (self as unknown as Worker).postMessage({ id: e.data.id, result }, result ? [result.folds.buffer] : []);
};
