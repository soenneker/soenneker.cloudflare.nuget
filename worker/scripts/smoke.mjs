// Exercises the real .NET inspector and Worker with local D1/R2 and the dotnet NuGet client.
// Only the Cloudflare container transport is substituted with localhost HTTP.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const worker = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(worker, "..");
const runDir = resolve(worker, ".smoke", String(Date.now()));
await mkdir(runDir, { recursive: true });
async function port() { const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
async function run(command, args, cwd = runDir) {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let text = ""; child.stdout.on("data", x => text += x); child.stderr.on("data", x => text += x);
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}\n${text}`);
  console.log(text.trim()); return text;
}
const inspectorPort = await port(), workerPort = await port();
const inspectorUrl = `http://127.0.0.1:${inspectorPort}`, origin = `http://127.0.0.1:${workerPort}`;
const internalKey = "smoke-internal-key-with-at-least-32-characters", readKey = "smoke-read-key-with-at-least-32-characters", pushKey = "smoke-push-key-with-at-least-32-characters";
let inspector, mf;
try {
  const project = resolve(repo, "src/Soenneker.Cloudflare.NuGet");
  await run("dotnet", ["build", project, "-v", "quiet"], repo);
  inspector = spawn("dotnet", [resolve(project, "bin/Debug/net11.0/Soenneker.Cloudflare.NuGet.dll")], {
    cwd: runDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ASPNETCORE_URLS: inspectorUrl, NuGet__InternalApiKey: internalKey }
  });
  let inspectorLog = ""; inspector.stdout.on("data", x => inspectorLog += x); inspector.stderr.on("data", x => inspectorLog += x);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${inspectorUrl}/health`, { headers: { Authorization: `Bearer ${internalKey}` } })).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error(`Inspector failed to start: ${inspectorLog}`);
  const bundled = await build({ entryPoints: [resolve(worker, "src/index.ts")], bundle: true, write: false, format: "esm", target: "es2022", plugins: [{
    name: "local-container-transport",
    setup(builder) {
      builder.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: "container", namespace: "smoke" }));
      builder.onLoad({ filter: /.*/, namespace: "smoke" }, () => ({ contents: `export class Container {} export function getContainer() { return { fetch(request) { return fetch(new Request(${JSON.stringify(inspectorUrl)} + new URL(request.url).pathname, request)); } }; }` }));
    }
  }] });
  mf = new Miniflare(convertV4MiniflareOptions({ host: "127.0.0.1", port: workerPort, workers: [{ name: "nuget-smoke", script: bundled.outputFiles[0].text, modules: true, compatibilityDate: "2026-11-17", compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"], r2Buckets: ["PACKAGES"],
    bindings: { PUBLIC_URL: origin, READ_API_KEY: readKey, PUSH_API_KEY: pushKey, INTERNAL_API_KEY: internalKey } }] }));
  await mf.ready;
  const db = await mf.getD1Database("DB");
  const schema = await readFile(resolve(worker, "migrations/0001_packages.sql"), "utf8");
  for (const sql of schema.split(";").filter(s => s.trim())) await db.prepare(sql).run();
  if ((await fetch(`${origin}/v3/index.json`)).status !== 401) throw new Error("Anonymous feed read was allowed.");
  const auth = { Authorization: `Bearer ${readKey}` };
  if (!(await fetch(`${origin}/ready`, { headers: auth })).ok) throw new Error("Readiness failed.");
  const config = resolve(runDir, "nuget.config");
  await writeFile(config, `<configuration><packageSources><clear/><add key="private" value="${origin}/v3/index.json" allowInsecureConnections="true" /></packageSources><packageSourceCredentials><private><add key="Username" value="smoke"/><add key="ClearTextPassword" value="${readKey}"/></private></packageSourceCredentials></configuration>`);
  const dependencyId = "Smoke.Dependency", packageId = "Smoke.Package";
  for (const [name, id, dependency] of [["dependency", dependencyId, false], ["package", packageId, true]]) {
    const directory = resolve(runDir, name); await mkdir(directory);
    await writeFile(resolve(directory, `${name}.csproj`), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net11.0</TargetFramework><PackageId>${id}</PackageId><Version>1.2.3-alpha.10</Version><Description>NuGet smoke package</Description></PropertyGroup>${dependency ? '<ItemGroup><ProjectReference Include="../dependency/dependency.csproj" /></ItemGroup>' : ''}</Project>`);
    await writeFile(resolve(directory, "Example.cs"), `namespace ${name}; public sealed class Example { }`);
    await run("dotnet", ["pack", "-o", resolve(runDir, "packages"), "--configfile", config, "-v", "quiet"], directory);
    const path = resolve(runDir, "packages", `${id}.1.2.3-alpha.10.nupkg`);
    await run("dotnet", ["nuget", "push", path, "--source", `${origin}/v3/index.json`, "--api-key", pushKey, "--no-symbols", "--allow-insecure-connections"], runDir);
    await run("dotnet", ["nuget", "push", path, "--source", `${origin}/v3/index.json`, "--api-key", pushKey, "--no-symbols", "--skip-duplicate", "--allow-insecure-connections"], runDir);
  }
  const consumer = resolve(runDir, "consumer"); await mkdir(consumer);
  await writeFile(resolve(consumer, "consumer.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="${packageId}" Version="1.2.3-alpha.10"/></ItemGroup></Project>`);
  await run("dotnet", ["restore", "--configfile", config, "--packages", resolve(runDir, "cache"), "--no-http-cache", "-p:NuGetAudit=false", "-v", "minimal"], consumer);
  const assets = JSON.parse(await readFile(resolve(consumer, "obj/project.assets.json"), "utf8"));
  if (!assets.libraries[`${dependencyId}/1.2.3-alpha.10`]) throw new Error("Transitive dependency was not restored.");
  await run("dotnet", ["nuget", "delete", packageId, "1.2.3-alpha.10", "--source", `${origin}/v3/index.json`, "--api-key", pushKey, "--non-interactive"], runDir);
  const search = await (await fetch(`${origin}/v3/query?q=smoke.package&prerelease=true&semVerLevel=2.0.0`, { headers: auth })).json();
  if (search.totalHits !== 0) throw new Error("Unlisted package remains searchable.");
  await run("dotnet", ["restore", "--force", "--configfile", config, "--packages", resolve(runDir, "cache-after-unlist"), "--no-http-cache", "-p:NuGetAudit=false", "-v", "minimal"], consumer);
  const relist = await fetch(`${origin}/api/v2/package/${packageId}/1.2.3-alpha.10`, { method: "POST", headers: { "X-NuGet-ApiKey": pushKey } });
  if (relist.status !== 204) throw new Error("Relist failed.");
  console.log("PASS: real dotnet push, duplicate detection, transitive restore, unlist, restore after unlist, and relist.");
} finally {
  try { if (mf) await mf.dispose(); }
  finally { if (inspector && inspector.exitCode === null) { inspector.kill(); await once(inspector, "exit"); } }
}


