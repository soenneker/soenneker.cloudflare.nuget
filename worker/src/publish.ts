import { getContainer } from "@cloudflare/containers";
import type { Env, PackageMetadata } from "./types";
import { boundedBody, HttpError } from "./http";
import { find } from "./storage";
import { normalizeId, normalizeVersion } from "./versions";
export type Inspect = (bytes: ArrayBuffer, env: Env) => Promise<PackageMetadata>;
export const inspect: Inspect = async (bytes, env) => {
  const response = await getContainer(env.INSPECTOR, "inspector").fetch(new Request("http://container/inspect", {
    method: "POST", headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}`, "Content-Type": "application/octet-stream" },
    body: bytes, signal: AbortSignal.timeout(90000)
  }));
  if (response.status === 400 || response.status === 413) throw new HttpError(response.status, "Invalid or oversized NuGet package.");
  if (!response.ok) throw new HttpError(503, "Package inspector is unavailable.");
  return response.json<PackageMetadata>();
};
export async function publish(request: Request, env: Env, inspectPackage: Inspect = inspect): Promise<Response> {
  const maximum = 32 * 1024 * 1024;
  let bytes = await boundedBody(request, maximum + 64 * 1024);
  const type = request.headers.get("Content-Type") ?? "";
  if (type.toLowerCase().startsWith("multipart/form-data")) {
    bytes = firstMultipartPart(bytes, type);
  }
  if (!bytes.byteLength || bytes.byteLength > maximum) throw new HttpError(413, "Package must be between 1 byte and 32 MiB.");
  const metadata = await inspectPackage(bytes, env);
  const id = normalizeId(metadata.id), version = normalizeVersion(metadata.version);
  if (await find(env, id, version)) throw new HttpError(409, "Package ID and version already exist.");
  // Every push owns a unique object; losing concurrent pushes can never overwrite committed content.
  const key = `packages/${id}/${version}/${crypto.randomUUID()}.nupkg`;
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO uploads(object_key, created) VALUES (?, ?)").bind(key, now).run();
  await env.PACKAGES.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  await env.PACKAGES.put(key + ".nuspec", metadata.nuspec, { httpMetadata: { contentType: "application/xml; charset=utf-8" } });
  const { nuspec: _nuspec, ...catalog } = metadata;
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO packages(id, version, object_key, metadata, prerelease, semver2, published, search_text)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uploads WHERE object_key = ? AND expired = 0)
      ON CONFLICT(id, version) DO NOTHING`).bind(id, version, key, JSON.stringify(catalog), +metadata.prerelease, +metadata.semVer2,
        now, [id, metadata.title, metadata.description, ...metadata.tags].join(" ").toLowerCase(), key),
    env.DB.prepare("DELETE FROM uploads WHERE object_key = ? AND EXISTS (SELECT 1 FROM packages WHERE object_key = ?)").bind(key, key)
  ]);
  if (result[0].meta.changes === 0) {
    await env.PACKAGES.delete([key, key + ".nuspec"]);
    await env.DB.prepare("DELETE FROM uploads WHERE object_key = ?").bind(key).run();
    throw new HttpError(409, "Package already exists or the upload expired; retry if necessary.");
  }
  return new Response(null, { status: 201 });
}
export async function setListed(env: Env, id: string, version: string, listed: boolean): Promise<Response> {
  const result = await env.DB.prepare("UPDATE packages SET listed = ? WHERE id = ? AND version = ?").bind(+listed, id, version).run();
  if (result.meta.changes === 0) throw new HttpError(404, "Package not found.");
  return new Response(null, { status: 204 });
}

function firstMultipartPart(body: ArrayBuffer, contentType: string): ArrayBuffer {
  const match = /(?:^|;)\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70) throw new HttpError(400, "Invalid multipart boundary.");
  const bytes = new Uint8Array(body), encoder = new TextEncoder();
  const find = (needle: Uint8Array, from: number) => {
    outer: for (let i = from; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  const opening = encoder.encode(`--${boundary}\r\n`), first = find(opening, 0);
  if (first < 0 || first > 1024) throw new HttpError(400, "Invalid multipart body.");
  const headersEnd = find(encoder.encode("\r\n\r\n"), first + opening.length);
  if (headersEnd < 0 || headersEnd - first > 16384) throw new HttpError(400, "Invalid multipart headers.");
  const marker = encoder.encode(`\r\n--${boundary}`), start = headersEnd + 4;
  let end = find(marker, start);
  while (end >= 0) {
    const after = end + marker.length;
    if ((bytes[after] === 45 && bytes[after + 1] === 45) || (bytes[after] === 13 && bytes[after + 1] === 10))
      return body.slice(start, end);
    end = find(marker, end + 1);
  }
  throw new HttpError(400, "Incomplete multipart body.");
}
