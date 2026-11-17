namespace Soenneker.Cloudflare.NuGet.Models;

/// <summary>Validated package metadata returned to the private Worker.</summary>
public sealed record PackageMetadata(string Id, string Version, string Description, string[] Authors, string[] Tags,
    string? Title, string? ProjectUrl, string? LicenseExpression, bool RequireLicenseAcceptance,
    bool Prerelease, bool SemVer2, string Sha512, string Nuspec, DependencyGroup[] DependencyGroups);
