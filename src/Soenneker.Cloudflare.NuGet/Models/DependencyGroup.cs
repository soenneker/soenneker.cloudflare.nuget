namespace Soenneker.Cloudflare.NuGet.Models;

/// <summary>Package dependencies for a NuGet target framework.</summary>
public sealed record DependencyGroup(string TargetFramework, PackageDependency[] Dependencies);
