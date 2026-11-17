using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using Soenneker.Cloudflare.NuGet.Services;

namespace Soenneker.Cloudflare.NuGet.Tests;

public sealed class CloudflareNuGetTests
{
    private static MemoryStream Package(string xml, string? extra = null)
    {
        var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var writer = new StreamWriter(zip.CreateEntry("Example.nuspec").Open(), Encoding.UTF8)) writer.Write(xml);
            if (extra != null) using (var writer = new StreamWriter(zip.CreateEntry(extra).Open())) writer.Write("test");
        }
        stream.Position = 0;
        return stream;
    }
    private const string Nuspec = "<package><metadata><id>Example.Package</id><version>01.2.0.0+build</version><authors>One, Two</authors><description>Package</description><dependencies><group targetFramework=\"net11.0\"><dependency id=\"Example.Dependency\" version=\"[1.0,2.0)\" /></group></dependencies></metadata></package>";

    [Test]
    public async System.Threading.Tasks.Task Normalizes_identity_and_preserves_dependencies()
    {
        using var stream = Package(Nuspec);
        var result = new PackageInspector().Inspect(stream);
        await Assert.That(result.Version).IsEqualTo("1.2.0");
        await Assert.That(result.Id).IsEqualTo("Example.Package");
        await Assert.That(result.DependencyGroups[0].Dependencies[0].Id).IsEqualTo("Example.Dependency");
        await Assert.That(Convert.FromBase64String(result.Sha512).Length).IsEqualTo(64);
        await Assert.That(result.SemVer2).IsTrue();
    }
    [Test]
    public void Rejects_path_traversal()
    {
        using var stream = Package(Nuspec, "../escape.dll");
        try { new PackageInspector().Inspect(stream); throw new Exception("Expected invalid package."); }
        catch (InvalidDataException) { }
    }
    [Test]
    public void Rejects_multiple_manifests()
    {
        using var stream = Package(Nuspec, "Other.nuspec");
        try { new PackageInspector().Inspect(stream); throw new Exception("Expected invalid package."); }
        catch (InvalidDataException) { }
    }
    [Test]
    public void Rejects_xml_external_entities()
    {
        using var stream = Package("<!DOCTYPE package [<!ENTITY x SYSTEM 'file:///secret'>]><package><metadata><id>&x;</id></metadata></package>");
        try { new PackageInspector().Inspect(stream); throw new Exception("Expected invalid XML."); }
        catch (System.Xml.XmlException) { }
    }
    [Test]
    public void Rejects_invalid_identity()
    {
        using var stream = Package(Nuspec.Replace("Example.Package", "../invalid"));
        try { new PackageInspector().Inspect(stream); throw new Exception("Expected invalid package."); }
        catch (InvalidDataException) { }
    }
}
