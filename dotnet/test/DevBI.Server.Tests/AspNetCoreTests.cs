// app.MapDevBIApi(...) in an ASP.NET Core app: the paths, every method, the headers, HEAD.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using DevBI.Server.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Xunit;

namespace DevBI.Server.Tests
{
    public class AspNetCoreTests
    {
        private static async Task<(WebApplication app, HttpClient client)> Start(string prefix, List<string>? log = null)
        {
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseTestServer();
            var app = builder.Build();
            app.MapDevBIApi(prefix, new DevBIApi(new DevBIOptions { Directory = Repo.Sample, Connect = _ => null, Log = log == null ? null : log.Add }));
            await app.StartAsync();
            return (app, app.GetTestClient());
        }

        /// <summary>
        /// An app whose users sign in (here: who the X-Test-User header says, with the roles of X-Test-Roles), the API in
        /// row-level mode on a folder with one file only 経理 may read.
        /// </summary>
        private static async Task<(WebApplication app, HttpClient client)> StartSignedIn(Func<HttpContext, DevBIUser?>? user = null)
        {
            var dir = Directory.CreateTempSubdirectory("devbi-aspnet-").FullName;
            Directory.CreateDirectory(Path.Combine(dir, "api"));
            File.WriteAllText(Path.Combine(dir, "api", "all.sql"), "-- access: all\nSELECT 1 AS one");
            File.WriteAllText(Path.Combine(dir, "api", "pay.sql"), "-- roles: 経理\n-- access: all\nSELECT 1 AS one");
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseTestServer();
            var app = builder.Build();
            app.Use((context, next) =>
            {
                var name = context.Request.Headers["X-Test-User"].ToString();
                if (name.Length > 0)
                {
                    var claims = new List<Claim> { new Claim(ClaimTypes.Name, name), new Claim("oid", "oid-" + name) };
                    claims.AddRange(context.Request.Headers["X-Test-Roles"].ToString().Split(',', StringSplitOptions.RemoveEmptyEntries).Select(r => new Claim(ClaimTypes.Role, r)));
                    context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
                }
                return next(context);
            });
            app.MapDevBIApi("/", new DevBIApi(new DevBIOptions { Directory = dir, Connect = _ => null, RequireUser = true }), user);
            await app.StartAsync();
            return (app, app.GetTestClient());
        }

        private static async Task<(HttpStatusCode, string)> Schema(HttpClient client, string? user = null, string? roles = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/api/schema");
            if (user != null) request.Headers.Add("X-Test-User", user);
            if (roles != null) request.Headers.Add("X-Test-Roles", roles);
            var r = await client.SendAsync(request);
            return (r.StatusCode, await r.Content.ReadAsStringAsync());
        }

        private static string[] Names(string schema) =>
            JsonDocument.Parse(schema).RootElement.GetProperty("datasets").EnumerateArray().Select(d => d.GetProperty("name").GetString()!).ToArray();

        [Fact]
        public async Task HandsTheSignedInUserToTheApi()
        {
            var (app, client) = await StartSignedIn();
            await using var _ = app;
            Assert.Equal((HttpStatusCode.Unauthorized, "{\"error\":\"ログインしていません\",\"access\":1}"), await Schema(client));
            var (status, text) = await Schema(client, "CORP\\yamada");
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.Equal(new[] { "all" }, Names(text));
            Assert.Equal("CORP\\yamada", JsonDocument.Parse(text).RootElement.GetProperty("user").GetProperty("id").GetString());
            // roles through User.IsInRole
            Assert.Equal(new[] { "all", "pay" }, Names((await Schema(client, "CORP\\keiri", "営業,経理")).Item2));
        }

        [Fact]
        public async Task TakesTheUserFromTheAppsOwnFunction()
        {
            var (app, client) = await StartSignedIn(context => new DevBIUser
            {
                Id = context.User.FindFirst("oid")?.Value,
                IsInRole = role => role == "経理" && context.User.IsInRole("CORP\\Managers"),
            });
            await using var _ = app;
            Assert.Equal(HttpStatusCode.Unauthorized, (await Schema(client)).Item1);
            var text = (await Schema(client, "CORP\\yamada", "CORP\\Managers")).Item2;
            Assert.Equal("oid-CORP\\yamada", JsonDocument.Parse(text).RootElement.GetProperty("user").GetProperty("id").GetString());
            Assert.Equal(new[] { "all", "pay" }, Names(text));
        }

        [Fact]
        public async Task AnswersUnderThePrefix()
        {
            var (app, client) = await Start("/reports/");
            await using var _ = app;
            var r = await client.GetAsync("/reports/api/schema");
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            Assert.Equal("application/json; charset=utf-8", r.Content.Headers.ContentType!.ToString());
            Assert.Equal("no-store", r.Headers.CacheControl!.ToString());
            using var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
            Assert.Equal(6, doc.RootElement.GetProperty("datasets").GetArrayLength());
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/schema")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/reports/api/other")).StatusCode);
            // HEAD: the headers without the body
            var head = await client.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/reports/api/schema"));
            Assert.Equal(HttpStatusCode.OK, head.StatusCode);
            Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        }

        [Fact]
        public async Task SendsWrongMethodsAndBodiesTheApisAnswers()
        {
            var log = new List<string>();
            var (app, client) = await Start("/", log);
            await using var _ = app;
            var r = await client.GetAsync("/api/query");
            Assert.Equal((HttpStatusCode.MethodNotAllowed, "{\"error\":\"POST で呼んでください\"}"), (r.StatusCode, await r.Content.ReadAsStringAsync()));
            r = await client.DeleteAsync("/api/schema");
            Assert.Equal((HttpStatusCode.MethodNotAllowed, "{\"error\":\"GET で呼んでください\"}"), (r.StatusCode, await r.Content.ReadAsStringAsync()));
            r = await client.PostAsync("/api/query", new StringContent("{\"name\":\"orders\"}", Encoding.UTF8, "text/plain"));
            Assert.Equal(HttpStatusCode.UnsupportedMediaType, r.StatusCode);
            r = await client.PostAsync("/api/query", new StringContent("{\"name\":\"orders\",\"params\":{\"from\":\"2024-04-01\"}}", Encoding.UTF8, "application/json"));
            Assert.Equal((HttpStatusCode.InternalServerError, "{\"error\":\"接続先がありません。DEVBI_DB の接続を DevBIOptions.Connect で返してください\"}"), (r.StatusCode, await r.Content.ReadAsStringAsync()));
            Assert.Equal("接続先がありません。DEVBI_DB の接続を DevBIOptions.Connect で返してください", log.Single());
        }
    }
}
