// The sales example's dashboards and its api/*.sql on SQL Server, served by ASP.NET Core: what devbi-serve does,
// in C#. From dotnet/, after `pnpm --filter devbi-example-sales build` and `copy-db` (docs/reference.md):
//
//   ConnectionStrings__DEVBI_DB="Server=127.0.0.1;Database=master;User Id=devbi_reader;Password=...;TrustServerCertificate=true" \
//     dotnet run --project samples/DevBI.Sample -- --urls http://127.0.0.1:4179
//
// Then open http://127.0.0.1:4179/#/sales-db.
using DevBI.Server;
using DevBI.Server.AspNetCore;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);
// examples/sales: api/*.sql, and dist/ (the built dashboards)
var example = Path.GetFullPath(builder.Configuration["DevBI:Example"] ?? Path.Combine(builder.Environment.ContentRootPath, "..", "..", "..", "examples", "sales"));
var app = builder.Build();

var api = new DevBIApi(new DevBIOptions
{
    Directory = example,
    // DEVBI_DB, or DEVBI_DB_ERP for a file with "-- connection: erp": from ConnectionStrings (appsettings.json, or
    // the environment variable ConnectionStrings__DEVBI_DB). Give it a login that may only SELECT.
    Connect = name => app.Configuration.GetConnectionString(name) is { Length: > 0 } text ? new SqlConnection(text) : null,
    Log = line => app.Logger.LogInformation("{Line}", line),
});
app.MapDevBIApi("/", api);

// The dashboards: files ASP.NET Core does not know the type of included (.arrows snapshots, .wasm).
var site = new PhysicalFileProvider(Path.Combine(example, "dist"));
var types = new FileExtensionContentTypeProvider();
types.Mappings[".arrows"] = DevBIApi.ArrowStreamType;
types.Mappings[".wasm"] = "application/wasm";
types.Mappings[".parquet"] = "application/vnd.apache.parquet";
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = site });
app.UseStaticFiles(new StaticFileOptions { FileProvider = site, ContentTypeProvider = types });

app.Run();
