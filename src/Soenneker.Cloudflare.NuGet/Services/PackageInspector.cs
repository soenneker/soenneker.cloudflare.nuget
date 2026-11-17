using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using NuGet.Packaging;
using Soenneker.Cloudflare.NuGet.Models;
using Soenneker.Cloudflare.NuGet.Services.Abstract;

namespace Soenneker.Cloudflare.NuGet.Services;

public sealed partial class PackageInspector : IPackageInspector
{
    public const int MaximumPackageBytes = 32 * 1024 * 1024;
    private const int MaximumNuspecBytes = 512 * 1024;

    public PackageMetadata Inspect(Stream stream)
    {
        if (!stream.CanSeek || stream.Length == 0 || stream.Length > MaximumPackageBytes)
            throw new InvalidDataException("The package must be between 1 byte and 32 MiB.");
        stream.Position = 0;
        string hash = Convert.ToBase64String(SHA512.HashData(stream));
        stream.Position = 0;
        using var zip = new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: true);
        if (zip.Entries.Count > 10000) throw new InvalidDataException("Too many archive entries.");
        long expanded = 0;
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            string name = entry.FullName.Replace('\\', '/');
            if (name.StartsWith('/') || name.Contains(':') || name.Split('/').Any(p => p == "..") || !names.Add(name))
                throw new InvalidDataException("Unsafe or duplicate archive entry.");
            expanded = checked(expanded + entry.Length);
            if (expanded > 512L * 1024 * 1024) throw new InvalidDataException("Archive expanded size exceeds 512 MiB.");
        }
        ZipArchiveEntry[] manifests = zip.Entries.Where(e => !e.FullName.Contains('/') && !e.FullName.Contains('\\') && e.FullName.EndsWith(".nuspec", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (manifests.Length != 1 || manifests[0].Length > MaximumNuspecBytes)
            throw new InvalidDataException("Exactly one root nuspec of at most 512 KiB is required.");
        using Stream manifest = manifests[0].Open();
        using var bounded = new MemoryStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = manifest.Read(buffer)) != 0)
        {
            if (bounded.Length + read > MaximumNuspecBytes) throw new InvalidDataException("Nuspec is too large.");
            bounded.Write(buffer, 0, read);
        }
        bounded.Position = 0;
        using XmlReader xml = XmlReader.Create(bounded, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaximumNuspecBytes });
        XDocument document = XDocument.Load(xml);
        var reader = new NuspecReader(document);
        string id = reader.GetId();
        if (string.IsNullOrEmpty(id) || !PackageIdPattern().IsMatch(id)) throw new InvalidDataException("Invalid package ID.");
        var version = reader.GetVersion();
        string normalized = version.ToNormalizedString().Split('+')[0].ToLowerInvariant();
        if (normalized.Length > 256) throw new InvalidDataException("Version is too long.");
        var groups = reader.GetDependencyGroups().Select(g => new DependencyGroup(g.TargetFramework.GetShortFolderName(),
            g.Packages.Select(p => new Models.PackageDependency(p.Id, p.VersionRange.ToNormalizedString())).ToArray())).ToArray();
        if (string.IsNullOrWhiteSpace(reader.GetAuthors()) || string.IsNullOrWhiteSpace(reader.GetDescription()))
            throw new InvalidDataException("Authors and description are required.");
        if (reader.GetDescription().Length > 16384 || reader.GetAuthors().Length > 4096 || (reader.GetTags()?.Length ?? 0) > 4096 ||
            (reader.GetTitle()?.Length ?? 0) > 1024 || groups.Length > 128 || groups.Sum(g => g.Dependencies.Length) > 2048)
            throw new InvalidDataException("Package metadata exceeds supported limits.");
        bool semVer2 = version.Release.Contains('.') || version.HasMetadata || reader.GetDependencyGroups().Any(g => g.Packages.Any(p => IsSemVer2(p.VersionRange.MinVersion) || IsSemVer2(p.VersionRange.MaxVersion)));
        return new PackageMetadata(id, normalized, reader.GetDescription() ?? "", Split(reader.GetAuthors(), ','), Split(reader.GetTags(), ' '),
            reader.GetTitle(), reader.GetProjectUrl(), reader.GetLicenseMetadata() is { Type: LicenseType.Expression } license ? license.License : null, reader.GetRequireLicenseAcceptance(),
            version.IsPrerelease, semVer2, hash, document.ToString(SaveOptions.DisableFormatting), groups);
    }

    private static bool IsSemVer2(global::NuGet.Versioning.NuGetVersion? version) => version != null && (version.Release.Contains('.') || version.HasMetadata);

    private static string[] Split(string? value, char separator) => (value ?? "").Split(separator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    [GeneratedRegex(@"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$", RegexOptions.CultureInvariant)]
    private static partial Regex PackageIdPattern();
}
