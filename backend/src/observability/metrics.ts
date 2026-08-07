import { monitorEventLoopDelay } from "perf_hooks";

/**
 * Minimal Prometheus-format metrics registry.
 *
 * Hand-rolled rather than pulling in prom-client, for the same reason the SSE
 * hub and the credit ledger are hand-rolled here: this is a small, exactly
 * understood surface in a process that handles medical data, and the exposition
 * format is a stable, trivially implementable text protocol. If this grows past
 * histograms and gauges - exemplars, native histograms, pushgateway - swap in
 * prom-client rather than extending this.
 *
 * What matters for correctness is that the output is scrapeable as-is by
 * Prometheus, and that a runaway label value cannot take the process down.
 */

export type Labels = Record<string, string>;

/**
 * Ceiling on distinct label combinations per metric.
 *
 * An unbounded label - a job id, a user email, an unmatched URL path - turns a
 * metric into an unbounded memory leak, and it fails slowly enough that it is
 * usually found in production. Past this many series a metric stops accepting
 * new label sets and says so once.
 */
const MAX_SERIES_PER_METRIC = 500;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  if (Number.isNaN(value)) return "NaN";
  return String(value);
}

abstract class Metric {
  protected overflowed = false;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = []
  ) {}

  /** Stable key for a label set, so {a,b} and {b,a} are the same series. */
  protected key(labels: Labels): string {
    return this.labelNames.map((n) => labels[n] ?? "").join("\u0000");
  }

  protected renderLabels(key: string, extra?: [string, string]): string {
    const values = key === "" ? [] : key.split("\u0000");
    const pairs = this.labelNames.map((n, i) => `${n}="${escapeLabelValue(values[i] ?? "")}"`);
    if (extra) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
    return pairs.length ? `{${pairs.join(",")}}` : "";
  }

  /** True when this label set may be recorded. Enforces the series ceiling. */
  protected admit(store: Map<string, unknown>, key: string): boolean {
    if (store.has(key) || store.size < MAX_SERIES_PER_METRIC) return true;
    if (!this.overflowed) {
      this.overflowed = true;
      console.error(
        `[metrics] ${this.name} exceeded ${MAX_SERIES_PER_METRIC} label sets; ` +
        `dropping new series. A label is unbounded - check its cardinality.`
      );
    }
    return false;
  }

  abstract render(): string;
}

export class Counter extends Metric {
  private values = new Map<string, number>();

  inc(labels: Labels = {}, value = 1) {
    const key = this.key(labels);
    if (!this.admit(this.values, key)) return;
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    // A counter with no observations yet is still worth exposing at zero when
    // it has no labels: absent series and zero series alert differently.
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${this.renderLabels(key)} ${formatNumber(value)}`);
    }
    return lines.join("\n");
  }
}

export class Gauge extends Metric {
  private values = new Map<string, number>();

  set(labels: Labels, value: number) {
    const key = this.key(labels);
    if (!this.admit(this.values, key)) return;
    this.values.set(key, value);
  }

  /** Drops every series, so a gauge sampled from a list cannot keep stale keys. */
  reset() {
    this.values.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${this.renderLabels(key)} ${formatNumber(value)}`);
    }
    return lines.join("\n");
  }
}

interface HistogramSeries {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  private series = new Map<string, HistogramSeries>();

  constructor(
    name: string,
    help: string,
    readonly buckets: readonly number[],
    labelNames: readonly string[] = []
  ) {
    super(name, help, labelNames);
  }

  observe(labels: Labels, value: number) {
    const key = this.key(labels);
    if (!this.admit(this.series, key)) return;

    let entry = this.series.get(key);
    if (!entry) {
      entry = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }

    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) entry.counts[i] += 1;
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, entry] of this.series) {
      // Prometheus buckets are cumulative: each is "how many <= le".
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += entry.counts[i];
        lines.push(
          `${this.name}_bucket${this.renderLabels(key, ["le", formatNumber(this.buckets[i])])} ${cumulative}`
        );
      }
      lines.push(`${this.name}_bucket${this.renderLabels(key, ["le", "+Inf"])} ${entry.count}`);
      lines.push(`${this.name}_sum${this.renderLabels(key)} ${formatNumber(entry.sum)}`);
      lines.push(`${this.name}_count${this.renderLabels(key)} ${entry.count}`);
    }
    return lines.join("\n");
  }
}

/** Bucket sets, chosen for what each measurement actually looks like. */
export const BUCKETS = {
  /** HTTP handler latency: sub-millisecond to a stalled request. */
  http: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const,
  /** GPU execution: the simulated model takes 5s; a real CT volume is minutes. */
  gpu: [1, 2, 5, 10, 30, 60, 120, 300, 600] as const,
  /** Queue wait. This is the autoscaling signal - it must resolve at 10 minutes. */
  queueWait: [1, 5, 10, 30, 60, 120, 300, 600, 1800] as const,
};

/**
 * A collector runs at scrape time.
 *
 * Gauges whose value lives in some other object - pool counters, connection
 * maps, database rows - are sampled here rather than pushed on every change,
 * so nothing on the hot path pays for a metric nobody scrapes.
 */
type Collector = () => void | Promise<void>;

export class Registry {
  private metrics: Metric[] = [];
  private collectors: Collector[] = [];

  register<T extends Metric>(metric: T): T {
    this.metrics.push(metric);
    return metric;
  }

  addCollector(collector: Collector) {
    this.collectors.push(collector);
  }

  async render(): Promise<string> {
    for (const collect of this.collectors) {
      try {
        await collect();
      } catch (err) {
        // A failing collector must not fail the scrape - losing one gauge is
        // recoverable, losing all visibility during an incident is not.
        console.error("[metrics] collector failed:", err);
      }
    }
    return this.metrics.map((m) => m.render()).join("\n") + "\n";
  }
}

export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Process-level metrics, registered once per process.
 *
 * Event loop lag is the one that matters most here and is the easiest to miss:
 * a saturated loop shows as slow requests with idle CPU and a healthy database,
 * which reads like a network problem and is not.
 */
export function registerRuntimeMetrics(registry: Registry, role: "api" | "worker") {
  const startedAt = Date.now();

  const info = registry.register(
    new Gauge("irismono_build_info", "Always 1. Labels carry process identity.", [
      "role",
      "version",
      "node_version",
    ])
  );
  info.set(
    {
      role,
      version: process.env.APP_VERSION || "dev",
      node_version: process.version,
    },
    1
  );

  const uptime = registry.register(
    new Gauge("process_uptime_seconds", "Seconds since this process started.", ["role"])
  );
  const residentMemory = registry.register(
    new Gauge("process_resident_memory_bytes", "Resident set size.", ["role"])
  );
  const heapUsed = registry.register(
    new Gauge("nodejs_heap_used_bytes", "V8 heap in use.", ["role"])
  );
  const loopLag = registry.register(
    new Gauge(
      "nodejs_eventloop_lag_seconds",
      "Event loop delay since the last scrape. Labelled by quantile.",
      ["role", "quantile"]
    )
  );

  // Enabled on the first scrape rather than at import. Importing a module that
  // records a metric should not start a sampler - the test suites import the
  // credit funnel, and a monitor left running in a short-lived script is a
  // handle nobody asked for.
  let loop: ReturnType<typeof monitorEventLoopDelay> | null = null;

  registry.addCollector(() => {
    if (!loop) {
      loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
    }

    uptime.set({ role }, (Date.now() - startedAt) / 1000);

    const memory = process.memoryUsage();
    residentMemory.set({ role }, memory.rss);
    heapUsed.set({ role }, memory.heapUsed);

    // Nanoseconds to seconds. Reset each scrape so the window is the scrape
    // interval, not "since boot" - a spike an hour ago must not hide in p99.
    loopLag.set({ role, quantile: "0.5" }, loop.percentile(50) / 1e9);
    loopLag.set({ role, quantile: "0.99" }, loop.percentile(99) / 1e9);
    loopLag.set({ role, quantile: "max" }, loop.max / 1e9);
    loop.reset();
  });
}
