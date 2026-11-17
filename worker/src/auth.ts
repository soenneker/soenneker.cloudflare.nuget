import type { Env } from "./types";
import { HttpError } from "./http";
async function equal(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(left, right);
}
export async function authorize(request: Request, env: Env, write: boolean): Promise<boolean> {
  if (![env.READ_API_KEY, env.PUSH_API_KEY, env.INTERNAL_API_KEY].every(k => k && k.length >= 32))
    throw new HttpError(503, "Service credentials are not configured.");
  if (new Set([env.READ_API_KEY, env.PUSH_API_KEY, env.INTERNAL_API_KEY]).size !== 3)
    throw new HttpError(503, "Service credentials must be distinct.");
  let supplied = request.headers.get("X-NuGet-ApiKey") ?? "";
  const authorization = request.headers.get("Authorization") ?? "";
  if (!supplied && /^Bearer /i.test(authorization)) supplied = authorization.slice(7);
  if (!supplied && /^Basic /i.test(authorization)) {
    try { const decoded = atob(authorization.slice(6)); const colon = decoded.indexOf(":"); if (colon >= 0) supplied = decoded.slice(colon + 1); }
    catch { return false; }
  }
  const [push, read] = await Promise.all([equal(supplied, env.PUSH_API_KEY), equal(supplied, env.READ_API_KEY)]);
  return write ? push : push || read;
}
