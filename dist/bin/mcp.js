#!/usr/bin/env node
import { runMcpServer } from "../lib/server.js";
runMcpServer().catch((err) => {
    console.error("Fatal error running host-telemetry MCP server:", err);
    process.exit(1);
});
