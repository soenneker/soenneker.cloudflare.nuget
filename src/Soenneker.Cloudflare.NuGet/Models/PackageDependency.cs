namespace Soenneker.Cloudflare.NuGet.Models;

/// <summary>A package dependency and its NuGet version range.</summary>
public sealed record PackageDependency(string Id, string Range);
