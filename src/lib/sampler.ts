import { config } from "./config.js";
import { probeGpu, type GpuTelemetry } from "./vitals.js";
import { execRunner, type CommandRunner } from "./runner.js";

type Subscriber = (sample: GpuTelemetry) => void;

export interface GpuSamplerOptions {
  intervalMs?: number;
  run?: CommandRunner;
}

/**
 * One probe per interval regardless of how many consumers are attached.
 *
 * The interval is reference-counted: the first subscriber starts it, the last
 * unsubscribe stops it, so a dashboard with no open stream costs no forks at
 * all. A probe already in flight causes the next tick to be skipped rather
 * than queued, which bounds the sampler at one concurrent nvidia-smi even if a
 * probe is slow.
 */
export class GpuSampler {
  private subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<GpuTelemetry | null> | null = null;
  private latestSample: GpuTelemetry | null = null;
  private probeCount = 0;

  constructor(private readonly options: GpuSamplerOptions = {}) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get samples(): number {
    return this.probeCount;
  }

  latest(): GpuTelemetry | null {
    return this.latestSample;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    this.start();

    if (this.latestSample) {
      try {
        subscriber(this.latestSample);
      } catch {
        /* a failing subscriber must not stop the sampler */
      }
    }

    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /**
   * Concurrent callers share a single probe and all observe its result, so a
   * burst of subscribers can never fan out into a burst of nvidia-smi forks.
   */
  async tick(): Promise<GpuTelemetry | null> {
    if (this.pending) return this.pending;

    this.pending = this.runProbe();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async runProbe(): Promise<GpuTelemetry | null> {    const sample = await probeGpu(this.options.run ?? execRunner);
    this.probeCount += 1;
    this.latestSample = sample;
    for (const subscriber of this.subscribers) {
      try {
        subscriber(sample);
      } catch {
        /* isolated per subscriber */
      }
    }
    return sample;
  }

  /** Resolves once no probe is in flight, so callers can observe a settled state. */
  async settled(): Promise<void> {
    if (this.pending) await this.pending;
  }

  private start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? config.gpuIntervalMs;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export const gpuSampler = new GpuSampler();
