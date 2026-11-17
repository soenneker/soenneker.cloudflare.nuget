import { HttpError } from "./http";
export function normalizeId(id: string): string {
  if (!/^[a-z0-9_][a-z0-9_.-]{0,99}$/i.test(id)) throw new HttpError(400, "Invalid package ID.");
  return id.toLowerCase();
}
export function normalizeVersion(version: string): string {
  if (version.length > 256 || !/^\d+(?:\.\d+){0,3}(?:-[a-z0-9-]+(?:\.[a-z0-9-]+)*)?(?:\+[a-z0-9.-]+)?$/i.test(version))
    throw new HttpError(400, "Invalid package version.");
  const clean = version.toLowerCase().split("+")[0];
  const dash = clean.indexOf("-"); const core = (dash < 0 ? clean : clean.slice(0, dash)).split(".").map(Number);
  if (core.some(n => n > 2147483647)) throw new HttpError(400, "Invalid package version.");
  while (core.length < 3) core.push(0);
  if (core.length === 4 && core[3] === 0) core.pop();
  return core.join(".") + (dash < 0 ? "" : clean.slice(dash));
}
export function compareVersions(a: string, b: string): number {
  const split = (s: string) => { const i = s.indexOf("-"); return [i < 0 ? s : s.slice(0, i), i < 0 ? "" : s.slice(i + 1)]; };
  const [ac, ar] = split(a), [bc, br] = split(b);
  const an = ac.split(".").map(Number), bn = bc.split(".").map(Number);
  for (let i = 0; i < 4; i++) { const diff = (an[i] ?? 0) - (bn[i] ?? 0); if (diff) return diff; }
  if (!ar || !br) return ar ? -1 : br ? 1 : 0;
  const ap = ar.split("."), bp = br.split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1; if (bp[i] === undefined) return 1;
    const x = ap[i], y = bp[i], xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { const d = BigInt(x) - BigInt(y); if (d) return d < 0n ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
