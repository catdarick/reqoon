import { parseSpecText } from "../lib/openapi";

self.onmessage = (e: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = e.data;
  try {
    self.postMessage({ id, json: JSON.stringify(parseSpecText(text)) });
  } catch (err) {
    const { name, message } = err instanceof Error ? err : { name: "Error", message: String(err) };
    self.postMessage({ id, error: { name, message } });
  }
};
