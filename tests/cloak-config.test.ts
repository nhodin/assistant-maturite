import { describe, it, expect } from "vitest";
import {
  cloakConfigFromEnv,
  cloakLaunchOptions,
  maskKey,
  maskProxy,
} from "../src/collector/cloak-config";

describe("cloakConfigFromEnv", () => {
  it("falls back to the free-tier defaults on an empty environment", () => {
    const cfg = cloakConfigFromEnv({});
    expect(cfg).toEqual({
      licenseKey: undefined,
      proxy: undefined,
      geoip: false,
      humanize: true,
      humanPreset: "careful",
      headless: undefined,
      releaseChannel: undefined,
      browserVersion: undefined,
    });
  });

  it("treats a blank licence key as absent, so a placeholder .env line is harmless", () => {
    expect(cloakConfigFromEnv({ CLOAKBROWSER_LICENSE_KEY: "   " }).licenseKey).toBeUndefined();
  });

  it("reads the licence, proxy and human settings", () => {
    const cfg = cloakConfigFromEnv({
      CLOAKBROWSER_LICENSE_KEY: " cb_abc123 ",
      CLOAK_PROXY: "http://u:p@host:8080",
      CLOAK_HUMANIZE: "0",
      CLOAK_HUMAN_PRESET: "default",
      CLOAK_HEADLESS: "true",
      CLOAKBROWSER_RELEASE_CHANNEL: "preview",
    });
    expect(cfg.licenseKey).toBe("cb_abc123");
    expect(cfg.proxy).toBe("http://u:p@host:8080");
    expect(cfg.humanize).toBe(false);
    expect(cfg.humanPreset).toBe("default");
    expect(cfg.headless).toBe(true);
    expect(cfg.releaseChannel).toBe("preview");
  });

  it("ignores an unknown release channel or human preset", () => {
    const cfg = cloakConfigFromEnv({
      CLOAKBROWSER_RELEASE_CHANNEL: "nightly",
      CLOAK_HUMAN_PRESET: "reckless",
    });
    expect(cfg.releaseChannel).toBeUndefined();
    expect(cfg.humanPreset).toBe("careful");
  });
});

describe("cloakLaunchOptions", () => {
  it("omits optional keys so cloakbrowser's own fallbacks stay in play", () => {
    const options = cloakLaunchOptions(cloakConfigFromEnv({}));
    expect(options).toEqual({ headless: true, humanize: true, humanPreset: "careful" });
    expect("licenseKey" in options).toBe(false);
    expect("proxy" in options).toBe(false);
  });

  it("starts headless — headed is the escalation after a block, not the default", () => {
    expect(cloakLaunchOptions(cloakConfigFromEnv({})).headless).toBe(true);
    // What the escalated attempt asks for, whatever the environment says.
    const cfg = cloakConfigFromEnv({ CLOAK_HEADLESS: "1", CLOAK_HUMANIZE: "0" });
    const escalated = cloakLaunchOptions(cfg, {
      headless: false,
      humanize: true,
      humanPreset: "careful",
    });
    expect(escalated).toMatchObject({ headless: false, humanize: true, humanPreset: "careful" });
  });

  it("lets caller overrides win over the environment", () => {
    const cfg = cloakConfigFromEnv({ CLOAK_PROXY: "http://env:1", CLOAK_HEADLESS: "1" });
    const options = cloakLaunchOptions(cfg, { proxy: "http://flag:2", headless: false });
    expect(options.proxy).toBe("http://flag:2");
    expect(options.headless).toBe(false);
  });

  it("drops geoip when no proxy is configured — it has nothing to align to", () => {
    const options = cloakLaunchOptions(cloakConfigFromEnv({ CLOAK_GEOIP: "1" }));
    expect("geoip" in options).toBe(false);
  });
});

describe("masking", () => {
  it("keeps a licence key recognisable but unusable", () => {
    expect(maskKey("cb_abcdefghijklmnop")).toBe("cb_abcd…mnop");
    expect(maskKey(undefined)).toBe("(none)");
  });

  it("strips the proxy password", () => {
    expect(maskProxy("http://user:s3cret@host:8080")).toBe("http://user:****@host:8080");
    expect(maskProxy("http://host:8080")).toBe("http://host:8080");
  });
});
