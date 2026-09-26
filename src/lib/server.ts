import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getGpuTelemetry, getHostVitals, inspectUserServices } from "./vitals.js";

const TOOLS: Tool[] = [
  {
    name: "get_host_vitals",
    description:
      "Retrieve real-time host CPU, memory, disk, load average, uptime, and identity telemetry",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_gpu_telemetry",
    description:
      "Query NVIDIA GPU VRAM allocation, thermals, power draw, and active compute processes",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inspect_user_services",
    description:
      "Check the live state of systemd user services (e.g. g915-wheel-fix, pipewire, wireplumber)",
    inputSchema: {
      type: "object",
      properties: {
        services: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of service names. Defaults to critical services.",
        },
      },
    },
  },
];

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function createHostTelemetryMcpServer(): Server {
  const server = new Server(
    { name: "host-telemetry", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "get_host_vitals") return textResult(await getHostVitals());
      if (name === "get_gpu_telemetry") return textResult(await getGpuTelemetry());
      if (name === "inspect_user_services") {
        const services = Array.isArray(args?.services)
          ? (args.services as string[])
          : undefined;
        return textResult({ services: await inspectUserServices(services) });
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error executing tool ${name}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createHostTelemetryMcpServer();
  await server.connect(new StdioServerTransport());
}
