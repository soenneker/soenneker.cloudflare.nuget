using Soenneker.Cloudflare.NuGet.Models;

namespace Soenneker.Cloudflare.NuGet.Services.Abstract;

/// <summary>Validates untrusted NuGet archives without extracting files to disk.</summary>
public interface IPackageInspector
{
    /// <summary>Inspects a seekable package stream and returns normalized metadata. Rejects malformed or oversized archives.</summary>
    /// <exception cref="InvalidDataException">The archive or package metadata is invalid.</exception>
    PackageMetadata Inspect(Stream stream);
}
