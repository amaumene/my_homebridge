/**
 * AirCloudHome dynamic platform.
 *
 * Discovers Hitachi / Shirokuma indoor units from the airCloud Home cloud,
 * registers a HomeKit accessory per device, and polls the cloud on an interval
 * to keep cached state fresh.
 */

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";

import { AirCloudHomeClient } from "./api/client.js";
import { AirCloudHomeAuthError } from "./api/errors.js";
import type { Device } from "./api/types.js";
import { AirCloudHomeAccessory } from "./platformAccessory.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

/**
 * Compare only the cloud-reported fields that affect HomeKit state.
 * Avoids the key-order and undefined-sensitivity of JSON.stringify.
 */
function deviceFieldsEqual(a: Device, b: Device): boolean {
  return (
    a.power === b.power &&
    a.mode === b.mode &&
    a.iduTemperature === b.iduTemperature &&
    a.relativeTemperature === b.relativeTemperature &&
    a.roomTemperature === b.roomTemperature &&
    a.fanSpeed === b.fanSpeed &&
    a.fanSwing === b.fanSwing &&
    a.criticalError === b.criticalError &&
    a.online === b.online
  );
}

/** Default polling interval in seconds. */
const DEFAULT_POLL_INTERVAL = 120;
/** Minimum allowed polling interval in seconds. */
const MIN_POLL_INTERVAL = 60;

export class AirCloudHomePlatform implements DynamicPlatformPlugin {
  /** HAP Service constructor reference. */
  public readonly Service: typeof Service;
  /** HAP Characteristic constructor reference. */
  public readonly Characteristic: typeof Characteristic;

  /** Accessories restored from the Homebridge cache. */
  public readonly accessories: PlatformAccessory[] = [];

  /** Active accessory handlers, keyed by accessory UUID. */
  public readonly handlers = new Map<string, AirCloudHomeAccessory>();

  /** API client used to talk to the airCloud Home cloud service. */
  public readonly client: AirCloudHomeClient;

  /** Effective polling interval in seconds. */
  private readonly pollIntervalSeconds: number;

  /** Consecutive auth failures (0 resets on a successful cycle). */
  private authFailureCount = 0;

  private pollTimer?: ReturnType<typeof setInterval>;
  /** Backoff timer (replaces pollTimer while auth failures accumulate). */
  private backoffTimer?: ReturnType<typeof setTimeout>;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const email = (config.email as string | undefined) ?? "";
    const password = (config.password as string | undefined) ?? "";

    if (!email || !password) {
      log.error(
        "airCloud Home: email and password are required. " +
          "Set them in the plugin config and restart Homebridge.",
      );
    }

    const configuredInterval =
      typeof config.pollInterval === "number"
        ? config.pollInterval
        : DEFAULT_POLL_INTERVAL;
    this.pollIntervalSeconds = Math.max(configuredInterval, MIN_POLL_INTERVAL);

    this.client = new AirCloudHomeClient(email, password, log);

    this.api.on("didFinishLaunching", () => {
      void this.discoverDevices();
    });

    this.api.on("shutdown", () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      if (this.backoffTimer) {
        clearTimeout(this.backoffTimer);
        this.backoffTimer = undefined;
      }
      for (const handler of this.handlers.values()) {
        handler.dispose();
      }
    });
  }

  /** Restore cached accessories. Handlers are created during discovery. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug("Restoring cached accessory:", accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Discover devices from the cloud and reconcile them with HomeKit
   * accessories (register new, update existing, prune stale).
   */
  private async discoverDevices(): Promise<void> {
    let devices: Device[];
    try {
      devices = await this.client.getAllDevices();
    } catch (error) {
      if (error instanceof AirCloudHomeAuthError) {
        this.log.error(
          "airCloud Home: authentication failed - check your email/password.",
        );
        this.scheduleAuthBackoff();
      } else {
        this.log.warn(
          "airCloud Home: device discovery failed; will retry on next poll:",
          error instanceof Error ? error.message : String(error),
        );
        this.schedulePolling();
      }
      return;
    }

    this.authFailureCount = 0;
    this.clearBackoff();
    this.syncDevices(devices);
    this.schedulePolling();
  }

  /**
   * Reconcile a freshly fetched device list with registered accessories.
   * Registers new devices, updates existing ones, and prunes accessories that
   * are no longer present in the active set.
   */
  private syncDevices(devices: Device[]): void {
    const activeUuids = new Set<string>();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(String(device.id));
      activeUuids.add(uuid);

      const existing = this.accessories.find((acc) => acc.UUID === uuid);
      if (existing) {
        const changed = !deviceFieldsEqual(existing.context.device, device);
        if (changed) {
          existing.context.device = device;
          this.api.updatePlatformAccessories([existing]);
        }
        const handler =
          this.handlers.get(uuid) ??
          new AirCloudHomeAccessory(this, existing);
        // Skip state push when writes are in-flight; the next poll will
        // deliver authoritative server state after the command settles.
        if (!handler.hasPendingWrites) {
          handler.update(device);
        }
        this.handlers.set(uuid, handler);
      } else {
        this.log.info("Registering new accessory:", device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        const handler = new AirCloudHomeAccessory(this, accessory);
        handler.update(device);
        this.handlers.set(uuid, handler);
        this.accessories.push(accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }

    // Prune accessories that no longer correspond to a known device.
    const stale = this.accessories.filter((acc) => !activeUuids.has(acc.UUID));
    if (stale.length > 0) {
      this.log.info("Removing %d stale accessory(ies)", stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const acc of stale) {
        this.handlers.delete(acc.UUID);
        const index = this.accessories.indexOf(acc);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
    }
  }

  /** (Re)start the regular polling timer, cancelling any active backoff. */
  private schedulePolling(): void {
    this.clearBackoff();
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalSeconds * 1000);
  }

  /**
   * Schedule a backoff poll after a persistent auth error. Doubles the delay
   * on each consecutive failure (capped at ~1 hour) to avoid hammering the
   * auth endpoint and risking account lockout.
   */
  private scheduleAuthBackoff(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
    }
    this.authFailureCount++;
    const delaySec = Math.min(
      2 ** (this.authFailureCount - 1) * this.pollIntervalSeconds,
      3600,
    );
    this.log.info(
      "airCloud Home: backing off for %ds before retry (attempt %d)",
      delaySec,
      this.authFailureCount,
    );
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = undefined;
      void this.poll();
    }, delaySec * 1000);
  }

  private clearBackoff(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
  }

  /**
   * Poll the cloud for fresh device state. Newly appeared devices are
   * registered; known devices are updated. Never throws.
   */
  private async poll(): Promise<void> {
    try {
      const devices = await this.client.getAllDevices();
      this.authFailureCount = 0;
      this.clearBackoff();
      // Resume the regular interval if we arrived here via a one-shot backoff
      // timer (scheduleAuthBackoff tears down pollTimer); no-op otherwise.
      this.schedulePolling();
      this.syncDevices(devices);
    } catch (error) {
      if (error instanceof AirCloudHomeAuthError) {
        this.log.warn(
          "airCloud Home: polling auth error (credentials may have changed)",
        );
        this.scheduleAuthBackoff();
      } else {
        this.log.warn(
          "airCloud Home: polling failed:",
          error instanceof Error ? error.message : String(error),
        );
        // Ensure a timer stays armed. During normal polling pollTimer is still
        // live (no-op); if we got here via a one-shot backoff timer, this
        // resumes the regular interval rather than stopping silently.
        this.schedulePolling();
      }
    }
  }
}
