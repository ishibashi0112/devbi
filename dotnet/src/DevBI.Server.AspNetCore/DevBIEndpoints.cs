// DevBI's read-only API in an ASP.NET Core app (minimal APIs, MVC or Razor Pages):
//
//   var api = new DevBIApi(new DevBIOptions { Directory = ..., Connect = name => ... });
//   app.MapDevBIApi("/reports", api);   // GET /reports/api/schema, POST /reports/api/query
//
// The dashboards (the built site) go in the same folder (/reports/...): the browser posts to api/query next to them.
// The signed-in user (HttpContext.User) goes to the API as it is, for row-level security (api/*.sql with :user.region).
using System;
using System.Security.Claims;
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
        /// <paramref name="user"/>: the signed-in user for row-level security; without it, <see cref="UserOf"/>
        /// (<c>HttpContext.User</c>'s name and roles).
        /// </summary>
        public static RouteGroupBuilder MapDevBIApi(this IEndpointRouteBuilder endpoints, string prefix, DevBIApi api, Func<HttpContext, DevBIUser?>? user = null)
        {
            if (api == null) throw new ArgumentNullException(nameof(api));
            var group = endpoints.MapGroup(prefix.TrimEnd('/'));
            group.Map("api/schema", context => HandleAsync(context, api, "schema", user));
            group.Map("api/query", context => HandleAsync(context, api, "query", user));
            return group;
        }

        /// <summary>
        /// The signed-in user as ASP.NET Core has it: <c>User.Identity.Name</c> as the id (Windows authentication:
        /// <c>CORP\yamada</c>) and <c>User.IsInRole</c> for <c>-- roles:</c> (the AD groups). Null when nobody is signed in.
        /// With OpenID Connect, which claim <c>Identity.Name</c> holds depends on the app (<c>NameClaimType</c>): pass
        /// <c>user</c> to <see cref="MapDevBIApi"/> to take a claim that does not change (Entra ID's <c>oid</c>).
        /// </summary>
        public static DevBIUser? UserOf(HttpContext context)
        {
            ClaimsPrincipal principal = context.User;
            if (principal?.Identity?.IsAuthenticated != true) return null;
            return new DevBIUser { Id = principal.Identity.Name, IsInRole = principal.IsInRole };
        }

        /// <summary>Answer one request with the API, for apps that route to it in their own way.</summary>
        public static async Task HandleAsync(HttpContext context, DevBIApi api, string action, Func<HttpContext, DevBIUser?>? user = null)
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
                        User = (user ?? UserOf)(context),
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
