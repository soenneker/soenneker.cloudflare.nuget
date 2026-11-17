import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "./types";
import { authorize } from "./auth";
import { HttpError, problem } from "./http";
import { publish, setListed } from "./publish";
import { normalizeId, normalizeVersion } from "./versions";
import { serviceIndex, flatIndex, content, registration, search } from "./feed";
import { recoverUploads } from "./storage";
export class NuGetContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = { NuGet__InternalApiKey: this.env.INTERNAL_API_KEY };
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), method = request.method, read = method === "GET" || method === "HEAD";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (url.pathname === "/health" && read) return Response.json({ ready: true });
  if (!await authorize(request, env, !read)) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="NuGet"' } });
  if (url.pathname === "/ready" && read) {
    await env.DB.prepare("SELECT 1 FROM packages LIMIT 1").all();
    await env.PACKAGES.head("readiness");
    const response = await getContainer(env.INSPECTOR, "inspector").fetch(new Request("http://container/health", {
      headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` }, signal: AbortSignal.timeout(90000)
    }));
    if (!response.ok) throw new HttpError(503, "Package inspector is unavailable.");
    return Response.json({ ready: true });
  }
  if (url.pathname === "/v3/index.json" && read) return serviceIndex(env);
  if (url.pathname === "/v3/query" && read) return search(url, env, false);
  if (url.pathname === "/v3/autocomplete" && read) return search(url, env, true);
  if (url.pathname === "/api/v2/package" && method === "PUT") return publish(request, env);
  let match = /^\/api\/v2\/package\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (match && (method === "DELETE" || method === "POST")) return setListed(env, normalizeId(match[1]), normalizeVersion(match[2]), method === "POST");
  match = /^\/v3-flatcontainer\/([^/]+)\/index.json$/.exec(url.pathname);
  if (match && read) return flatIndex(env, normalizeId(match[1]));
  match = /^\/v3-flatcontainer\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (match && read) return content(request, env, normalizeId(match[1]), normalizeVersion(match[2]), match[3].toLowerCase());
  match = /^\/v3\/registration\/([^/]+)\/([^/]+)\.json$/.exec(url.pathname);
  if (match && read) return registration(env, normalizeId(match[1]), match[2] === "index" ? undefined : normalizeVersion(match[2]));
  return problem(404, "Endpoint not found.");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) response = problem(error.status, error.message);
      else { console.error(JSON.stringify({ event: "request_failed", error: error instanceof Error ? error.name : "Unknown" })); response = problem(503, "NuGet service temporarily unavailable."); }
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store"); headers.set("X-Content-Type-Options", "nosniff");
    if (response.status === 503) headers.set("Retry-After", "10");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { await recoverUploads(env); }
} satisfies ExportedHandler<Env>;
