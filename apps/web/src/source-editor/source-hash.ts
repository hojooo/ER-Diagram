const utf8Encoder = new TextEncoder();

export async function hashDbmlSource(source: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", utf8Encoder.encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
