/**
 * HomeKit accessory mapping for a single airCloud Home indoor unit.
 *
 * Design rules:
 *   - SINGLE SOURCE OF TRUTH: `this.device` holds the cached state. Every `get`
 *     reads from it; every `set` mutates it (via the API) and then refreshes all
 *     dependent characteristics through {@link pushAll}.
 *   - SERIALIZED WRITES: control calls are full-state PUTs, so they are funneled
 *     through a promise-chain queue ({@link enqueue}) to avoid races. Threshold
 *     temperature writes are debounced (~300ms) to coalesce slider drags.
 *   - AVAILABILITY: when the device is offline, get/set handlers raise a
 *     SERVICE_COMMUNICATION_FAILURE so HomeKit shows "No Response".
 */

import type {
  Characteristic,
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from "homebridge";

import type {
  ControlCommand,
  Device,
  FanSpeed,
  FanSwing,
} from "./api/types.js";
import type { AirCloudHomePlatform } from "./platform.js";
import { clamp, roundToStep } from "./utils.js";

/** First argument type accepted by `Service.updateCharacteristic`. */
type CharLike = Parameters<Service["updateCharacteristic"]>[0];

/** Debounce window for threshold temperature writes (ms). */
const TEMP_DEBOUNCE_MS = 300;

/** Percentage shown on the fan slider for each API fan level. */
const PCT_BY_LEVEL: Record<FanSpeed, number> = {
  AUTO: 0,
  LV1: 20,
  LV2: 40,
  LV3: 60,
  LV4: 80,
  LV5: 100,
};

/** Fallback target temperature when the device reports an unusable value. */
const DEFAULT_TARGET_TEMP = 22;

/**
 * AUTO is a relative comfort offset, not an absolute setpoint (confirmed
 * against the cloud and Hitachi's manuals: -3.0..+3.0 °C in 0.5° steps). The
 * Home app's HeaterCooler tile can only render an absolute temperature, so the
 * offset is presented around a 25 °C pivot, i.e. a 22-28 °C window (matching
 * the Hitachi remote and the Overkiz integration). The device is always sent
 * the raw offset; HomeKit displays pivot + offset.
 */
const AUTO_PIVOT = 25;
const AUTO_OFFSET_MIN = -3;
const AUTO_OFFSET_MAX = 3;
const AUTO_DISPLAY_MIN = AUTO_PIVOT + AUTO_OFFSET_MIN; // 22
const AUTO_DISPLAY_MAX = AUTO_PIVOT + AUTO_OFFSET_MAX; // 28

/**
 * After a successful write, ignore polls that still report the pre-command
 * state for this long. The cloud reflects writes with tens of seconds of lag,
 * so an early poll would otherwise revert the optimistic state.
 */
const POLL_SUPPRESS_MS = 90_000;

/**
 * Seed a characteristic with a valid value BEFORE narrowing its props.
 *
 * hap-nodejs validates the characteristic's current value inside `setProps`
 * and emits a characteristic warning (then clamps) if that value falls outside
 * the new range/validValues. On a fresh accessory the current value is the HAP
 * default (e.g. CoolingThreshold 10, HeatingThreshold 0, RotationSpeed 0), so
 * narrowing the range warns. Seeding a valid value first avoids it.
 *
 * The seed must be valid against BOTH the characteristic's default range and
 * the narrowed range. Returns the characteristic for chaining.
 */
function seedProps(
  characteristic: Characteristic,
  seed: CharacteristicValue,
  props: Parameters<Characteristic["setProps"]>[0],
): Characteristic {
  return characteristic.updateValue(seed).setProps(props);
}

export class AirCloudHomeAccessory {
  private device: Device;

  private readonly service: Service;
  private readonly dryService?: Service;
  private readonly autoFanService?: Service;
  private readonly swingVService?: Service;

  /** Serialized write queue tail. */
  private writeQueue: Promise<void> = Promise.resolve();

  /** Number of writes currently in-flight or queued. */
  private pendingWrites = 0;

  /** True while the write queue is non-idle. Poller skips updates when set. */
  public get hasPendingWrites(): boolean {
    return this.pendingWrites > 0;
  }

  /** Last manual (non-AUTO) fan slider percentage, used to restore the slider. */
  private lastManualSpeedPct = 60;

  /**
   * Last absolute setpoint (°C) seen while in a non-AUTO mode. Re-sent when the
   * user switches from AUTO into Heat/Cool/Dry so the prior setpoint is
   * restored instead of the API default (and never the AUTO offset).
   */
  private lastAbsoluteSetpoint = DEFAULT_TARGET_TEMP;

  /** Last known-good room temperature, used when the API reports null. */
  private lastGoodRoomTemp = 0;

  /**
   * Last non-OFF swing setting reported by the unit. Used as the target when
   * the user re-enables swing via the SwingMode toggle. Defaults to VERTICAL
   * (this hardware supports OFF/VERTICAL/AUTO; HORIZONTAL/BOTH are rejected).
   */
  private lastEffectiveSwing: FanSwing = "VERTICAL";

  /** Pending threshold temperature debounce state. */
  private pendingTemp?: number;
  private tempTimer?: ReturnType<typeof setTimeout>;

  /** Whether the threshold sliders are currently narrowed to the AUTO window. */
  private thresholdAutoProps = false;

  /** Until this epoch (ms), ignore polls that contradict a just-written state. */
  private pollSuppressUntil = 0;

  constructor(
    private readonly platform: AirCloudHomePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as Device;

    const { Service: S, Characteristic: C } = this.platform;

    // --- Accessory Information ------------------------------------------------
    const info =
      this.accessory.getService(S.AccessoryInformation) ??
      this.accessory.addService(S.AccessoryInformation);
    // `model` from the cloud is the brand string ("HITACHI"), so use it as the
    // manufacturer and the vendor thing id as the model identifier. The cloud
    // often reports a shared placeholder serial ("XXXX-XXXX-XXXX"); fall back to
    // the unique device id so HomeKit does not treat multiple units as one.
    const rawSerial = this.device.serialNumber;
    const serial =
      rawSerial && !/^[X-]+$/i.test(rawSerial) ? rawSerial : String(this.device.id);
    info
      .setCharacteristic(C.Manufacturer, this.device.model ?? "Hitachi")
      .setCharacteristic(C.Model, this.device.vendorThingId ?? "airCloud Home")
      .setCharacteristic(C.Name, this.device.name)
      .setCharacteristic(C.SerialNumber, serial);

    // --- HeaterCooler (primary) ----------------------------------------------
    this.service =
      this.accessory.getService(S.HeaterCooler) ??
      this.accessory.addService(S.HeaterCooler, this.device.name);
    this.service.setPrimaryService(true);
    this.service.addOptionalCharacteristic(C.ConfiguredName);
    this.service.setCharacteristic(C.ConfiguredName, this.device.name);
    this.setupHeaterCooler();

    // --- Optional mode/fan/swing switches ------------------------------------
    // Only the controls this hardware actually accepts (verified against the
    // unit): Dry mode, Auto Fan, and vertical swing. Each can be hidden via
    // config; a hidden switch is pruned from a restored accessory.
    this.dryService = this.setupOptionalSwitch(
      this.featureEnabled("showDryMode"),
      "Dry",
      "mode-dry",
    );
    this.autoFanService = this.setupOptionalSwitch(
      this.featureEnabled("showAutoFan"),
      "Auto Fan",
      "fan-auto",
    );
    this.swingVService = this.setupOptionalSwitch(
      this.featureEnabled("showSwingVertical"),
      "Swing Vertical",
      "swing-v",
    );

    this.bindModeSwitches();
    this.bindAutoFanSwitch();
    this.bindSwingSwitches();

    // Prune services for features this hardware does not support (Fan Only,
    // Dry Cool, Horizontal swing, Humidifier), including ones an older build of
    // this plugin may have left on a restored accessory.
    this.pruneStaleSwitch("mode-fan");
    this.pruneStaleSwitch("mode-drycool");
    this.pruneStaleSwitch("swing-h");
    const staleHumidifier = this.accessory.getService(S.HumidifierDehumidifier);
    if (staleHumidifier) {
      this.accessory.removeService(staleHumidifier);
    }

    // Initial state push is deferred to the caller (platform's syncDevices
    // always calls update() immediately after construction).
  }

  /** Remove a switch service (by subtype) left on a restored accessory. */
  private pruneStaleSwitch(subtype: string): void {
    const stale = this.accessory.getServiceById(
      this.platform.Service.Switch,
      subtype,
    );
    if (stale) {
      this.accessory.removeService(stale);
    }
  }

  /**
   * Current AUTO comfort offset (-3..+3 °C), read from the cloud's
   * `relativeTemperature` (mirrored into `iduTemperature` while in AUTO).
   */
  private autoOffset(): number {
    const raw = this.device.relativeTemperature ?? this.device.iduTemperature ?? 0;
    const n = Number(raw);
    return clamp(
      roundToStep(Number.isNaN(n) ? 0 : n, 0.5),
      AUTO_OFFSET_MIN,
      AUTO_OFFSET_MAX,
    );
  }

  /** Called by the poller with fresh device state. */
  update(device: Device): void {
    this.pollSuppressUntil = 0; // poll accepted: the write is reconciled
    this.device = device;
    this.accessory.context.device = device;
    this.pushAll();
  }

  /**
   * True while a recent write's optimistic state must be protected from a poll
   * that still reports the pre-command value (the cloud reflects writes with
   * tens of seconds of lag). False once the poll agrees (confirmed) or the
   * window expires (treated as an external change).
   */
  isPollSuppressed(incoming: Device): boolean {
    return Date.now() < this.pollSuppressUntil && !this.pollAgrees(incoming);
  }

  /** Whether an incoming poll matches the current (optimistic) commanded state. */
  private pollAgrees(d: Device): boolean {
    return (
      d.power === this.device.power &&
      d.mode === this.device.mode &&
      d.fanSpeed === this.device.fanSpeed &&
      d.fanSwing === this.device.fanSwing &&
      d.iduTemperature === this.device.iduTemperature &&
      d.relativeTemperature === this.device.relativeTemperature
    );
  }

  /** Release timers held by this accessory (called on platform shutdown). */
  dispose(): void {
    if (this.tempTimer) {
      clearTimeout(this.tempTimer);
      this.tempTimer = undefined;
    }
  }

  // ===========================================================================
  // Service setup
  // ===========================================================================

  private setupHeaterCooler(): void {
    const { Characteristic: C } = this.platform;
    const svc = this.service;

    svc
      .getCharacteristic(C.Active)
      .onGet(() => this.guardGet(() => this.activeValue()))
      .onSet((value) => this.guardSet(() => this.setActive(value)));

    svc
      .getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.guardGet(() => this.currentTemperatureValue()));

    svc
      .getCharacteristic(C.CurrentHeaterCoolerState)
      .setProps({
        validValues: [
          C.CurrentHeaterCoolerState.INACTIVE,
          C.CurrentHeaterCoolerState.IDLE,
          C.CurrentHeaterCoolerState.HEATING,
          C.CurrentHeaterCoolerState.COOLING,
        ],
      })
      .onGet(() => this.guardGet(() => this.currentHeaterCoolerState()));

    svc
      .getCharacteristic(C.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          C.TargetHeaterCoolerState.AUTO,
          C.TargetHeaterCoolerState.HEAT,
          C.TargetHeaterCoolerState.COOL,
        ],
      })
      .onGet(() => this.guardGet(() => this.targetHeaterCoolerState()))
      .onSet((value) => this.guardSet(() => this.setTargetState(value)));

    for (const characteristic of [
      C.CoolingThresholdTemperature,
      C.HeatingThresholdTemperature,
    ]) {
      // Seed a fixed mid-range constant, not the live setpoint:
      // HeatingThresholdTemperature's DEFAULT range is 0–25, so seeding a live
      // value > 25 (e.g. a 30 °C heat setpoint) would itself warn. 22 is valid
      // in every relevant range. update() overwrites it with real state.
      seedProps(svc.getCharacteristic(characteristic), DEFAULT_TARGET_TEMP, {
        minValue: 16,
        maxValue: 32,
        minStep: 0.5,
      })
        .onGet(() => this.guardGet(() => this.targetTemperatureValue()))
        .onSet((value) =>
          this.guardSet(() => {
            this.scheduleThresholdWrite(value);
          }),
        );
    }

    // RotationSpeed cannot represent AUTO (fan level 0), so the slider shows
    // the last-used manual speed when the fan is in AUTO mode.  The "Auto Fan"
    // linked switch is the canonical AUTO/off toggle.
    // rotationSpeedValue() is always 20–100 (valid against the default 0–100).
    seedProps(svc.getCharacteristic(C.RotationSpeed), this.rotationSpeedValue(), {
      minValue: 20,
      maxValue: 100,
      minStep: 20,
    })
      .onGet(() => this.guardGet(() => this.rotationSpeedValue()))
      .onSet((value) => this.guardSet(() => this.setRotationSpeed(value)));

    svc
      .getCharacteristic(C.SwingMode)
      .onGet(() => this.guardGet(() => this.swingModeValue()))
      .onSet((value) => this.guardSet(() => this.setSwingMode(value)));

    svc
      .getCharacteristic(C.TemperatureDisplayUnits)
      .setProps({ validValues: [C.TemperatureDisplayUnits.CELSIUS] })
      .onGet(() => C.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => {
        /* Display units are fixed to Celsius; ignore writes. */
      });

    // Surface the cloud's criticalError flag as a native HomeKit fault badge.
    svc.addOptionalCharacteristic(C.StatusFault);
    svc
      .getCharacteristic(C.StatusFault)
      .onGet(() => this.guardGet(() => this.statusFaultValue()));
  }

  /**
   * Narrow the threshold sliders to the 22-28 AUTO window while in AUTO, and
   * restore the full 16-32 range otherwise, so the AUTO comfort range is honest
   * and the handle cannot be dragged past it. Only re-applied on change; seeds a
   * valid mid value before narrowing to avoid a characteristic range warning.
   */
  private applyThresholdProps(auto: boolean): void {
    if (auto === this.thresholdAutoProps) {
      return;
    }
    this.thresholdAutoProps = auto;
    const C = this.platform.Characteristic;
    for (const ch of [
      C.CoolingThresholdTemperature,
      C.HeatingThresholdTemperature,
    ]) {
      const characteristic = this.service.getCharacteristic(ch);
      if (auto) {
        characteristic.updateValue(AUTO_PIVOT);
        characteristic.setProps({
          minValue: AUTO_DISPLAY_MIN,
          maxValue: AUTO_DISPLAY_MAX,
          minStep: 0.5,
        });
      } else {
        characteristic.setProps({ minValue: 16, maxValue: 32, minStep: 0.5 });
      }
    }
  }

  private setupSwitch(displayName: string, subtype: string): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const svc =
      this.accessory.getServiceById(S.Switch, subtype) ??
      this.accessory.addService(S.Switch, displayName, subtype);
    svc.setCharacteristic(C.Name, displayName);
    // The Switch service does not list ConfiguredName as optional, so setting
    // it directly logs an "Adding anyway" warning. Register it first.
    svc.addOptionalCharacteristic(C.ConfiguredName);
    svc.setCharacteristic(C.ConfiguredName, displayName);
    this.service.addLinkedService(svc);
    return svc;
  }

  /**
   * Read a boolean feature flag from the platform config. Defaults to true:
   * a switch is hidden only when its flag is explicitly set to `false`.
   */
  private featureEnabled(key: string): boolean {
    return this.platform.config[key] !== false;
  }

  /**
   * Create a switch when `enabled`, or prune a stale one (left over from a
   * previous config) when disabled. Returns undefined when the switch is
   * hidden so callers can skip binding/pushing it.
   */
  private setupOptionalSwitch(
    enabled: boolean,
    displayName: string,
    subtype: string,
  ): Service | undefined {
    if (!enabled) {
      const stale = this.accessory.getServiceById(
        this.platform.Service.Switch,
        subtype,
      );
      if (stale) {
        this.accessory.removeService(stale);
      }
      return undefined;
    }
    return this.setupSwitch(displayName, subtype);
  }

  private bindModeSwitches(): void {
    const { Characteristic: C } = this.platform;

    this.dryService
      ?.getCharacteristic(C.On)
      .onGet(() =>
        this.guardGet(
          () => this.device.power === "ON" && this.device.mode === "DRY",
        ),
      )
      .onSet((value) =>
        this.guardSet(() =>
          this.applyControl(
            value ? { power: "ON", mode: "DRY" } : { mode: "AUTO" },
          ),
        ),
      );

  }

  private bindAutoFanSwitch(): void {
    const { Characteristic: C } = this.platform;
    this.autoFanService
      ?.getCharacteristic(C.On)
      .onGet(() =>
        this.guardGet(
          () => this.device.power === "ON" && this.device.fanSpeed === "AUTO",
        ),
      )
      .onSet((value) =>
        this.guardSet(() =>
          // Powering on when enabling keeps the switch truthful (fan settings
          // only apply while running) and avoids a spring-back when off.
          value
            ? this.applyControl({ power: "ON", fanSpeed: "AUTO" })
            : this.applyControl({ fanSpeed: this.manualFanSpeed() }),
        ),
      );
  }

  private bindSwingSwitches(): void {
    const { Characteristic: C } = this.platform;

    // This hardware accepts only OFF / VERTICAL / AUTO swing (HORIZONTAL and
    // BOTH are rejected), so the Vertical switch toggles VERTICAL vs OFF.
    this.swingVService
      ?.getCharacteristic(C.On)
      .onGet(() =>
        this.guardGet(
          () =>
            this.device.power === "ON" &&
            this.device.fanSwing === "VERTICAL",
        ),
      )
      .onSet((value) =>
        this.guardSet(() => {
          if (value) {
            this.lastEffectiveSwing = "VERTICAL";
            return this.applyControl({ power: "ON", fanSwing: "VERTICAL" });
          }
          return this.applyControl({ fanSwing: "OFF" });
        }),
      );
  }

  // ===========================================================================
  // Value computation (shared by onGet and pushAll)
  // ===========================================================================

  private activeValue(): CharacteristicValue {
    const C = this.platform.Characteristic;
    return this.device.power === "ON" ? C.Active.ACTIVE : C.Active.INACTIVE;
  }

  private statusFaultValue(): CharacteristicValue {
    const C = this.platform.Characteristic.StatusFault;
    return this.device.criticalError ? C.GENERAL_FAULT : C.NO_FAULT;
  }

  /** Room temperature, coalesced to a safe number (never null/undefined/NaN). */
  private currentTemperatureValue(): CharacteristicValue {
    const room = this.device.roomTemperature;
    if (room === null || room === undefined || Number.isNaN(room)) {
      return this.lastGoodRoomTemp;
    }
    this.lastGoodRoomTemp = room;
    return room;
  }

  /**
   * Target temperature shown on the HeaterCooler tile.
   *
   * AUTO: a relative offset, presented as pivot + offset (22-28 °C window).
   * Other modes: the absolute IDU setpoint, clamped to the HomeKit 16-32 range
   * (defaults to 22 when the API omits/garbles it).
   */
  private targetTemperatureValue(): CharacteristicValue {
    if (this.device.mode === "AUTO") {
      return clamp(
        AUTO_PIVOT + this.autoOffset(),
        AUTO_DISPLAY_MIN,
        AUTO_DISPLAY_MAX,
      );
    }
    const idu = this.device.iduTemperature;
    if (idu === null || idu === undefined || Number.isNaN(idu)) {
      return DEFAULT_TARGET_TEMP;
    }
    return clamp(idu, 16, 32);
  }

  private currentHeaterCoolerState(): CharacteristicValue {
    const state = this.platform.Characteristic.CurrentHeaterCoolerState;
    if (this.device.power !== "ON") {
      return state.INACTIVE;
    }
    const { mode, roomTemperature: room } = this.device;
    if (room === null || room === undefined || Number.isNaN(room)) {
      return state.IDLE;
    }
    // AUTO derives its target from the offset (relativeTemperature), not the
    // mode-polymorphic iduTemperature, so handle it before the idu guard.
    if (mode === "AUTO") {
      const target = AUTO_PIVOT + this.autoOffset();
      if (room > target) {
        return state.COOLING;
      }
      return room < target ? state.HEATING : state.IDLE;
    }
    const idu = this.device.iduTemperature;
    if (idu === null || idu === undefined || Number.isNaN(idu)) {
      return state.IDLE;
    }
    switch (mode) {
      case "HEATING":
        return room < idu ? state.HEATING : state.IDLE;
      case "COOLING":
        return room > idu ? state.COOLING : state.IDLE;
      case "DRY":
      case "DRY_COOL":
        return state.COOLING;
      default:
        return state.IDLE;
    }
  }

  private targetHeaterCoolerState(): CharacteristicValue {
    const state = this.platform.Characteristic.TargetHeaterCoolerState;
    switch (this.device.mode) {
      case "HEATING":
        return state.HEAT;
      case "COOLING":
        return state.COOL;
      default:
        return state.AUTO;
    }
  }

  private rotationSpeedValue(): CharacteristicValue {
    if (this.device.fanSpeed === "AUTO") {
      return this.lastManualSpeedPct;
    }
    return PCT_BY_LEVEL[this.device.fanSpeed] || this.lastManualSpeedPct;
  }

  private swingModeValue(): CharacteristicValue {
    const C = this.platform.Characteristic.SwingMode;
    // ENABLED for any active swing (VERTICAL or AUTO), DISABLED when the louver
    // is off. The Swing Vertical switch selects VERTICAL specifically.
    return this.device.fanSwing !== "OFF"
      ? C.SWING_ENABLED
      : C.SWING_DISABLED;
  }

  // ===========================================================================
  // Setters
  // ===========================================================================

  private setActive(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic;
    if (value === C.Active.ACTIVE) {
      // Send power only. `mode` is resolved from the device at execution time
      // inside the serialized write queue (preserving the last mode across OFF),
      // so this cannot race a concurrent TargetHeaterCoolerState write when the
      // user turns the unit on by tapping Heat/Cool (which previously let a
      // stale AUTO land after the new mode and revert it).
      return this.applyControl({ power: "ON" });
    }
    return this.applyControl({ power: "OFF" });
  }

  private setTargetState(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic.TargetHeaterCoolerState;
    if (value === C.HEAT) {
      return this.applyControl({ power: "ON", mode: "HEATING" });
    }
    if (value === C.COOL) {
      return this.applyControl({ power: "ON", mode: "COOLING" });
    }
    return this.applyControl({ power: "ON", mode: "AUTO" });
  }

  private setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const level = clamp(Math.round(Number(value) / 20), 1, 5);
    const fanSpeed = `LV${level}` as FanSpeed;
    this.lastManualSpeedPct = level * 20;
    return this.applyControl({ fanSpeed });
  }

  private setSwingMode(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic.SwingMode;
    const fanSwing: FanSwing = value === C.SWING_ENABLED
      ? this.lastEffectiveSwing
      : "OFF";
    if (fanSwing !== "OFF") {
      this.lastEffectiveSwing = fanSwing;
    }
    return this.applyControl({ fanSwing });
  }

  /**
   * Debounce threshold temperature writes and apply the last value.
   *
   * `value` is the absolute temperature shown on the HomeKit slider. In AUTO it
   * is converted to the device-native offset (display - pivot, clamped to
   * ±3); in other modes it is the absolute setpoint (clamped to 16-32).
   */
  private scheduleThresholdWrite(value: CharacteristicValue): void {
    this.pendingTemp =
      this.device.mode === "AUTO"
        ? clamp(
            roundToStep(Number(value) - AUTO_PIVOT, 0.5),
            AUTO_OFFSET_MIN,
            AUTO_OFFSET_MAX,
          )
        : clamp(roundToStep(Number(value), 0.5), 16, 32);
    if (this.tempTimer) {
      clearTimeout(this.tempTimer);
    }
    this.tempTimer = setTimeout(() => {
      this.tempTimer = undefined;
      const temperature = this.pendingTemp;
      this.pendingTemp = undefined;
      if (temperature === undefined) {
        return;
      }
      // applyControl already enqueues; do not double-wrap. Swallow rejection so
      // a failed debounced write does not surface as an unhandledRejection.
      void this.applyControl({ iduTemperature: temperature }).catch(() => {});
    }, TEMP_DEBOUNCE_MS);
  }

  /** Resolve the manual fan speed level from the last manual slider value. */
  private manualFanSpeed(): FanSpeed {
    const level = clamp(Math.round(this.lastManualSpeedPct / 20), 1, 5);
    return `LV${level}` as FanSpeed;
  }

  // ===========================================================================
  // Plumbing: write queue, control, availability, state push
  // ===========================================================================

  /** Run a control task on the serialized write queue. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.pendingWrites++;
    const run = this.writeQueue.then(task, task);
    // Keep the chain alive regardless of individual task failures.
    this.writeQueue = run
      .catch(() => undefined)
      .finally(() => {
        this.pendingWrites--;
      });
    return run;
  }

  /**
   * Send a full-state control command and refresh all characteristics.
   *
   * The actual control call is queued so concurrent setter bursts run strictly
   * sequentially. The merge reads `this.device` at execution time (inside the
   * queued task) so serialized writes compose instead of clobbering each other.
   */
  private applyControl(changes: ControlCommand): Promise<void> {
    // Entering (or staying in) an absolute mode without an explicit setpoint:
    // supply the remembered absolute value. This both preserves the user's
    // setpoint across an AUTO→Heat/Cool switch and prevents the client from
    // falling back to a default. AUTO changes are left alone (the client uses
    // the relative offset as the base).
    const resultMode = changes.mode ?? this.device.mode;
    if (resultMode !== "AUTO" && changes.iduTemperature === undefined) {
      changes = { ...changes, iduTemperature: this.lastAbsoluteSetpoint };
    }
    return this.enqueue(async () => {
      try {
        this.device = await this.platform.client.control(this.device, changes);
        this.accessory.context.device = this.device;
      } catch (error) {
        this.platform.log.warn(
          `Control failed for ${this.device.name}:`,
          error instanceof Error ? error.message : String(error),
        );
        // Throw SERVICE_COMMUNICATION_FAILURE so HomeKit shows "No Response"
        // for this request only. Do NOT persist online=false — a transient
        // error (e.g. HTTP 500) does not mean the device is offline, and the
        // next poll will restore authoritative online state.
        throw this.commError();
      }
      this.pushAll();
      // Protect this optimistic state from a lagging poll until the cloud
      // confirms it (see isPollSuppressed). Only set on success.
      this.pollSuppressUntil = Date.now() + POLL_SUPPRESS_MS;
    });
  }

  /** Throw a No-Response error when the device is offline. */
  private assertOnline(): void {
    if (!this.device.online) {
      throw this.commError();
    }
  }

  private commError(): Error {
    const hap = this.platform.api.hap;
    return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  /** Wrap a synchronous getter with the availability guard. */
  private guardGet(getter: () => CharacteristicValue): CharacteristicValue {
    this.assertOnline();
    return getter();
  }

  /** Wrap a setter: enforce availability, then queue the (async) work. */
  private async guardSet(action: () => Promise<void> | void): Promise<void> {
    this.assertOnline();
    const result = action();
    if (result instanceof Promise) {
      await result;
    }
  }

  /** Push every characteristic value from the current cached state. */
  private pushAll(): void {
    const C = this.platform.Characteristic;

    // Track the unit's actual last non-OFF swing (including AUTO and
    // vertical-only units) so the SwingMode toggle restores what this hardware
    // really uses instead of a hardcoded BOTH.
    if (this.device.fanSwing !== "OFF") {
      this.lastEffectiveSwing = this.device.fanSwing;
    }

    // HeaterCooler
    this.push(this.service, C.Active, this.activeValue());
    this.push(
      this.service,
      C.CurrentTemperature,
      this.currentTemperatureValue(),
    );
    this.push(
      this.service,
      C.CurrentHeaterCoolerState,
      this.currentHeaterCoolerState(),
    );
    this.push(
      this.service,
      C.TargetHeaterCoolerState,
      this.targetHeaterCoolerState(),
    );
    // While a threshold write is debouncing, don't push iduTemperature back —
    // it would revert the slider mid-drag.
    if (this.tempTimer === undefined) {
      // One absolute-looking setpoint per mode. In AUTO this is pivot+offset
      // (22-28); otherwise it is the absolute setpoint. The Home app still
      // renders two handles in AUTO, but parking both on the same value makes
      // them move together as one setpoint. Dragging either writes the same
      // value (offset in AUTO, absolute otherwise).
      this.applyThresholdProps(this.device.mode === "AUTO");
      const target = this.targetTemperatureValue();
      // Remember the absolute setpoint so an AUTO→Heat/Cool switch can restore
      // it (see applyControl). Skip AUTO, where `target` is pivot+offset.
      if (this.device.mode !== "AUTO") {
        this.lastAbsoluteSetpoint = Number(target);
      }
      this.push(this.service, C.CoolingThresholdTemperature, target);
      this.push(this.service, C.HeatingThresholdTemperature, target);
    }
    this.push(this.service, C.RotationSpeed, this.rotationSpeedValue());
    this.push(this.service, C.SwingMode, this.swingModeValue());
    this.push(this.service, C.StatusFault, this.statusFaultValue());

    // Mode + fan + swing switches
    const on = this.device.power === "ON";
    this.push(
      this.dryService,
      C.On,
      on && this.device.mode === "DRY",
    );
    this.push(
      this.autoFanService,
      C.On,
      on && this.device.fanSpeed === "AUTO",
    );
    this.push(
      this.swingVService,
      C.On,
      on && this.device.fanSwing === "VERTICAL",
    );
  }

  /** Update one characteristic, or mark it No-Response when offline. */
  private push(
    service: Service | undefined,
    characteristic: CharLike,
    value: CharacteristicValue,
  ): void {
    if (!service) {
      return;
    }
    if (this.device.online) {
      service.updateCharacteristic(characteristic, value);
    } else {
      service.updateCharacteristic(characteristic, this.commError());
    }
  }
}
