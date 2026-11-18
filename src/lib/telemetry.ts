/** Metrics and crash reports must never include customer-link credentials. */
export function diagnosticUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const path = url.pathname
      .replace(/(\/api\/customers\/link\/)[^/]+/gi, "$1[redacted]")
      .replace(/(\/media\/customers\/)[^/]+/gi, "$1[image]");
    return url.origin + path;
  } catch {
    return null;
  }
}
