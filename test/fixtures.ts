/**
 * Fixtures captured verbatim from this machine (CachyOS, i7-12700H, RTX 3060 Laptop).
 * `nvidia-smiQuery` and `systemctlIsActiveInactive` are byte-exact `od -c` dumps.
 */

export const nvidiaSmiQuery =
  "NVIDIA GeForce RTX 3060 Laptop GPU, 13, 6144, 53, 0, 15.84\n";

export const nvidiaSmiQueryNoPower =
  "NVIDIA GeForce RTX 3060 Laptop GPU, 1024, 6144, 47, 12, [N/A]\n";

export const nvidiaSmiQueryMultiGpu =
  "NVIDIA GeForce RTX 3060 Laptop GPU, 13, 6144, 53, 0, 15.84\n" +
  "Tesla T4, 2048, 15360, 38, 0, 70.5\n";

export const nvidiaSmiQueryCommaInName =
  "NVIDIA GeForce RTX 3060, Laptop GPU, 13, 6144, 53, 0, 15.84\n";

export const nvidiaSmiComputeApps = "";

export const nvidiaSmiComputeAppsBusy =
  "1234, /usr/lib/firefox/firefox, 512\n" +
  "5678, /usr/bin/blender, 1024\n";

export const systemctlIsActive = "active\n";

export const systemctlIsActiveInactive = "inactive\n";

export const systemctlIsActiveFailed = "failed\n";

export const systemctlIsActiveEmpty = "";

export const dfRoot =
  "Filesystem            1B-blocks         Used    Available Use% Mounted on\n" +
  "/dev/nvme0n1p2  536870912000 305049067520 228667367424  58% /\n";

export const dfRootAndHome =
  "Filesystem            1B-blocks         Used    Available Use% Mounted on\n" +
  "/dev/nvme0n1p2  536870912000 305049067520 228667367424  58% /\n" +
  "/dev/nvme0n1p2  536870912000 305049067520 228667367424  58% /home\n";

export const meminfoHead =
  "MemTotal:       15973936 kB\n" +
  "MemFree:         2823380 kB\n" +
  "MemAvailable:    8702548 kB\n" +
  "Buffers:              28 kB\n" +
  "Cached:          6687576 kB\n" +
  "SwapCached:          408 kB\n";

export const cpuModel = "12th Gen Intel(R) Core(TM) i7-12700H";
export const cpuCores = 20;

export const cpuTimesCore0 = {
  user: 344050,
  nice: 1386270,
  sys: 158850,
  idle: 10239620,
  irq: 12440,
};
