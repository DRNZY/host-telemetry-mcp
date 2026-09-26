import http from "http";
import { getGpuTelemetry, getHostVitals, inspectUserServices } from "./vitals.js";
import { gpuSampler } from "./sampler.js";

export interface HttpModeOptions {
  port?: number;
  host?: string;
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function createHttpModeServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (url.pathname === "/healthz") {
        return send(res, 200, { ok: true, uptimeSeconds: process.uptime() });
      }
      if (url.pathname === "/v1/vitals") {
        return send(res, 200, await getHostVitals());
      }
      if (url.pathname === "/v1/gpu") {
        return send(res, 200, await getGpuTelemetry());
      }
      if (url.pathname === "/v1/services") {
        const requested = url.searchParams.getAll("service");
        return send(res, 200, { services: await inspectUserServices(requested) });
      }
      return send(res, 404, { error: "Not found", available: ["/healthz", "/v1/vitals", "/v1/gpu", "/v1/services"] });
    } catch (err) {
      return send(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export async function runHttpMode(options: HttpModeOptions = {}): Promise<http.Server> {
  const port = options.port ?? Number(process.env.HOST_TELEMETRY_HTTP_PORT ?? 4902);
  const host = options.host ?? "127.0.0.1";
  const server = createHttpModeServer();

  gpuSampler.subscribe(() => {
    /* keep the shared sampler warm while the HTTP mode is serving */
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(`[host-telemetry] HTTP/JSON mode listening on http://${host}:${port}`);
  return server;
}
