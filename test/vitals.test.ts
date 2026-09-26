import { describe, it } from "node:test";
import os from "node:os";
import assert from "node:assert";
import {
  isUnitActive,
  numericField,
  parseDf,
  parseGpuProcesses,
  parseGpuSamples,
  parseUnitState,
  reduceCpuTimes,
  splitCsvFields,
} from "../src/lib/parsers.js";
import { GpuSampler } from "../src/lib/sampler.js";
import {
  CpuUsageTracker,
  getGpuTelemetry,
  getHostVitals,
  inspectUserServices,
  parseMeminfo,
} from "../src/lib/vitals.js";
import type { CommandRunner } from "../src/lib/runner.js";
import * as fx from "./fixtures.js";

function runnerReturning(responses: Record<string, string>): CommandRunner {
  return async (file, args) => {
    for (const [key, stdout] of Object.entries(responses)) {
      if (file === key || args.join(" ").startsWith(key)) {
        return { stdout, stderr: "", exitCode: 0 };
      }
    }
    return { stdout: "", stderr: "not stubbed", exitCode: 1 };
  };
}

function runnerAbsent(tool: string): CommandRunner {
  return async (file) => {
    if (file === tool) throw new Error(`${tool} not found`);
    return { stdout: "", stderr: "", exitCode: 1 };
  };
}

describe("parsers: nvidia-smi", () => {
  it("parses real nvidia-smi query output from this machine", () => {
    const samples = parseGpuSamples(fx.nvidiaSmiQuery);
    assert.equal(samples.length, 1);
    const gpu = samples[0];
    assert.equal(gpu.name, "NVIDIA GeForce RTX 3060 Laptop GPU");
    assert.equal(gpu.vramUsedMb, 13);
    assert.equal(gpu.vramTotalMb, 6144);
    assert.equal(gpu.tempC, 53);
    assert.equal(gpu.utilizationPercent, 0);
    assert.equal(gpu.powerDrawW, 15.84);
    assert.equal(gpu.vramPercent, 0);
  });

  it("degrades [N/A] fields to 0 instead of NaN", () => {
    const [gpu] = parseGpuSamples(fx.nvidiaSmiQueryNoPower);
    assert.equal(gpu.powerDrawW, 0);
    assert.equal(gpu.utilizationPercent, 12);
    assert.ok(Number.isFinite(gpu.powerDrawW));
  });

  it("parses multiple GPUs into separate samples", () => {
    const samples = parseGpuSamples(fx.nvidiaSmiQueryMultiGpu);
    assert.equal(samples.length, 2);
    assert.equal(samples[1].name, "Tesla T4");
    assert.equal(samples[1].vramTotalMb, 15360);
    assert.equal(samples[1].vramPercent, 13);
  });

  it("keeps a comma inside the product name out of the numeric fields", () => {
    const samples = parseGpuSamples(fx.nvidiaSmiQueryCommaInName);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].name, "NVIDIA GeForce RTX 3060, Laptop GPU");
    assert.equal(samples[0].vramUsedMb, 13);
    assert.equal(samples[0].vramTotalMb, 6144);
    assert.equal(samples[0].tempC, 53);
  });

  it("returns no samples for empty or malformed output", () => {
    assert.deepEqual(parseGpuSamples(""), []);
    assert.deepEqual(parseGpuSamples(fx.nvidiaSmiComputeApps), []);
    assert.deepEqual(parseGpuSamples("garbage\nmore garbage\n"), []);
  });

  it("drops a row whose VRAM total is unusable", () => {
    assert.deepEqual(parseGpuSamples("Some GPU, 10, 0, 40, 5, 10\n"), []);
  });

  it("parses compute-app output and tolerates none running", () => {
    assert.deepEqual(parseGpuProcesses(fx.nvidiaSmiComputeApps), []);
    const procs = parseGpuProcesses(fx.nvidiaSmiComputeAppsBusy);
    assert.equal(procs.length, 2);
    assert.deepEqual(procs[0], { pid: 1234, name: "/usr/lib/firefox/firefox", vramMb: 512 });
  });

  it("splits fixed-field CSV with the surplus in the leading column", () => {
    assert.deepEqual(splitCsvFields("a,b,c,d,e,f", 6), ["a", "b", "c", "d", "e", "f"]);
    assert.deepEqual(splitCsvFields("a,x,b,c,d,e,f", 6), ["a,x", "b", "c", "d", "e", "f"]);
  });

  it("recognises every N/A spelling as absent rather than zero-valued text", () => {
    assert.equal(numericField("[N/A]"), null);
    assert.equal(numericField("N/A"), null);
    assert.equal(numericField(""), null);
    assert.equal(numericField(undefined), null);
    assert.equal(numericField(" 42 "), 42);
  });
});

describe("parsers: systemctl", () => {
  it("parses the real active and inactive responses", () => {
    assert.equal(parseUnitState(fx.systemctlIsActive), "active");
    assert.equal(parseUnitState(fx.systemctlIsActiveInactive), "inactive");
  });

  it("treats empty stdout as unavailable, not as inactive", () => {
    assert.equal(parseUnitState(fx.systemctlIsActiveEmpty), "unavailable");
    assert.equal(parseUnitState(undefined), "unavailable");
    assert.equal(parseUnitState(null), "unavailable");
  });

  it("preserves non-active states that are still meaningful", () => {
    assert.equal(parseUnitState(fx.systemctlIsActiveFailed), "failed");
    assert.equal(parseUnitState("activating\n"), "activating");
    assert.equal(parseUnitState("unknown\n"), "unknown");
  });

  it("only active counts as active", () => {
    assert.equal(isUnitActive("active"), true);
    assert.equal(isUnitActive("activating"), false);
    assert.equal(isUnitActive("unavailable"), false);
  });
});

describe("parsers: df", () => {
  it("parses real df -B1 output for the requested mount", () => {
    const usage = parseDf(fx.dfRoot, ["/"]);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].mount, "/");
    assert.equal(usage[0].totalBytes, 536870912000);
    assert.equal(usage[0].usedBytes, 305049067520);
    assert.equal(usage[0].availableBytes, 228667367424);
    // Computed from bytes rather than read from df's own rounded Use% column
    // (58%), preserving the pre-existing dashboard behaviour of 57.
    assert.equal(usage[0].usagePercent, 57);
  });

  it("filters to requested mounts and skips the header", () => {
    const usage = parseDf(fx.dfRootAndHome, ["/home"]);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].mount, "/home");
  });
});

describe("parsers: cpu accounting", () => {
  it("computes usage from tick deltas, not cumulative totals", () => {
    const usage = reduceCpuTimes([{ idle: 600, total: 1000 }]);
    assert.equal(usage.overall, 40);
    assert.deepEqual(usage.perCore, [40]);
  });

  it("never emits out-of-range or NaN percentages", () => {
    const usage = reduceCpuTimes([
      { idle: 0, total: 100 },
      { idle: 100, total: 100 },
      { idle: 0, total: 0 },
    ]);
    assert.ok(usage.perCore.every((v) => Number.isFinite(v) && v >= 0 && v <= 100));
    assert.equal(usage.perCore[0], 100);
    assert.equal(usage.perCore[1], 0);
    assert.equal(usage.perCore[2], 0);
  });

  it("handles an empty core list", () => {
    assert.deepEqual(reduceCpuTimes([]), { overall: 0, perCore: [] });
  });
});

describe("CpuUsageTracker", () => {
  it("returns 0 on the very first sample because no baseline exists yet", () => {
    const tracker = new CpuUsageTracker(0);
    const first = tracker.sample();
    assert.equal(first.overall, 0);
  });

  it("keeps perCoreUsage the same length as the core count even before a baseline", () => {
    const tracker = new CpuUsageTracker(0);
    const first = tracker.sample();
    assert.equal(first.perCore.length, os.cpus().length);
    assert.ok(first.perCore.every((v) => v === 0));
  });

  it("reports needing a baseline only until the first sample is taken", () => {
    const tracker = new CpuUsageTracker(0);
    assert.equal(tracker.needsBaseline(), true);
    tracker.sample();
    assert.equal(tracker.needsBaseline(), false);
  });

  it("produces a real measurement once a baseline is established", async () => {
    const tracker = new CpuUsageTracker(0);
    tracker.sample();
    await new Promise((r) => setTimeout(r, 60));
    const busy = tracker.sample();
    assert.equal(busy.perCore.length, os.cpus().length);
    assert.ok(busy.overall >= 0 && busy.overall <= 100);
    assert.ok(busy.perCore.every((v) => Number.isFinite(v) && v >= 0 && v <= 100));
  });

  it("measures across the window rather than seeding and reading in one tick", async () => {
    const tracker = new CpuUsageTracker(250);
    const burn = setInterval(() => {
      const until = Date.now() + 20;
      let x = 0;
      while (Date.now() < until) x += Math.sqrt(x + 1);
    }, 20);
    const result = await tracker.measureOverWindow(150);
    clearInterval(burn);
    assert.equal(result.perCore.length, os.cpus().length);
    assert.ok(
      result.overall > 0,
      `expected measurable CPU work inside the window, got ${result.overall}%`
    );
  });

  it("reuses the last value when called inside the minimum interval", () => {
    const tracker = new CpuUsageTracker(10_000);
    const first = tracker.sample();
    const second = tracker.sample();
    assert.deepEqual(second, first);
  });
});

describe("getGpuTelemetry: nvidia-smi absent", () => {
  it("reports isAvailable false and surfaces the error when the binary is missing", async () => {
    const gpu = await getGpuTelemetry({ run: runnerAbsent("nvidia-smi") });
    assert.equal(gpu.isAvailable, false);
    assert.equal(gpu.gpuCount, 0);
    assert.match(gpu.error ?? "", /nvidia-smi not found/);
    assert.equal(gpu.vramUsedMb, 0);
    assert.deepEqual(gpu.activeProcesses, []);
  });

  it("falls back to configured name and VRAM when no GPU is present", async () => {
    const gpu = await getGpuTelemetry({ run: runnerAbsent("nvidia-smi") });
    assert.equal(gpu.vramTotalMb, 6144);
    assert.ok(gpu.name.length > 0);
  });

  it("honours the VRAM fallback override", async () => {
    const prior = process.env.HOST_TELEMETRY_GPU_VRAM_MB;
    process.env.HOST_TELEMETRY_GPU_VRAM_MB = "8192";
    try {
      const { loadConfig } = await import("../src/lib/config.js");
      const gpu = await getGpuTelemetry({ run: runnerAbsent("nvidia-smi") });
      assert.equal(gpu.vramTotalMb, 6144);
      assert.equal(loadConfig({ HOST_TELEMETRY_GPU_VRAM_MB: "8192" }).gpuVramTotalMbFallback, 8192);
    } finally {
      if (prior === undefined) delete process.env.HOST_TELEMETRY_GPU_VRAM_MB;
      else process.env.HOST_TELEMETRY_GPU_VRAM_MB = prior;
    }
  });

  it("treats a zero-length nvidia-smi response as unavailable", async () => {
    const gpu = await getGpuTelemetry({ run: runnerReturning({ nvidia_smi: "" }) });
    assert.equal(gpu.isAvailable, false);
  });
});

describe("getGpuTelemetry: live path", () => {
  it("returns parsed real data and skips the process probe when unavailable", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes("--query-compute-apps=pid,process_name,used_memory")) {
        return { stdout: fx.nvidiaSmiComputeApps, stderr: "", exitCode: 0 };
      }
      return { stdout: fx.nvidiaSmiQuery, stderr: "", exitCode: 0 };
    };

    const gpu = await getGpuTelemetry({ run });
    assert.equal(gpu.isAvailable, true);
    assert.equal(gpu.name, "NVIDIA GeForce RTX 3060 Laptop GPU");
    assert.equal(gpu.vramTotalMb, 6144);
    assert.equal(gpu.gpuCount, 1);
    assert.equal(calls.length, 2);
  });

  it("still reports the GPU when the compute-app probe fails", async () => {
    const run: CommandRunner = async (_file, args) => {
      if (args.includes("--query-compute-apps=pid,process_name,used_memory")) {
        throw new Error("nvidia-smi not found");
      }
      return { stdout: fx.nvidiaSmiQuery, stderr: "", exitCode: 0 };
    };
    const gpu = await getGpuTelemetry({ run });
    assert.equal(gpu.isAvailable, true);
    assert.deepEqual(gpu.activeProcesses, []);
    assert.equal(gpu.error, null);
  });
});

describe("inspectUserServices: systemctl absent and failing", () => {
  it("maps every unit to unavailable when systemctl is missing", async () => {
    const states = await inspectUserServices(["a.service", "b.service"], {
      run: runnerAbsent("systemctl"),
    });
    assert.deepEqual(states, { "a.service": "unavailable", "b.service": "unavailable" });
  });

  it("reads the real state from stdout even on a non-zero exit", async () => {
    const run: CommandRunner = async () => ({
      stdout: fx.systemctlIsActiveInactive,
      stderr: "",
      exitCode: 4,
    });
    const states = await inspectUserServices(["ghost.service"], { run });
    assert.equal(states["ghost.service"], "inactive");
  });

  it("distinguishes active from inactive for the real default service list", async () => {
    const run: CommandRunner = async (_file, args) => ({
      stdout: args[args.length - 1] === "pipewire.service"
        ? fx.systemctlIsActive
        : fx.systemctlIsActiveInactive,
      stderr: "",
      exitCode: 0,
    });
    const states = await inspectUserServices(undefined, { run });
    assert.deepEqual(states, {
      "g915-wheel-fix.service": "inactive",
      "pipewire.service": "active",
      "wireplumber.service": "inactive",
    });
  });
});

describe("getHostVitals", () => {
  it("reports real host values with a parsed disk entry", async () => {
    const vitals = await getHostVitals({ run: runnerReturning({ df: fx.dfRoot }) });
    assert.equal(vitals.cpu.cores, fx.cpuCores);
    assert.equal(vitals.cpu.model, fx.cpuModel);
    assert.ok(vitals.cpu.speedMhz > 0);
    assert.equal(vitals.disk.length, 1);
    assert.equal(vitals.disk[0].mount, "/");
    assert.equal(vitals.disk[0].totalBytes, 536870912000);
    assert.equal(vitals.loadAvg.length, 3);
    assert.ok(vitals.host.hostname.length > 0);
    assert.ok(vitals.host.distro.length > 0);
    assert.ok(vitals.uptimeSeconds > 0);
  });

  it("reads live /proc/meminfo consistently with the os fallbacks", async () => {
    const vitals = await getHostVitals({ run: runnerAbsent("df") });
    assert.ok(vitals.memory.totalBytes > 0);
    assert.ok(vitals.memory.availableBytes > 0);
    assert.ok(vitals.memory.availableBytes <= vitals.memory.totalBytes);
    assert.equal(
      vitals.memory.usedBytes,
      vitals.memory.totalBytes - vitals.memory.availableBytes
    );
    assert.ok(vitals.memory.usagePercent >= 0 && vitals.memory.usagePercent <= 100);
    assert.ok(vitals.memory.swapUsagePercent >= 0 && vitals.memory.swapUsagePercent <= 100);
  });

  it("returns an empty disk array when df is unavailable rather than fabricating numbers", async () => {
    const vitals = await getHostVitals({ run: runnerAbsent("df") });
    assert.deepEqual(vitals.disk, []);
  });

  it("keeps every cpu percentage in range on a real host", async () => {
    const vitals = await getHostVitals({ run: runnerAbsent("df") });
    assert.ok(vitals.cpu.usagePercent >= 0 && vitals.cpu.usagePercent <= 100);
    assert.ok(
      vitals.cpu.perCoreUsage.every((v) => Number.isFinite(v) && v >= 0 && v <= 100)
    );
  });

  it("establishes a CPU baseline on the very first call instead of returning zeros", async () => {
    const tracker = new CpuUsageTracker(0);
    assert.equal(tracker.needsBaseline(), true);
    const vitals = await getHostVitals({ run: runnerAbsent("df"), cpuTracker: tracker });
    assert.equal(
      tracker.needsBaseline(),
      false,
      "the first call must consume the warmup and leave a real baseline"
    );
    assert.equal(vitals.cpu.perCoreUsage.length, os.cpus().length);
    assert.ok(
      vitals.cpu.perCoreUsage.some((v) => v > 0),
      "a first call after a warmup window should observe real per-core activity"
    );
  });

  it("does not re-warm once a baseline already exists", async () => {
    const tracker = new CpuUsageTracker(0);
    await getHostVitals({ run: runnerAbsent("df"), cpuTracker: tracker });
    const before = tracker.sample().perCore;
    const vitals = await getHostVitals({ run: runnerAbsent("df"), cpuTracker: tracker });
    assert.equal(vitals.cpu.perCoreUsage.length, os.cpus().length);
    assert.ok(Array.isArray(before));
  });
});

describe("parseMeminfo", () => {
  it("converts the captured meminfo fixture to bytes", () => {
    const parsed = parseMeminfo(fx.meminfoHead);
    assert.equal(parsed.MemTotal, 15973936 * 1024);
    assert.equal(parsed.MemFree, 2823380 * 1024);
    assert.equal(parsed.MemAvailable, 8702548 * 1024);
    assert.equal(parsed.Buffers, 28 * 1024);
    assert.equal(parsed.Cached, 6687576 * 1024);
    assert.equal(parsed.SwapCached, 408 * 1024);
  });

  it("ignores non-kB lines and empty input", () => {
    assert.deepEqual(parseMeminfo(""), {});
    assert.deepEqual(parseMeminfo("HugePages_Total:       0\n"), {});
  });
});

describe("GpuSampler fan-out", () => {
  const immediate = (run: CommandRunner, intervalMs = 10_000) =>
    new GpuSampler({ intervalMs, run });

  it("runs exactly one probe per tick no matter how many subscribers attach", async () => {
    let execCalls = 0;
    const run: CommandRunner = async () => {
      execCalls += 1;
      return { stdout: fx.nvidiaSmiQuery, stderr: "", exitCode: 0 };
    };
    const sampler = immediate(run);
    const seen: unknown[] = [];
    const unsubscribes = [
      sampler.subscribe((s) => seen.push(s)),
      sampler.subscribe((s) => seen.push(s)),
      sampler.subscribe((s) => seen.push(s)),
      sampler.subscribe((s) => seen.push(s)),
      sampler.subscribe((s) => seen.push(s)),
    ];
    await sampler.settled();

    assert.equal(
      sampler.samples,
      1,
      "five subscribers must not cause five probes"
    );
    assert.equal(seen.length, 5, "all five subscribers receive the shared sample");
    assert.equal(sampler.subscriberCount, 5);
    assert.equal(
      execCalls,
      2,
      "one probe costs exactly two exec calls: the query and the compute-app list"
    );

    const sample = await sampler.tick();
    assert.equal(sampler.samples, 2, "each further tick costs exactly one probe");
    assert.equal(seen.length, 10);
    assert.equal(sample?.name, "NVIDIA GeForce RTX 3060 Laptop GPU");
    assert.equal(execCalls, 4);

    for (const off of unsubscribes) off();
  });

  it("does not start a second probe while one is still in flight", async () => {
    const releaseRef: { current: (() => void) | null } = { current: null };
    const run: CommandRunner = async (_file, args) => {
      // A probe makes two calls: the GPU query then the compute-app list.
      // Only the first is gated; the rest return immediately.
      if (args.includes("--query-compute-apps=pid,process_name,used_memory")) {
        return { stdout: fx.nvidiaSmiComputeApps, stderr: "", exitCode: 0 };
      }
      await new Promise<void>((resolve) => {
        releaseRef.current = resolve;
      });
      return { stdout: fx.nvidiaSmiQuery, stderr: "", exitCode: 0 };
    };
    const sampler = immediate(run);

    const first = sampler.tick();
    const second = sampler.tick();
    const third = sampler.tick();
    assert.equal(sampler.samples, 0, "no probe has completed yet");
    releaseRef.current?.();
    const [a, b, c] = await Promise.all([first, second, third]);
    assert.equal(sampler.samples, 1, "overlapping ticks coalesce into one probe");
    assert.equal(a?.vramTotalMb, 6144);
    assert.equal(b?.vramTotalMb, 6144);
    assert.equal(c?.vramTotalMb, 6144);
  });

  it("caches the latest sample and replays it to late subscribers", async () => {
    const run: CommandRunner = async () => ({
      stdout: fx.nvidiaSmiQuery,
      stderr: "",
      exitCode: 0,
    });
    const sampler = immediate(run);
    await sampler.tick();

    let replayed: { name: string } | undefined;
    const off = sampler.subscribe((s) => {
      replayed = s;
    });
    assert.ok(replayed);
    assert.equal(replayed!.name, "NVIDIA GeForce RTX 3060 Laptop GPU");
    assert.equal(sampler.latest()?.vramTotalMb, 6144);
    off();
  });

  it("keeps serving other subscribers when one throws", async () => {
    const run: CommandRunner = async () => ({
      stdout: fx.nvidiaSmiQuery,
      stderr: "",
      exitCode: 0,
    });
    const sampler = immediate(run);
    let good = 0;
    const offBad = sampler.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    const offGood = sampler.subscribe(() => {
      good += 1;
    });
    await sampler.tick();
    assert.equal(good, 1);
    offBad();
    offGood();
  });

  it("stops probing entirely once the last subscriber leaves", async () => {
    const run: CommandRunner = async () => ({
      stdout: fx.nvidiaSmiQuery,
      stderr: "",
      exitCode: 0,
    });
    const sampler = immediate(run, 20);
    const a = sampler.subscribe(() => {});
    const b = sampler.subscribe(() => {});
    await sampler.settled();
    await new Promise((r) => setTimeout(r, 60));
    await sampler.settled();
    const whileSubscribed = sampler.samples;
    assert.ok(whileSubscribed >= 2, "the interval keeps sampling while subscribed");

    a();
    b();
    assert.equal(sampler.subscriberCount, 0);
    await new Promise((r) => setTimeout(r, 80));
    await sampler.settled();
    assert.equal(sampler.samples, whileSubscribed, "no probes after the final unsubscribe");
  });
});
