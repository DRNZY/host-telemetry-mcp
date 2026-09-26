type Env = Record<string, string | undefined>;

function str(env: Env, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function int(env: Env, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface HostTelemetryConfig {
  nvidiaSmi: string;
  systemctl: string;
  gpuNameFallback: string;
  gpuVramTotalMbFallback: number;
  gpuIntervalMs: number;
  commandTimeoutMs: number;
  cpuWarmupMs: number;
  defaultServices: string[];
}

export function loadConfig(env: Env = process.env): HostTelemetryConfig {
  return {
    nvidiaSmi: str(env, "HOST_TELEMETRY_NVIDIA_SMI", "nvidia-smi"),
    systemctl: str(env, "HOST_TELEMETRY_SYSTEMCTL", "systemctl"),
    gpuNameFallback: str(env, "HOST_TELEMETRY_GPU_NAME", "NVIDIA GeForce RTX 3060 Laptop GPU"),
    gpuVramTotalMbFallback: int(env, "HOST_TELEMETRY_GPU_VRAM_MB", 6144),
    gpuIntervalMs: int(env, "HOST_TELEMETRY_GPU_INTERVAL_MS", 1000),
    commandTimeoutMs: int(env, "HOST_TELEMETRY_COMMAND_TIMEOUT_MS", 2000),
    cpuWarmupMs: int(env, "HOST_TELEMETRY_CPU_WARMUP_MS", 50),
    defaultServices: [
      "g915-wheel-fix.service",
      "pipewire.service",
      "wireplumber.service",
    ],
  };
}

export const config: HostTelemetryConfig = loadConfig();
