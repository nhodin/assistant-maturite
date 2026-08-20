import { describe, it, expect, vi } from "vitest";
import {
  captureThrottlingFromEnv,
  applyThrottling,
  describeThrottling,
  NETWORK_PROFILES,
} from "../src/collector/throttling";

describe("captureThrottlingFromEnv", () => {
  it("throttles nothing on an empty environment", () => {
    expect(captureThrottlingFromEnv({})).toEqual({ cpuRate: 1 });
  });

  it("reads a CPU slowdown multiplier", () => {
    expect(captureThrottlingFromEnv({ CAPTURE_CPU_THROTTLING: " 4 " }).cpuRate).toBe(4);
    expect(captureThrottlingFromEnv({ CAPTURE_CPU_THROTTLING: "1.5" }).cpuRate).toBe(1.5);
  });

  it("treats the explicit off values and a blank line as no CPU throttling", () => {
    for (const raw of ["0", "off", "none", "false", "  "]) {
      const t = captureThrottlingFromEnv({ CAPTURE_CPU_THROTTLING: raw });
      expect(t.cpuRate).toBe(1);
      expect(t.warning).toBeUndefined();
    }
  });

  it("falls back to no CPU throttling with a warning on a malformed rate", () => {
    const t = captureThrottlingFromEnv({ CAPTURE_CPU_THROTTLING: "fast" });
    expect(t.cpuRate).toBe(1);
    expect(t.warning).toMatch(/CAPTURE_CPU_THROTTLING/);
  });

  it("rejects a rate below 1 rather than speeding the CPU up", () => {
    expect(captureThrottlingFromEnv({ CAPTURE_CPU_THROTTLING: "0.5" }).cpuRate).toBe(1);
  });

  it("resolves a network profile by name, case-insensitively", () => {
    const t = captureThrottlingFromEnv({ CAPTURE_NETWORK_PROFILE: "Slow4G" });
    expect(t.network).toBe(NETWORK_PROFILES.slow4g);
    expect(t.network?.latencyMs).toBe(150);
    expect(t.network?.downloadBytesPerSec).toBe(200000); // 1.6 Mbps in bytes/s
  });

  it("keeps the network unthrottled on an unknown profile, with a warning", () => {
    const t = captureThrottlingFromEnv({ CAPTURE_NETWORK_PROFILE: "3g-ish" });
    expect(t.network).toBeUndefined();
    expect(t.warning).toMatch(/CAPTURE_NETWORK_PROFILE/);
  });

  it("accepts off as a network profile value", () => {
    const t = captureThrottlingFromEnv({ CAPTURE_NETWORK_PROFILE: "off" });
    expect(t.network).toBeUndefined();
    expect(t.warning).toBeUndefined();
  });

  it("combines both settings", () => {
    const t = captureThrottlingFromEnv({
      CAPTURE_CPU_THROTTLING: "4",
      CAPTURE_NETWORK_PROFILE: "slow3g",
    });
    expect(t.cpuRate).toBe(4);
    expect(t.network?.id).toBe("slow3g");
  });
});

describe("applyThrottling", () => {
  it("sends nothing when both throttles are off", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await applyThrottling({ send }, { cpuRate: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the CDP commands for the resolved settings", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await applyThrottling({ send }, { cpuRate: 4, network: NETWORK_PROFILES.slow4g });
    expect(send).toHaveBeenCalledWith("Emulation.setCPUThrottlingRate", { rate: 4 });
    expect(send).toHaveBeenCalledWith("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 200000,
      uploadThroughput: 93750,
    });
  });

  it("survives a browser that refuses the commands", async () => {
    const send = vi.fn().mockRejectedValue(new Error("not supported"));
    await expect(
      applyThrottling({ send }, { cpuRate: 4, network: NETWORK_PROFILES.slow4g }),
    ).resolves.toBeUndefined();
  });
});

describe("describeThrottling", () => {
  it("says plainly when nothing is throttled", () => {
    expect(describeThrottling({ cpuRate: 1 })).toBe(
      "CPU unthrottled, network unthrottled (machine's own)",
    );
  });

  it("names the rate and the profile when they are set", () => {
    const line = describeThrottling({ cpuRate: 4, network: NETWORK_PROFILES.slow4g });
    expect(line).toContain("CPU ×4");
    expect(line).toContain("Slow 4G");
  });
});
