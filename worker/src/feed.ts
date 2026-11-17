import type { Env, PackageMetadata, PackageRow } from "./types";
import { HttpError, integer } from "./http";
import { versions, find } from "./storage";
export function baseUrl(env: Env): string {
  const url = new URL(env.PUBLIC_URL);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    throw new HttpError(503, "PUBLIC_URL must use HTTPS.");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new HttpError(503, "PUBLIC_URL must be an origin.");
  return url.origin;
}
const contentUrl = (base: string, p: PackageRow) => `${base}/v3-flatcontainer/${p.id}/${p.version}/${p.id}.${p.version}.nupkg`;
const leafUrl = (base: string, p: PackageRow) => `${base}/v3/registration/${p.id}/${p.version}.json`;
export function serviceIndex(env: Env): Response {
  const base = baseUrl(env);
  return Response.json({ version: "3.0.0", resources: [
    { "@id": `${base}/v3-flatcontainer/`, "@type": "PackageBaseAddress/3.0.0" },
    { "@id": `${base}/v3/registration/`, "@type": "RegistrationsBaseUrl/3.6.0" },
    { "@id": `${base}/v3/query`, "@type": "SearchQueryService" },
    { "@id": `${base}/v3/autocomplete`, "@type": "SearchAutocompleteService" },
    { "@id": `${base}/api/v2/package`, "@type": "PackagePublish/2.0.0" }
  ] });
}
export async function flatIndex(env: Env, id: string): Promise<Response> {
  const rows = await versions(env, id);
  if (!rows.length) throw new HttpError(404, "Package not found.");
  return Response.json({ versions: rows.map(r => r.version) });
}
export async function content(request: Request, env: Env, id: string, version: string, file: string): Promise<Response> {
  const row = await find(env, id, version); if (!row) throw new HttpError(404, "Package not found.");
  const metadata = JSON.parse(row.metadata) as PackageMetadata;
  if (file === `${id}.nuspec`) {
    const nuspec = await env.PACKAGES.get(row.object_key + ".nuspec");
    if (!nuspec) throw new HttpError(503, "Package manifest is temporarily unavailable.");
    return new Response(nuspec.body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
  }
  if (file === `${id}.${version}.nupkg.sha512`) return new Response(metadata.sha512, { headers: { "Content-Type": "text/plain" } });
  if (file !== `${id}.${version}.nupkg`) throw new HttpError(404, "File not found.");
  const object = request.method === "HEAD" ? await env.PACKAGES.head(row.object_key) : await env.PACKAGES.get(row.object_key);
  if (!object) throw new HttpError(503, "Package content is temporarily unavailable.");
  const headers = new Headers({ "Content-Type": "application/octet-stream", "Content-Length": String(object.size), ETag: object.httpEtag,
    "Content-Disposition": `attachment; filename="${id}.${version}.nupkg"` });
  if (request.headers.get("If-None-Match")?.split(",").map(s => s.trim()).some(s => s === object.httpEtag || s === "*"))
    return new Response(null, { status: 304, headers: { ETag: object.httpEtag } });
  return new Response("body" in object ? (object as R2ObjectBody).body : null, { headers });
}
function leaf(base: string, row: PackageRow) {
  const m = JSON.parse(row.metadata) as PackageMetadata;
  return { "@id": leafUrl(base, row), packageContent: contentUrl(base, row), catalogEntry: {
    "@id": `${leafUrl(base, row)}#catalog`, id: m.id, version: row.version, description: m.description, authors: m.authors.join(", "),
    tags: m.tags, title: m.title, projectUrl: m.projectUrl, licenseExpression: m.licenseExpression, requireLicenseAcceptance: m.requireLicenseAcceptance,
    listed: !!row.listed, published: row.published, packageContent: contentUrl(base, row),
    dependencyGroups: m.dependencyGroups.map(g => ({ targetFramework: g.targetFramework, dependencies: g.dependencies.map(d => ({
      id: d.id, range: d.range, registration: `${base}/v3/registration/${d.id.toLowerCase()}/index.json`
    })) }))
  } };
}
export async function registration(env: Env, id: string, version?: string): Promise<Response> {
  const base = baseUrl(env);
  if (version) {
    const row = await find(env, id, version); if (!row) throw new HttpError(404, "Package not found.");
    return gzipJson({ "@id": leafUrl(base, row), listed: !!row.listed, published: row.published,
      packageContent: contentUrl(base, row), registration: `${base}/v3/registration/${id}/index.json` });
  }
  const rows = await versions(env, id); if (!rows.length) throw new HttpError(404, "Package not found.");
  const items = [];
  for (let i = 0; i < rows.length; i += 64) {
    const page = rows.slice(i, i + 64);
    items.push({ "@id": `${base}/v3/registration/${id}/index.json#page/${i / 64}`, count: page.length,
      lower: page[0].version, upper: page.at(-1)!.version, items: page.map(r => leaf(base, r)) });
  }
  return gzipJson({ "@id": `${base}/v3/registration/${id}/index.json`, count: items.length, items });
}
function gzipJson(value: unknown): Response {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream, { headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } });
}
export async function search(url: URL, env: Env, autocomplete: boolean): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  if (q.length > 256) throw new HttpError(400, "Search query is too long.");
  const take = integer(url.searchParams.get("take"), 20, 100), skip = integer(url.searchParams.get("skip"), 0, 10000);
  const pre = url.searchParams.get("prerelease") === "true", semver2 = url.searchParams.get("semVerLevel") === "2.0.0";
  const visible = (r: PackageRow) => !!r.listed && (pre || !r.prerelease) && (semver2 || !r.semver2);
  if (autocomplete && url.searchParams.has("id")) {
    const { normalizeId } = await import("./versions");
    const rows = (await versions(env, normalizeId(url.searchParams.get("id")!))).filter(visible);
    return Response.json({ totalHits: rows.length, data: rows.slice(skip, skip + take).map(r => r.version) });
  }
  const where = "listed = 1 AND (? = 1 OR prerelease = 0) AND (? = 1 OR semver2 = 0) AND instr(search_text, ?) > 0";
  const count = await env.DB.prepare(`SELECT COUNT(DISTINCT id) AS total FROM packages WHERE ${where}`).bind(+pre, +semver2, q).first<{ total: number }>();
  const ids = await env.DB.prepare(`SELECT DISTINCT id FROM packages WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).bind(+pre, +semver2, q, take, skip).all<{ id: string }>();
  const base = baseUrl(env);
  const data = await Promise.all(ids.results.map(async ({ id }) => {
    if (autocomplete) return id;
    const rows = (await versions(env, id)).filter(visible); const row = rows.at(-1)!;
    const m = JSON.parse(row.metadata) as PackageMetadata;
    return { "@id": `${base}/v3/registration/${id}/index.json`, id: m.id, version: row.version, description: m.description,
      title: m.title, authors: m.authors, tags: m.tags, projectUrl: m.projectUrl, totalDownloads: 0, verified: false,
      versions: rows.map(r => ({ version: r.version, downloads: 0, "@id": leafUrl(base, r) })) };
  }));
  return Response.json({ totalHits: count?.total ?? 0, data });
}
