import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import schema from "../migrations/0001_packages.sql?raw";
import worker from "../src/index";
import { publish } from "../src/publish";
import { recoverUploads } from "../src/storage";
import { normalizeVersion, compareVersions } from "../src/versions";
import type { Env, PackageMetadata } from "../src/types";
const bindings = env as unknown as Env;
const bytes = new TextEncoder().encode("immutable package content");
function metadata(version = "1.0.0"): PackageMetadata {
  return { id: "Example.Package", version, description: "Test package", authors: ["Tester"], tags: ["test"],
    requireLicenseAcceptance: false, prerelease: version.includes("-"), semVer2: version.includes("alpha."),
    sha512: "digest", nuspec: "<package />", dependencyGroups: [{ targetFramework: "net11.0", dependencies: [{ id: "Dependency", range: "[1.0.0, )" }] }] };
}
function request(path: string, method = "GET", key = bindings.READ_API_KEY): Request {
  return new Request(`https://nuget.test${path}`, { method, headers: { Authorization: `Bearer ${key}` } });
}
async function push(version = "1.0.0", payload = bytes): Promise<Response> {
  return publish(new Request("https://nuget.test/api/v2/package", { method: "PUT", body: payload }), bindings, async () => metadata(version));
}
async function json(response: Response): Promise<any> { return response.json(); }
beforeEach(async () => {
  await bindings.DB.exec("DROP TABLE IF EXISTS packages; DROP TABLE IF EXISTS uploads;");
  for (const sql of schema.split(";").filter(x => x.trim())) await bindings.DB.prepare(sql).run();
  const objects = await bindings.PACKAGES.list(); if (objects.objects.length) await bindings.PACKAGES.delete(objects.objects.map(x => x.key));
});
describe("NuGet protocol with local D1 and R2", () => {
  it("requires credentials for all feed data and refuses read-key writes", async () => {
    expect((await worker.fetch(new Request("https://nuget.test/v3/index.json"), bindings)).status).toBe(401);
    expect((await worker.fetch(request("/api/v2/package", "PUT"), bindings)).status).toBe(401);
    expect((await worker.fetch(new Request("https://nuget.test/health"), bindings)).status).toBe(200);
    const basic = new Request("https://nuget.test/v3/index.json", { headers: { Authorization: `Basic ${btoa(`user:${bindings.READ_API_KEY}`)}` } });
    expect((await worker.fetch(basic, bindings)).status).toBe(200);
    expect((await worker.fetch(request("/v3/index.json"), { ...bindings, PUSH_API_KEY: "" })).status).toBe(503);
  });
  it("advertises the configured origin, not a request-controlled hostname", async () => {
    const response = await worker.fetch(new Request("https://attacker.test/v3/index.json", { headers: request("/").headers }), bindings);
    expect((await json(response)).resources.every((r: any) => r["@id"].startsWith("https://nuget.test/"))).toBe(true);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("persists a push, returns versions, downloads bytes and exposes dependency metadata", async () => {
    expect((await push()).status).toBe(201);
    expect(await json(await worker.fetch(request("/v3-flatcontainer/example.package/index.json"), bindings))).toEqual({ versions: ["1.0.0"] });
    const download = await worker.fetch(request("/v3-flatcontainer/example.package/1.0.0/example.package.1.0.0.nupkg"), bindings);
    expect(await download.text()).toBe("immutable package content");
    const registration = await worker.fetch(request("/v3/registration/example.package/index.json"), bindings);
    const text = await new Response(registration.body!.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(text).items[0].items[0].catalogEntry.dependencyGroups[0].dependencies[0].id).toBe("Dependency");
    const head = await worker.fetch(request("/v3-flatcontainer/example.package/1.0.0/example.package.1.0.0.nupkg", "HEAD"), bindings);
    expect(await head.text()).toBe(""); expect(head.headers.get("Content-Length")).toBe(String(bytes.length));
  });
  it("preserves the first package when simultaneous pushes race", async () => {
    const result = await Promise.allSettled([push(), push("1.0.0", new TextEncoder().encode("different"))]);
    expect(result.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const rejection = result.find(x => x.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.status).toBe(409);
    expect((await bindings.DB.prepare("SELECT * FROM packages").all()).results).toHaveLength(1);
    expect((await bindings.PACKAGES.list()).objects).toHaveLength(2);
  });
  it("unlists without breaking restores and permits relisting", async () => {
    await push();
    const path = "/api/v2/package/Example.Package/1.0.0";
    expect((await worker.fetch(request(path, "DELETE", bindings.PUSH_API_KEY), bindings)).status).toBe(204);
    expect((await json(await worker.fetch(request("/v3/query"), bindings))).totalHits).toBe(0);
    expect((await worker.fetch(request("/v3-flatcontainer/example.package/1.0.0/example.package.1.0.0.nupkg"), bindings)).status).toBe(200);
    await expect(push()).rejects.toMatchObject({ status: 409 });
    expect((await worker.fetch(request(path, "POST", bindings.PUSH_API_KEY), bindings)).status).toBe(204);
    expect((await json(await worker.fetch(request("/v3/query"), bindings))).totalHits).toBe(1);
  });
  it("sorts NuGet versions semantically and honors prerelease and SemVer2 search filters", async () => {
    for (const version of ["1.0.0", "10.0.0", "2.0.0", "11.0.0-alpha.2", "11.0.0-alpha.10"]) await push(version);
    const index = await json(await worker.fetch(request("/v3-flatcontainer/example.package/index.json"), bindings));
    expect(index.versions).toEqual(["1.0.0", "2.0.0", "10.0.0", "11.0.0-alpha.2", "11.0.0-alpha.10"]);
    expect((await json(await worker.fetch(request("/v3/query"), bindings))).data[0].version).toBe("10.0.0");
    expect((await json(await worker.fetch(request("/v3/query?prerelease=true&semVerLevel=2.0.0"), bindings))).data[0].version).toBe("11.0.0-alpha.10");
    expect((await worker.fetch(request("/v3/query?take=-1"), bindings)).status).toBe(400);
    expect(normalizeVersion("01.2.0.0+build")).toBe("1.2.0");
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
  });
  it("accepts NuGet multipart pushes and rejects malformed or oversized bodies before inspection", async () => {
    const data = new FormData(); data.append("package", new Blob([bytes]), "Example.nupkg");
    const inspect = vi.fn(async () => metadata());
    expect((await publish(new Request("https://nuget.test/api/v2/package", { method: "PUT", body: data }), bindings, inspect)).status).toBe(201);
    expect(new Uint8Array(inspect.mock.calls[0][0])).toEqual(bytes);
    await expect(publish(new Request("https://nuget.test/api/v2/package", { method: "PUT", body: bytes, headers: { "Content-Length": "999999999" } }), bindings, inspect)).rejects.toMatchObject({ status: 413 });
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it("accepts filename-less multipart without corrupting binary bytes", async () => {
    const payload = new Uint8Array([0, 255, 128, 13, 10, 1]);
    const body = new Blob(["--boundary\r\nContent-Disposition: form-data; name=package\r\n\r\n", payload, "\r\n--boundary--\r\n"]);
    let received: ArrayBuffer | undefined;
    const response = await publish(new Request("https://nuget.test/api/v2/package/", { method: "PUT", body,
      headers: { "Content-Type": "multipart/form-data; boundary=boundary" } }), bindings, async bytes => { received = bytes; return metadata(); });
    expect(response.status).toBe(201); expect(new Uint8Array(received!)).toEqual(payload);
  });
  it("sweeps abandoned objects while protecting committed packages", async () => {
    await push();
    const old = "2000-01-01T00:00:00.000Z";
    await bindings.DB.prepare("INSERT INTO uploads(object_key, created) VALUES ('abandoned', ?)").bind(old).run();
    await bindings.PACKAGES.put("abandoned", "orphan");
    const row = await bindings.DB.prepare("SELECT object_key FROM packages").first<{ object_key: string }>();
    await bindings.DB.prepare("INSERT INTO uploads(object_key, created) VALUES (?, ?)").bind(row!.object_key, old).run();
    await recoverUploads(bindings);
    expect(await bindings.PACKAGES.get("abandoned")).toBeNull();
    expect(await bindings.PACKAGES.get(row!.object_key)).not.toBeNull();
  });
  it("fails closed when storage or inspector validation fails", async () => {
    const inspect = async () => { throw new Error("invalid archive"); };
    await expect(publish(new Request("https://nuget.test/api/v2/package", { method: "PUT", body: bytes }), bindings, inspect)).rejects.toThrow();
    expect((await bindings.PACKAGES.list()).objects).toHaveLength(0);
    await bindings.DB.exec("DROP TABLE packages");
    expect((await worker.fetch(request("/v3-flatcontainer/example/index.json"), bindings)).status).toBe(503);
  });
});
