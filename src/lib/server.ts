import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import os from "os";
import http from "http";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function createHostTelemetryMcpServer(): Server {
  const server = new Server(
    {
      name: "host-telemetry",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  const TOOLS: Tool[] = [
    {
      name: "get_host_vitals",
      description: "Retrieve real-time host CPU, memory, load averages, uptime, and display configuration",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "get_gpu_telemetry",
      description: "Query NVIDIA RTX 3060 Laptop GPU VRAM allocation, thermals, power draw, and active GPU processes via NVML",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "inspect_user_services",
      description: "Check the live status of systemd user services (e.g. g915-wheel-fix, pipewire, wireplumber)",
      inputSchema: {
        type: "object",
        properties: {
          services: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of service names. Defaults to critical services."
          }
        }
      }
    },
    {
      name: "query_hyperindex",
      description: "Perform sub-5ms hybrid semantic and symbol search across local codebase via HyperIndex",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol or semantic query to search" },
          limit: { type: "number", description: "Maximum number of results to return (default 8)" }
        },
        required: ["query"]
      }
    },
    {
      name: "read_cadence_playback",
      description: "Inspect the live playback state, current track, volume, and DSP settings from Cadence",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "get_host_vitals") {
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const load = os.loadavg();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  hostname: os.hostname(),
                  platform: os.platform(),
                  kernel: os.release(),
                  uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
                  cpu: {
                    model: cpus[0]?.model || "x86_64",
                    cores: cpus.length,
                    loadAvg1m: Math.round(load[0] * 100) / 100,
                    loadAvg5m: Math.round(load[1] * 100) / 100,
                    loadAvg15m: Math.round(load[2] * 100) / 100
                  },
                  memory: {
                    usedGb: Math.round(((totalMem - freeMem) / (1024 ** 3)) * 100) / 100,
                    totalGb: Math.round((totalMem / (1024 ** 3)) * 100) / 100,
                    percentUsed: Math.round(((totalMem - freeMem) / totalMem) * 100)
                  }
                },
                null,
                2
              )
            }
          ]
        };
      }

      if (name === "get_gpu_telemetry") {
        try {
          const { stdout } = await execFileAsync("nvidia-smi", [
            "--query-gpu=name,memory.used,memory.total,temperature.gpu,utilization.gpu,power.draw",
            "--format=csv,noheader,nounits"
          ]);

          const parts = stdout.trim().split(",").map(s => s.trim());
          const gpuStats = {
            name: parts[0] || "NVIDIA GPU",
            vramUsedMb: parseInt(parts[1], 10) || 0,
            vramTotalMb: parseInt(parts[2], 10) || 6144,
            vramPercent: Math.round((parseInt(parts[1], 10) / parseInt(parts[2], 10)) * 100) || 0,
            tempC: parseInt(parts[3], 10) || 0,
            gpuUtilizationPercent: parseInt(parts[4], 10) || 0,
            powerDrawW: Math.round(parseFloat(parts[5])) || 0
          };

          // Get active GPU compute processes
          let processes: any[] = [];
          try {
            const procOutput = await execFileAsync("nvidia-smi", [
              "--query-compute-apps=pid,process_name,used_memory",
              "--format=csv,noheader,nounits"
            ]);
            processes = procOutput.stdout.trim().split("\n").filter(Boolean).map(line => {
              const p = line.split(",").map(s => s.trim());
              return { pid: p[0], name: p[1], vramMb: p[2] };
            });
          } catch {}

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ gpu: gpuStats, activeProcesses: processes }, null, 2)
              }
            ]
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `nvidia-smi error: ${err.message || String(err)}` }],
            isError: true
          };
        }
      }

      if (name === "inspect_user_services") {
        const serviceList = (args?.services as string[]) || [
          "g915-wheel-fix.service",
          "pipewire.service",
          "wireplumber.service"
        ];

        const results: Record<string, string> = {};
        for (const s of serviceList) {
          try {
            const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", s]);
            results[s] = stdout.trim();
          } catch {
            results[s] = "inactive";
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ services: results }, null, 2) }]
        };
      }

      if (name === "query_hyperindex") {
        const rawQuery = String(args?.query || "").trim();
        const limit = typeof args?.limit === "number" ? Math.min(20, Math.max(1, args.limit)) : 8;

        if (!rawQuery) {
          return { content: [{ type: "text", text: "[]" }] };
        }

        const hindexBin = "/home/darnell/.local/bin/hindex";
        try {
          const { stdout } = await execFileAsync(hindexBin, [
            "search",
            rawQuery.slice(0, 128),
            "--json",
            "--limit",
            String(limit)
          ]);

          return { content: [{ type: "text", text: stdout }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `HyperIndex error: ${err.message || String(err)}` }],
            isError: true
          };
        }
      }

      if (name === "read_cadence_playback") {
        const payload: any = await new Promise((resolve) => {
          const req = http.get("http://127.0.0.1:3001/api/now-playing", (res) => {
            let body = "";
            res.on("data", c => body += c);
            res.on("end", () => {
              try {
                resolve(JSON.parse(body));
              } catch {
                resolve({ isRunning: false, currentTrack: null, isPlaying: false });
              }
            });
          });
          req.on("error", () => resolve({ isRunning: false, currentTrack: null, isPlaying: false }));
          req.setTimeout(600, () => {
            req.destroy();
            resolve({ isRunning: false, currentTrack: null, isPlaying: false });
          });
        });

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error executing tool ${name}: ${err.message || String(err)}` }],
        isError: true
      };
    }
  });

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createHostTelemetryMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
