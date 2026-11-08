// DevBI's read-only API in ASP.NET on .NET Framework (WebForms, MVC 5, Web API 2). Set the API once when the app
// starts (Global.asax):
//
//   protected void Application_Start(object sender, EventArgs e)
//   {
//       DevBIHttpHandler.Api = new DevBIApi(new DevBIOptions
//       {
//           Directory = Server.MapPath("~/App_Data/devbi"),   // api/*.sql: where IIS does not send files
//           Connect = name => name == "DEVBI_DB" ? new SqlConnection(ConfigurationManager.ConnectionStrings["DevBI"].ConnectionString) : null,
//       });
//   }
//
// and send the requests under the dashboards' api/ folder to it (web.config, IIS integrated pipeline):
//
//   <location path="Scripts/devbi/api">
//     <system.webServer>
//       <handlers>
//         <add name="DevBI" path="*" verb="*" type="DevBI.Server.SystemWeb.DevBIHttpHandler, DevBI.Server.SystemWeb" preCondition="integratedMode" />
//       </handlers>
//     </system.webServer>
//   </location>
using System;
using System.Threading;
using System.Threading.Tasks;
using System.Web;

namespace DevBI.Server.SystemWeb
{
    public class DevBIHttpHandler : HttpTaskAsyncHandler
    {
        /// <summary>The API every request goes to. Set it in <c>Application_Start</c>.</summary>
        public static DevBIApi? Api { get; set; }

        public override bool IsReusable => true;

        public override async Task ProcessRequestAsync(HttpContext context)
        {
            var api = Api ?? throw new InvalidOperationException("DevBIHttpHandler.Api がありません。Global.asax の Application_Start で設定してください");
            var request = context.Request;
            var response = context.Response;
            // IIS would put its own error page in place of the API's JSON.
            response.TrySkipIisCustomErrors = true;
            var cancel = Disconnected(response);
            ApiResponse answer;
            try
            {
                answer = await api.HandleAsync(
                    new ApiRequest
                    {
                        Action = DevBIApi.ActionOf(request.Path) ?? "",
                        Method = request.HttpMethod,
                        ContentType = request.ContentType,
                        AcceptEncoding = request.Headers["Accept-Encoding"],
                        Body = request.GetBufferlessInputStream(),
                    },
                    cancel);
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested)
            {
                // The browser went away (another filter was picked): nobody to answer.
                return;
            }
            response.StatusCode = answer.Status;
            foreach (var header in answer.Headers)
            {
                switch (header.Key)
                {
                    case "Content-Type":
                        // "application/json; charset=utf-8": ASP.NET adds the charset itself when it is set apart.
                        var at = header.Value.IndexOf("; charset=", StringComparison.Ordinal);
                        response.ContentType = at < 0 ? header.Value : header.Value.Substring(0, at);
                        response.Charset = at < 0 ? "" : header.Value.Substring(at + "; charset=".Length);
                        break;
                    case "Cache-Control":
                        // ASP.NET writes Cache-Control from its cache policy.
                        response.Cache.SetCacheability(HttpCacheability.NoCache);
                        response.Cache.SetNoStore();
                        break;
                    default:
                        response.AppendHeader(header.Key, header.Value);
                        break;
                }
            }
            if (request.HttpMethod != "HEAD") response.OutputStream.Write(answer.Body, 0, answer.Body.Length);
        }

        /// <summary>Cancelled when the browser goes away (IIS integrated pipeline); elsewhere never.</summary>
        private static CancellationToken Disconnected(HttpResponse response)
        {
            try
            {
                return response.ClientDisconnectedToken;
            }
            catch (PlatformNotSupportedException)
            {
                return CancellationToken.None;
            }
        }
    }
}
