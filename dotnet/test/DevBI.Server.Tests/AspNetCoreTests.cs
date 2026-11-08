// app.MapDevBIApi(...) in an ASP.NET Core app: the paths, every method, the headers, HEAD.
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using DevBI.Server.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
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
            Assert.Equal(2, doc.RootElement.GetProperty("datasets").GetArrayLength());
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
