/**
 * Capture throttling — the CPU slowdown and network conditions the collector
 * applies over CDP before it navigates.
 *
 * Both are OFF by default. That is a deliberate choice about comparability: a
 * throttle changes every timing-based control (TTFB, LCP, long tasks, the 2 s
 * render gate), so it must be an explicit, declared decision of the operator
 * rather than something a run inherits silently. Turning either on makes the run
 * comparable with other throttled runs — and NOT comparable with the historical
 * unthrottled ones.
 *
 * Note the asymmetry with what a browser does on its own: mobile emulation
 * (iPhone 13 viewport/DPR/UA) is applied for real, but the CPU stays desktop-class
 * and the network stays the machine's. So an unthrottled mobile capture is a
 * mobile *layout* on desktop-class hardware — structural controls (formats,
 * lazyload, head order, headers) are unaffected, timing controls read optimistic.
 *
 * Variables (all optional, see .env.example):
 *   CAPTURE_CPU_THROTTLING    CPU slowdown multiplier, 1 = off (default 1).
 *                             e.g. 4 for the Lighthouse mobile slowdown.
 *   CAPTURE_NETWORK_PROFILE   off (default) | slow3g | slow4g | fast4g
 */

/** CDP `Network.emulateNetworkConditions` parameters, in CDP units. */
export interface NetworkProfile {
  /** Profile key as written in the environment. */
  id: string;
  /** One-line description for logs. */
  label: string;
  /** Round-trip latency in ms. */
  latencyMs: number;
  /** Download throughput in BYTES per second (CDP unit), -1 to disable. */
  downloadBytesPerSec: number;
  /** Upload throughput in BYTES per second (CDP unit), -1 to disable. */
  uploadBytesPerSec: number;
}

/** kbit/s → bytes/s, the unit CDP expects for throughput. */
function kbps(value: number): number {
  return (value * 1000) / 8;
}

/**
 * The presets, keyed by the value accepted in `CAPTURE_NETWORK_PROFILE`.
 *
 * `slow4g` reproduces Lighthouse's simulated slow 4G (1.6 Mbps / 750 kbps /
 * 150 ms), which is the reference most mobile performance budgets are written
 * against — it is the one to use when the audit's timing thresholds are meant to
 * mean anything about a real phone. `slow3g` and `fast4g` follow the classic
 * DevTools presets and exist to bracket it.
 */
export const NETWORK_PROFILES: Record<string, NetworkProfile> = {
  slow3g: {
    id: "slow3g",
    label: "Slow 3G — 400 kbps down / 400 kbps up / 2000 ms RTT",
    latencyMs: 2000,
    downloadBytesPerSec: kbps(400),
    uploadBytesPerSec: kbps(400),
  },
  slow4g: {
    id: "slow4g",
    label: "Slow 4G (Lighthouse mobile) — 1.6 Mbps down / 750 kbps up / 150 ms RTT",
    latencyMs: 150,
    downloadBytesPerSec: kbps(1600),
    uploadBytesPerSec: kbps(750),
  },
  fast4g: {
    id: "fast4g",
    label: "Fast 4G — 9 Mbps down / 1.5 Mbps up / 85 ms RTT",
    latencyMs: 85,
    downloadBytesPerSec: kbps(9000),
    uploadBytesPerSec: kbps(1500),
  },
};

/** Resolved throttling settings for a capture. */
export interface CaptureThrottling {
  /** CPU slowdown multiplier; 1 means no throttling is applied. */
  cpuRate: number;
  /** Network preset to emulate, or undefined for the machine's own network. */
  network?: NetworkProfile;
  /** Set when a value was unusable and the default was used instead. */
  warning?: string;
}

type Env = Record<string, string | undefined>;

/** Trimmed value, or undefined when unset/blank. */
function str(env: Env, name: string): string | undefined {
  const value = (env[name] ?? "").trim();
  return value === "" ? undefined : value;
}

/**
 * Read the throttling settings out of the environment.
 *
 * A malformed value never fails the capture: it degrades to "no throttling" with
 * a warning, because losing the audit over a typo in `.env` is worse than running
 * it unthrottled — and the warning says which one happened.
 */
export function captureThrottlingFromEnv(env: Env = process.env): CaptureThrottling {
  const warnings: string[] = [];

  // ── CPU ──
  let cpuRate = 1;
  const rawCpu = str(env, "CAPTURE_CPU_THROTTLING");
  if (rawCpu !== undefined) {
    const off = ["0", "off", "no", "none", "false"].includes(rawCpu.toLowerCase());
    const value = Number(rawCpu);
    if (off) {
      cpuRate = 1;
    } else if (Number.isFinite(value) && value >= 1) {
      cpuRate = value;
    } else {
      warnings.push(
        `CAPTURE_CPU_THROTTLING="${rawCpu}" is not a number >= 1 — CPU throttling stays off.`,
      );
    }
  }

  // ── Network ──
  let network: NetworkProfile | undefined;
  const rawNet = str(env, "CAPTURE_NETWORK_PROFILE");
  if (rawNet !== undefined) {
    const key = rawNet.toLowerCase();
    if (["off", "none", "0", "false"].includes(key)) {
      network = undefined;
    } else if (NETWORK_PROFILES[key]) {
      network = NETWORK_PROFILES[key];
    } else {
      warnings.push(
        `CAPTURE_NETWORK_PROFILE="${rawNet}" is unknown — network throttling stays off. ` +
          `Known profiles: off, ${Object.keys(NETWORK_PROFILES).join(", ")}.`,
      );
    }
  }

  return {
    cpuRate,
    ...(network ? { network } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

/** One-line, human-readable summary for run logs and the collect CLI. */
export function describeThrottling(t: CaptureThrottling): string {
  const cpu = t.cpuRate > 1 ? `CPU ×${t.cpuRate}` : "CPU unthrottled";
  const net = t.network ? t.network.label : "network unthrottled (machine's own)";
  return `${cpu}, ${net}`;
}

/**
 * The two CDP commands this module sends, declared as method overloads so that
 * Playwright's `CDPSession` — whose `send` is generic over the protocol keys —
 * satisfies it, and so does a test double.
 */
export interface ThrottlingCdpSession {
  send(method: "Emulation.setCPUThrottlingRate", params: { rate: number }): Promise<unknown>;
  send(
    method: "Network.emulateNetworkConditions",
    params: {
      offline: boolean;
      latency: number;
      downloadThroughput: number;
      uploadThroughput: number;
    },
  ): Promise<unknown>;
}

/**
 * Apply the settings to an open CDP session. Best effort by design: a browser
 * build that refuses either domain still produces an audit, and the structural
 * controls — the bulk of the grid — do not depend on the throttle.
 *
 * `Network.enable` must already have been sent by the caller.
 */
export async function applyThrottling(
  cdp: ThrottlingCdpSession,
  t: CaptureThrottling,
): Promise<void> {
  if (t.cpuRate > 1) {
    try {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: t.cpuRate });
    } catch {
      // Best effort — throttling failure must not abort capture.
    }
  }
  if (t.network) {
    try {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: t.network.latencyMs,
        downloadThroughput: t.network.downloadBytesPerSec,
        uploadThroughput: t.network.uploadBytesPerSec,
      });
    } catch {
      // Best effort — see above.
    }
  }
}
