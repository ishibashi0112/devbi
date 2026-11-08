// DevBI's read-only API in an ASP.NET Core app (minimal APIs, MVC or Razor Pages):
//
//   var api = new DevBIApi(new DevBIOptions { Directory = ..., Connect = name => ... });
//   app.MapDevBIApi("/reports", api);   // GET /reports/api/schema, POST /reports/api/query
//
// The dashboards (the built site) go in the same folder (/reports/...): the browser posts to api/query next to them.
using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace DevBI.Server.AspNetCore
{
    public static class DevBIEndpoints
    {
        /// <summary>
        /// Map <c>{prefix}/api/schema</c> and <c>{prefix}/api/query</c> to the API. Every method goes to it, so a wrong
        /// one gets the API's 405 in Japanese. The result takes the usual conventions (<c>.RequireAuthorization()</c>).
        /// </summary>
        public static RouteGroupBuilder MapDevBIApi(this IEndpointRouteBuilder endpoints, string prefix, DevBIApi api)
        {
            if (api == null) throw new ArgumentNullException(nameof(api));
            var group = endpoints.MapGroup(prefix.TrimEnd('/'));
            group.Map("api/schema", context => HandleAsync(context, api, "schema"));
            group.Map("api/query", context => HandleAsync(context, api, "query"));
            return group;
        }

        /// <summary>Answer one request with the API, for apps that route to it in their own way.</summary>
        public static async Task HandleAsync(HttpContext context, DevBIApi api, string action)
        {
            var request = context.Request;
            ApiResponse answer;
            try
            {
                answer = await api.HandleAsync(
                    new ApiRequest
                    {
                        Action = action,
                        Method = request.Method,
                        ContentType = request.ContentType,
                        AcceptEncoding = request.Headers.AcceptEncoding.ToString(),
                        Body = request.Body,
                    },
                    context.RequestAborted);
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                // The browser went away (another filter was picked): nobody to answer.
                return;
            }
            var response = context.Response;
            response.StatusCode = answer.Status;
            foreach (var header in answer.Headers) response.Headers[header.Key] = header.Value;
            response.ContentLength = answer.Body.Length;
            if (!HttpMethods.IsHead(request.Method)) await response.Body.WriteAsync(answer.Body, CancellationToken.None);
        }
    }
}
