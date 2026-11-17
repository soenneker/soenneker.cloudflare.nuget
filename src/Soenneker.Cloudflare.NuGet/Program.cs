using System.Security.Cryptography;
using System.Text;
using System.Xml;
using Soenneker.Cloudflare.NuGet.Services;
using Soenneker.Cloudflare.NuGet.Services.Abstract;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = PackageInspector.MaximumPackageBytes);
builder.Services.AddSingleton<IPackageInspector, PackageInspector>();
var app = builder.Build();
string key = builder.Configuration["NuGet:InternalApiKey"] ?? throw new InvalidOperationException("NuGet:InternalApiKey is required.");
if (key.Length < 32) throw new InvalidOperationException("NuGet:InternalApiKey must contain at least 32 characters.");
app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    byte[] supplied = SHA256.HashData(Encoding.UTF8.GetBytes(context.Request.Headers.Authorization.ToString()));
    byte[] expected = SHA256.HashData(Encoding.UTF8.GetBytes($"Bearer {key}"));
    if (!CryptographicOperations.FixedTimeEquals(supplied, expected)) { context.Response.StatusCode = 401; return; }
    await next(context);
});
app.MapGet("/health", () => Results.Ok(new { ready = true }));
app.MapPost("/inspect", async (HttpRequest request, IPackageInspector inspector, CancellationToken token) =>
{
    try
    {
        using var stream = new MemoryStream();
        byte[] buffer = new byte[81920];
        int count;
        while ((count = await request.Body.ReadAsync(buffer, token)) > 0)
        {
            if (stream.Length + count > PackageInspector.MaximumPackageBytes) return Results.StatusCode(413);
            await stream.WriteAsync(buffer.AsMemory(0, count), token);
        }
        return Results.Ok(inspector.Inspect(stream));
    }
    catch (Exception e) when (e is InvalidDataException or XmlException or ArgumentException or FormatException or OverflowException or NuGet.Packaging.Core.PackagingException)
    {
        return Results.Problem(statusCode: 400, title: "Invalid NuGet package.");
    }
});
app.Run();

public partial class Program;
