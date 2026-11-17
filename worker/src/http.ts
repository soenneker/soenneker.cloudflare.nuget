export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function problem(status: number, title: string): Response {
  return Response.json({ status, title }, { status, headers: { "Content-Type": "application/problem+json" } });
}
export async function boundedBody(request: Request, limit: number): Promise<ArrayBuffer> {
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > limit) throw new HttpError(413, "Package exceeds 32 MiB.");
  if (!request.body) throw new HttpError(400, "Package body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, "Package exceeds 32 MiB."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}
export function integer(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
    throw new HttpError(400, "Invalid pagination parameter.");
  return Number(value);
}
