export interface GpuSample {
  name: string;
  vramUsedMb: number;
  vramTotalMb: number;
  tempC: number;
  utilizationPercent: number;
  powerDrawW: number;
  vramPercent: number;
}

export interface GpuProcess {
  pid: number;
  name: string;
  vramMb: number;
}

export interface CpuCoreTimes {
  idle: number;
  total: number;
  [key: string]: number;
}

export interface CpuUsageSample {
  overall: number;
  perCore: number[];
}

/**
 * nvidia-smi reports `[N/A]` for fields the driver cannot supply on a given
 * board (power.draw on some laptop GPUs, temperature on others). Those tokens
 * must degrade to a number rather than poisoning a field with NaN.
 */
export function numericField(token: string | undefined): number | null {
  if (token === undefined) return null;
  const cleaned = token.trim();
  if (cleaned === "" || cleaned === "[N/A]" || cleaned === "N/A") return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Splits a fixed-field CSV line into exactly `fields` columns, allocating any
 * surplus commas to the leading column. A GPU product name may legitimately
 * contain a comma; naive `split(",")` would shift every subsequent field.
 */
export function splitCsvFields(line: string, fields: number): string[] {
  const parts = line.split(",");
  if (parts.length <= fields) return parts;
  return [
    parts.slice(0, parts.length - (fields - 1)).join(","),
    ...parts.slice(parts.length - (fields - 1)),
  ];
}

export function parseGpuSamples(stdout: string): GpuSample[] {
  const rows = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const samples: GpuSample[] = [];
  for (const row of rows) {
    const cols = splitCsvFields(row, 6);
    if (cols.length < 6) continue;

    const name = cols[0].trim();
    if (name === "") continue;

    const vramUsedMb = numericField(cols[1]);
    const vramTotalMb = numericField(cols[2]);
    if (vramUsedMb === null || vramTotalMb === null || vramTotalMb <= 0) continue;

    samples.push({
      name,
      vramUsedMb,
      vramTotalMb,
      tempC: numericField(cols[3]) ?? 0,
      utilizationPercent: numericField(cols[4]) ?? 0,
      powerDrawW: numericField(cols[5]) ?? 0,
      vramPercent: Math.round((vramUsedMb / vramTotalMb) * 100),
    });
  }
  return samples;
}

export function parseGpuProcesses(stdout: string): GpuProcess[] {
  const rows = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const processes: GpuProcess[] = [];
  for (const row of rows) {
    const cols = splitCsvFields(row, 3);
    if (cols.length < 3) continue;
    const pid = numericField(cols[0]);
    const vramMb = numericField(cols[2]);
    if (pid === null || vramMb === null) continue;
    processes.push({ pid: Math.round(pid), name: cols[1].trim(), vramMb });
  }
  return processes;
}

const UNIT_STATES = new Set([
  "active",
  "activating",
  "inactive",
  "deactivating",
  "failed",
  "reloading",
]);

/**
 * `systemctl is-active` prints the state on stdout even when it exits non-zero
 * (an unknown unit prints "inactive" and exits 4). Only a truly empty stdout
 * means the state could not be determined at all.
 */
export function parseUnitState(stdout: string | undefined | null): string {
  if (stdout === undefined || stdout === null) return "unavailable";
  const first = stdout.trim().split("\n")[0]?.trim().toLowerCase() ?? "";
  if (first === "") return "unavailable";
  if (UNIT_STATES.has(first)) return first;
  if (first === "unknown") return "unknown";
  return "unavailable";
}

export function isUnitActive(state: string): boolean {
  return state === "active";
}

export function reduceCpuTimes(cores: CpuCoreTimes[]): CpuUsageSample {
  if (cores.length === 0) return { overall: 0, perCore: [] };

  const perCore = cores.map((core) => {
    const active = core.total - core.idle;
    if (core.total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((active / core.total) * 100)));
  });

  const totalAll = cores.reduce((acc, c) => acc + c.total, 0);
  const idleAll = cores.reduce((acc, c) => acc + c.idle, 0);
  const overall =
    totalAll > 0
      ? Math.max(0, Math.min(100, Math.round(((totalAll - idleAll) / totalAll) * 100)))
      : 0;

  return { overall, perCore };
}

export interface DfUsage {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export function parseDf(stdout: string, mounts: string[]): DfUsage[] {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const results: DfUsage[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const mount = parts[5];
    if (!mounts.includes(mount)) continue;

    const totalBytes = numericField(parts[1]);
    const usedBytes = numericField(parts[2]);
    const availableBytes = numericField(parts[3]);
    if (totalBytes === null || usedBytes === null || availableBytes === null) continue;
    if (totalBytes <= 0) continue;

    results.push({
      mount,
      totalBytes,
      usedBytes,
      availableBytes,
      usagePercent: Math.round((usedBytes / totalBytes) * 100),
    });
  }
  return results;
}
