import type { Env, PackageRow } from "./types";
import { compareVersions } from "./versions";
export async function versions(env: Env, id: string): Promise<PackageRow[]> {
  const result = await env.DB.prepare("SELECT * FROM packages WHERE id = ?").bind(id).all<PackageRow>();
  return result.results.sort((a, b) => compareVersions(a.version, b.version));
}
export async function find(env: Env, id: string, version: string): Promise<PackageRow | null> {
  return env.DB.prepare("SELECT * FROM packages WHERE id = ? AND version = ?").bind(id, version).first<PackageRow>();
}
export async function recoverUploads(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // Claims expire before R2 deletion. Finalization requires an unexpired claim.
  const stale = await env.DB.prepare("SELECT object_key FROM uploads WHERE created < ? LIMIT 100").bind(cutoff).all<{ object_key: string }>();
  for (const row of stale.results) {
    await env.DB.prepare("UPDATE uploads SET expired = 1 WHERE object_key = ? AND created < ?").bind(row.object_key, cutoff).run();
    const referenced = await env.DB.prepare("SELECT 1 FROM packages WHERE object_key = ?").bind(row.object_key).first();
    if (!referenced) await env.PACKAGES.delete([row.object_key, row.object_key + ".nuspec"]);
    await env.DB.prepare("DELETE FROM uploads WHERE object_key = ?").bind(row.object_key).run();
  }
}
