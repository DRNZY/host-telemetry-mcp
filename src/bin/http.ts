#!/usr/bin/env node

import { runHttpMode } from "../lib/http.js";

runHttpMode().catch((err) => {
  console.error("Fatal error running host-telemetry HTTP mode:", err);
  process.exit(1);
});
