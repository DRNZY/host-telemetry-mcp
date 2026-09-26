import os from "os";
import fs from "fs";
import { config } from "./config.js";
import { execRunner, type CommandRunner } from "./runner.js";
import {
  isUnitActive,
  parseDf,
  parseGpuProcesses,
  parseGpuSamples,
  parseUnitState,
  reduceCpuTimes,
  type CpuCoreTimes,
  type DfUsage,
  type GpuProcess,
  type GpuSample,
} from "./parsers.js";

export interface HostIdentity {
  hostname: string;
  platform: string;
  arch: string;
  kernelRelease: string;
  distro: string;
}

export interface CpuVitals {
  model: string;
  cores: number;
  speedMhz: number;
  usagePercent: number;
  perCoreUsage: number[];
  loadAvg: [number, number, number];
}

export interface MemoryVitals {
  totalBytes: number;
  freeBytes: number;
  availableBytes: number;
  usedBytes: number;
  cachedBytes: number;
  buffersBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  usagePercent: number;
  swapUsagePercent: number;
}

export interface HostVitals {
  cpu: CpuVitals;
  memory: MemoryVitals;
  disk: DfUsage[];
  loadAvg: [number, number, number];
  uptimeSeconds: number;
  host: HostIdentity;
  timestamp: number;
}

export interface GpuTelemetry {
  name: string;
  vramUsedMb: number;
  vramTotalMb: number;
  vramPercent: number;
  tempC: number;
  utilizationPercent: number;
  powerDrawW: number;
  isAvailable: boolean;
  gpuCount: number;
  activeProcesses: GpuProcess[];
  error: string | null;
  timestamp: number;
}

export interface VitalsOptions {
  run?: CommandRunner;
  diskMounts?: string[];
  cpuTracker?: CpuUsageTracker;
}

const GPU_QUERY_ARGS = [
  "--query-gpu=name,memory.used,memory.total,temperature.gpu,utilization.gpu,power.draw",
  "--format=csv,noheader,nounits",
];

const GPU_PROCESS_ARGS = [
  "--query-compute-apps=pid,process_name,used_memory",
  "--format=csv,noheader,nounits",
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parseMeminfo(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z_()]+):\s+(\d+)\s*kB$/);
    if (!m) continue;
    out[m[1]] = Number.parseInt(m[2], 10) * 1024;
  }
  return out;
}

function readMeminfo(): Record<string, number> {
  try {
    if (!fs.existsSync("/proc/meminfo")) return {};
    return parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return {};
  }
}

function readDistro(): string {
  try {
    if (!fs.existsSync("/etc/os-release")) return os.type();
    const raw = fs.readFileSync("/etc/os-release", "utf8");
    const m = raw.match(/PRETTY_NAME="?([^"\n]+)"?/);
    return m ? m[1].trim() : os.type();
  } catch {
    return os.type();
  }
}

function coreTimes(): CpuCoreTimes[] {
  return os.cpus().map((c) => {
    const times = c.times as unknown as CpuCoreTimes;
    const total = Object.values(times).reduce(
      (acc: number, v) => acc + (typeof v === "number" ? v : 0),
      0
    );
    return { ...times, total };
  });
}

/**
 * Differential CPU accounting. `os.cpus()` exposes monotonically increasing
 * counters, so usage is only meaningful as a delta between two samples; a
 * single sample yields the since-boot average, which never moves. A minimum
 * interval is enforced so that an extra on-demand request between two
 * interval ticks cannot produce a degenerate, near-100% or near-0% reading.
 */
export class CpuUsageTracker {
  private previous: CpuCoreTimes[] | null = null;
  private previousAt = 0;
  private last: { overall: number; perCore: number[] } = { overall: 0, perCore: [] };

  constructor(private readonly minIntervalMs = 250) {}

  /** True until a first baseline has been captured; the first reading is not a measurement. */
  needsBaseline(): boolean {
    return this.previous === null;
  }

  sample(): { overall: number; perCore: number[] } {
    const now = Date.now();
    if (this.previous && now - this.previousAt < this.minIntervalMs) {
      return this.last;
    }
    this.last = this.compute();
    return this.last;
  }

  /**
   * Takes a baseline, waits, then measures across that window.
   *
   * Seeding and measuring in the same tick would compare two samples taken
   * microseconds apart, which always yields 0%. The wait must sit between them,
   * and the min-interval guard must be bypassed for the measuring half or it
   * would return the seed's placeholder instead.
   */
  async measureOverWindow(windowMs: number): Promise<{ overall: number; perCore: number[] }> {
    this.previous = coreTimes();
    this.previousAt = Date.now();
    this.last = { overall: 0, perCore: new Array(os.cpus().length).fill(0) };
    await sleep(windowMs);
    this.previousAt = 0;
    return this.sample();
  }

  private compute(): { overall: number; perCore: number[] } {
    const current = coreTimes();
    const prior = this.previous;
    this.previous = current;
    this.previousAt = Date.now();
    if (!prior || prior.length !== current.length) {
      return { overall: 0, perCore: new Array(current.length).fill(0) };
    }
    const deltas = current.map((c, i) => {
      const p = prior[i];
      return { total: c.total - p.total, idle: c.idle - p.idle };
    });
    return reduceCpuTimes(deltas);
  }
}

export const cpuUsageTracker = new CpuUsageTracker();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getHostVitals(options: VitalsOptions = {}): Promise<HostVitals> {
  const run = options.run ?? execRunner;
  const cpus = os.cpus();
  const tracker = options.cpuTracker ?? cpuUsageTracker;

  // A delta needs two samples. Establish a real baseline across a short window
  // rather than handing the first caller a fabricated zero.
  const usage = tracker.needsBaseline()
    ? await tracker.measureOverWindow(config.cpuWarmupMs)
    : tracker.sample();

  const load = os.loadavg();

  const meminfo = readMeminfo();
  const totalBytes = meminfo.MemTotal || os.totalmem();
  const freeBytes = meminfo.MemFree || os.freemem();
  const availableBytes = meminfo.MemAvailable || meminfo.MemFree || os.freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const swapTotalBytes = meminfo.SwapTotal || 0;
  const swapUsedBytes = Math.max(0, swapTotalBytes - (meminfo.SwapFree || 0));

  const diskMounts = options.diskMounts ?? ["/"];
  let disk: DfUsage[] = [];
  try {
    const { stdout } = await run("df", ["-B1", ...diskMounts]);
    disk = parseDf(stdout, diskMounts);
  } catch {
    disk = [];
  }

  return {
    cpu: {
      model: cpus[0]?.model || "Generic Processor",
      cores: cpus.length,
      speedMhz: cpus[0]?.speed || 0,
      usagePercent: usage.overall,
      perCoreUsage: usage.perCore,
      loadAvg: [round2(load[0]), round2(load[1]), round2(load[2])],
    },
    memory: {
      totalBytes,
      freeBytes,
      availableBytes,
      usedBytes,
      cachedBytes: meminfo.Cached || 0,
      buffersBytes: meminfo.Buffers || 0,
      swapTotalBytes,
      swapUsedBytes,
      usagePercent: Math.round((usedBytes / (totalBytes || 1)) * 100),
      swapUsagePercent:
        swapTotalBytes > 0 ? Math.round((swapUsedBytes / swapTotalBytes) * 100) : 0,
    },
    disk,
    loadAvg: [round2(load[0]), round2(load[1]), round2(load[2])],
    uptimeSeconds: os.uptime(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      kernelRelease: os.release(),
      distro: readDistro(),
    },
    timestamp: Date.now(),
  };
}

export async function probeGpu(run: CommandRunner = execRunner): Promise<GpuTelemetry> {
  let samples: GpuSample[] = [];
  let processes: GpuProcess[] = [];
  let error: string | null = null;
  let available = false;

  try {
    const { stdout } = await run(config.nvidiaSmi, GPU_QUERY_ARGS);
    samples = parseGpuSamples(stdout);
    available = samples.length > 0;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (available) {
    try {
      const { stdout } = await run(config.nvidiaSmi, GPU_PROCESS_ARGS);
      processes = parseGpuProcesses(stdout);
    } catch {
      processes = [];
    }
  }

  const primary = samples[0];

  return {
    name: primary?.name ?? config.gpuNameFallback,
    vramUsedMb: primary?.vramUsedMb ?? 0,
    vramTotalMb: primary?.vramTotalMb ?? config.gpuVramTotalMbFallback,
    vramPercent: primary?.vramPercent ?? 0,
    tempC: primary?.tempC ?? 0,
    utilizationPercent: primary?.utilizationPercent ?? 0,
    powerDrawW: primary?.powerDrawW ?? 0,
    isAvailable: available,
    gpuCount: samples.length,
    activeProcesses: processes,
    error: available ? null : error,
    timestamp: Date.now(),
  };
}

export async function getGpuTelemetry(options: VitalsOptions = {}): Promise<GpuTelemetry> {
  return probeGpu(options.run);
}

export async function inspectUserServices(
  services: string[] = config.defaultServices,
  options: VitalsOptions = {}
): Promise<Record<string, string>> {
  const run = options.run ?? execRunner;
  const units = services.length > 0 ? services : config.defaultServices;
  const settled = await Promise.all(
    units.map(async (unit) => {
      try {
        const { stdout } = await run(config.systemctl, ["--user", "is-active", unit]);
        return [unit, parseUnitState(stdout)] as const;
      } catch {
        return [unit, "unavailable"] as const;
      }
    })
  );
  return Object.fromEntries(settled);
}

export async function areUserServicesActive(
  services: string[] = config.defaultServices,
  options: VitalsOptions = {}
): Promise<Record<string, boolean>> {
  const states = await inspectUserServices(services, options);
  return Object.fromEntries(
    Object.entries(states).map(([unit, state]) => [unit, isUnitActive(state)])
  );
}
