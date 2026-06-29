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
import { HUMIDITY_MODES } from "./api/types.js";
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

export class AirCloudHomeAccessory {
  private device: Device;

  private readonly service: Service;
  private readonly dryService: Service;
  private readonly fanOnlyService: Service;
  private readonly dryCoolService: Service;
  private readonly autoFanService: Service;
  private readonly swingVService: Service;
  private readonly swingHService: Service;
  private readonly humidifierService?: Service;

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

  /** Last known-good room temperature, used when the API reports null. */
  private lastGoodRoomTemp = 0;

  /**
   * Last non-OFF swing direction set via the V/H switches or SwingMode toggle.
   * Used as the target when the user re-enables swing.
   */
  private lastEffectiveSwing: FanSwing = "BOTH";

  /** Pending threshold temperature debounce state. */
  private pendingTemp?: number;
  private tempTimer?: ReturnType<typeof setTimeout>;

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
    const model = this.device.model ?? "airCloud Home";
    info
      .setCharacteristic(C.Manufacturer, model)
      .setCharacteristic(C.Model, model)
      .setCharacteristic(C.Name, this.device.name)
      .setCharacteristic(
        C.SerialNumber,
        this.device.serialNumber ?? String(this.device.id),
      )
      .setCharacteristic(
        C.FirmwareRevision,
        this.device.vendorThingId ?? String(this.device.id),
      );

    // --- HeaterCooler (primary) ----------------------------------------------
    this.service =
      this.accessory.getService(S.HeaterCooler) ??
      this.accessory.addService(S.HeaterCooler, this.device.name);
    this.service.setPrimaryService(true);
    this.setupHeaterCooler();

    // --- Mode + fan + swing switches -----------------------------------------
    this.dryService = this.setupSwitch("Dry", "mode-dry");
    this.fanOnlyService = this.setupSwitch("Fan Only", "mode-fan");
    this.dryCoolService = this.setupSwitch("Dry Cool", "mode-drycool");
    this.autoFanService = this.setupSwitch("Auto Fan", "fan-auto");
    this.swingVService = this.setupSwitch("Swing Vertical", "swing-v");
    this.swingHService = this.setupSwitch("Swing Horizontal", "swing-h");

    this.bindModeSwitches();
    this.bindAutoFanSwitch();
    this.bindSwingSwitches();

    // --- HumidifierDehumidifier (only if device reports humidity) -------------
    if (this.device.humidity !== undefined) {
      this.humidifierService =
        this.accessory.getService(S.HumidifierDehumidifier) ??
        this.accessory.addService(S.HumidifierDehumidifier, this.device.name);
      this.service.addLinkedService(this.humidifierService);
      this.setupHumidifier();
    } else {
      // Capability dropped: remove a stale service from a restored accessory.
      const stale = this.accessory.getService(S.HumidifierDehumidifier);
      if (stale) {
        this.accessory.removeService(stale);
      }
    }

    // Initial state push is deferred to the caller (platform's syncDevices
    // always calls update() immediately after construction).
  }

  /** Called by the poller with fresh device state. */
  update(device: Device): void {
    this.device = device;
    this.accessory.context.device = device;
    this.pushAll();
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
      svc
        .getCharacteristic(characteristic)
        .setProps({ minValue: 16, maxValue: 32, minStep: 0.5 })
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
    svc
      .getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 20, maxValue: 100, minStep: 20 })
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
  }

  private setupSwitch(displayName: string, subtype: string): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const svc =
      this.accessory.getServiceById(S.Switch, subtype) ??
      this.accessory.addService(S.Switch, displayName, subtype);
    svc.setCharacteristic(C.Name, displayName);
    svc.setCharacteristic(C.ConfiguredName, displayName);
    this.service.addLinkedService(svc);
    return svc;
  }

  private bindModeSwitches(): void {
    const { Characteristic: C } = this.platform;

    this.dryService
      .getCharacteristic(C.On)
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

    this.fanOnlyService
      .getCharacteristic(C.On)
      .onGet(() =>
        this.guardGet(
          () => this.device.power === "ON" && this.device.mode === "FAN",
        ),
      )
      .onSet((value) =>
        this.guardSet(() =>
          this.applyControl(
            value ? { power: "ON", mode: "FAN" } : { mode: "AUTO" },
          ),
        ),
      );

    this.dryCoolService
      .getCharacteristic(C.On)
      .onGet(() =>
        this.guardGet(
          () => this.device.power === "ON" && this.device.mode === "DRY_COOL",
        ),
      )
      .onSet((value) =>
        this.guardSet(() =>
          // HA parity: clearing DRY_COOL falls back to DRY (not AUTO).
          this.applyControl(
            value ? { power: "ON", mode: "DRY_COOL" } : { mode: "DRY" },
          ),
        ),
      );
  }

  private bindAutoFanSwitch(): void {
    const { Characteristic: C } = this.platform;
    this.autoFanService
      .getCharacteristic(C.On)
      .onGet(() => this.guardGet(() => this.device.fanSpeed === "AUTO"))
      .onSet((value) =>
        this.guardSet(() => {
          if (value) {
            return this.applyControl({ fanSpeed: "AUTO" });
          }
          return this.applyControl({ fanSpeed: this.manualFanSpeed() });
        }),
      );
  }

  private bindSwingSwitches(): void {
    const { Characteristic: C } = this.platform;

    this.swingVService
      .getCharacteristic(C.On)
      .onGet(() =>
        this.guardGet(
          () =>
            this.device.fanSwing === "VERTICAL" ||
            this.device.fanSwing === "BOTH",
        ),
      )
      .onSet((value) =>
        this.guardSet(() => {
          const hOn =
            this.device.fanSwing === "HORIZONTAL" ||
            this.device.fanSwing === "BOTH";
          let result: FanSwing;
          if (value) {
            result = hOn ? "BOTH" : "VERTICAL";
          } else {
            result = hOn ? "HORIZONTAL" : "OFF";
          }
          if (result !== "OFF") {
            this.lastEffectiveSwing = result;
          }
          return this.applyControl({ fanSwing: result });
        }),
      );

    this.swingHService
      .getCharacteristic(C.On)
      .onGet(() =>
        this.guardGet(
          () =>
            this.device.fanSwing === "HORIZONTAL" ||
            this.device.fanSwing === "BOTH",
        ),
      )
      .onSet((value) =>
        this.guardSet(() => {
          const vOn =
            this.device.fanSwing === "VERTICAL" ||
            this.device.fanSwing === "BOTH";
          let result: FanSwing;
          if (value) {
            result = vOn ? "BOTH" : "HORIZONTAL";
          } else {
            result = vOn ? "VERTICAL" : "OFF";
          }
          if (result !== "OFF") {
            this.lastEffectiveSwing = result;
          }
          return this.applyControl({ fanSwing: result });
        }),
      );
  }

  private setupHumidifier(): void {
    const { Characteristic: C } = this.platform;
    const svc = this.humidifierService;
    if (!svc) {
      return;
    }

    // Humidifier Active is read‑only: it indicates whether dehumidification is
    // currently running (power ON + DRY/DRY_COOL mode). Mode selection is
    // handled by the dedicated Dry / Dry Cool switches and the HeaterCooler.
    // Drop the write perm so the Home app shows it as a status indicator
    // rather than a toggle that silently springs back.
    const { Perms } = this.platform.api.hap;
    svc
      .getCharacteristic(C.Active)
      .setProps({ perms: [Perms.PAIRED_READ, Perms.NOTIFY] })
      .onGet(() => this.guardGet(() => this.humidifierActiveValue()));

    svc
      .getCharacteristic(C.CurrentHumidifierDehumidifierState)
      .setProps({
        validValues: [
          C.CurrentHumidifierDehumidifierState.INACTIVE,
          C.CurrentHumidifierDehumidifierState.IDLE,
          C.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
        ],
      })
      .onGet(() => this.guardGet(() => this.humidifierCurrentState()));

    svc
      .getCharacteristic(C.TargetHumidifierDehumidifierState)
      .setProps({
        validValues: [C.TargetHumidifierDehumidifierState.DEHUMIDIFIER],
      })
      .onGet(() => C.TargetHumidifierDehumidifierState.DEHUMIDIFIER)
      .onSet(() => {
        /* Dehumidifier-only; target state is fixed. */
      });

    svc
      .getCharacteristic(C.CurrentRelativeHumidity)
      .onGet(() => this.guardGet(() => this.humidityValue()));

    svc
      .getCharacteristic(C.RelativeHumidityDehumidifierThreshold)
      .setProps({ minValue: 40, maxValue: 60, minStep: 5 })
      .onGet(() => this.guardGet(() => this.humidityValue()))
      .onSet((value) =>
        this.guardSet(() => {
          const v = clamp(roundToStep(Number(value), 5), 40, 60);
          // Cache the desired humidity inside the write queue so the mutation
          // is serialised with other writes and the merged read is race-free.
          // The API ignores humidity outside DRY/DRY_COOL modes; caching here
          // ensures the desired value survives until the mode changes.
          return this.enqueue(async () => {
            this.device = { ...this.device, humidity: v };
            this.accessory.context.device = this.device;
            try {
              this.device = await this.platform.client.control(
                this.device,
                { humidity: v },
              );
              this.accessory.context.device = this.device;
            } catch (error) {
              this.platform.log.warn(
                `Control failed for ${this.device.name}:`,
                error instanceof Error ? error.message : String(error),
              );
              throw this.commError();
            }
            this.pushAll();
          });
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
   * Target (IDU) temperature, coalesced to a safe number and clamped to the
   * HomeKit 16–32 range (defaults to 22 when the API omits/garbles it).
   */
  private targetTemperatureValue(): CharacteristicValue {
    const idu = this.device.iduTemperature;
    if (idu === null || idu === undefined || Number.isNaN(idu)) {
      return DEFAULT_TARGET_TEMP;
    }
    return clamp(idu, 16, 32);
  }

  /**
   * Humidity setpoint, rounded to the nearest 5 and clamped to the HomeKit
   * 40–60 range (defaults to 50 when unset).
   */
  private humidityValue(): CharacteristicValue {
    return clamp(roundToStep(this.device.humidity ?? 50, 5), 40, 60);
  }

  private currentHeaterCoolerState(): CharacteristicValue {
    const state = this.platform.Characteristic.CurrentHeaterCoolerState;
    if (this.device.power !== "ON") {
      return state.INACTIVE;
    }
    const { mode, roomTemperature: room, iduTemperature: idu } = this.device;
    // Without a valid room/target temperature we cannot infer heat/cool/idle.
    if (
      room === null ||
      room === undefined ||
      Number.isNaN(room) ||
      idu === null ||
      idu === undefined ||
      Number.isNaN(idu)
    ) {
      return state.IDLE;
    }
    switch (mode) {
      case "HEATING":
        return room < idu ? state.HEATING : state.IDLE;
      case "COOLING":
        return room > idu ? state.COOLING : state.IDLE;
      case "AUTO":
        if (room > idu) {
          return state.COOLING;
        }
        return room < idu ? state.HEATING : state.IDLE;
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
    // ENABLED for any active swing (directional or AUTO), DISABLED only
    // when louver is fully off.  The V/H switches handle direction fine‑tuning.
    return this.device.fanSwing !== "OFF"
      ? C.SWING_ENABLED
      : C.SWING_DISABLED;
  }

  private humidifierActiveValue(): CharacteristicValue {
    const C = this.platform.Characteristic.Active;
    const active =
      this.device.power === "ON" && HUMIDITY_MODES.has(this.device.mode);
    return active ? C.ACTIVE : C.INACTIVE;
  }

  private humidifierCurrentState(): CharacteristicValue {
    const state = this.platform.Characteristic.CurrentHumidifierDehumidifierState;
    if (this.device.power !== "ON") {
      return state.INACTIVE;
    }
    return HUMIDITY_MODES.has(this.device.mode)
      ? state.DEHUMIDIFYING
      : state.IDLE;
  }

  // ===========================================================================
  // Setters
  // ===========================================================================

  private setActive(value: CharacteristicValue): Promise<void> {
    const C = this.platform.Characteristic;
    if (value === C.Active.ACTIVE) {
      // Preserve the last mode across OFF (HA parity), defaulting to AUTO.
      const mode = this.device.mode ?? "AUTO";
      return this.applyControl({ power: "ON", mode });
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

  /** Debounce threshold temperature writes and apply the last value. */
  private scheduleThresholdWrite(value: CharacteristicValue): void {
    this.pendingTemp = clamp(roundToStep(Number(value), 0.5), 16, 32);
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
      // applyControl already enqueues; do not double-wrap.
      void this.applyControl({ iduTemperature: temperature });
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
      const target = this.targetTemperatureValue();
      if (this.device.mode === "AUTO") {
        // Single-setpoint device: present a 0.5 °C spread between the two
        // thresholds so the Home app's dual-handle range does not collapse
        // to a zero-width band (which triggers visible UI oscillation).
        // Clamp each handle into the 16–32 props range so the spread survives
        // at the extremes without emitting HAP out-of-range warnings.
        // The device receives one iduTemperature regardless of which handle
        // the user drags.
        const t = Number(target);
        const cooling = Math.min(t + 0.5, 32);
        const heating = Math.max(t - 0.5, 16);
        this.push(this.service, C.CoolingThresholdTemperature, cooling);
        this.push(this.service, C.HeatingThresholdTemperature, heating);
      } else {
        this.push(this.service, C.CoolingThresholdTemperature, target);
        this.push(this.service, C.HeatingThresholdTemperature, target);
      }
    }
    this.push(this.service, C.RotationSpeed, this.rotationSpeedValue());
    this.push(this.service, C.SwingMode, this.swingModeValue());

    // Mode + fan + swing switches
    this.push(
      this.dryService,
      C.On,
      this.device.power === "ON" && this.device.mode === "DRY",
    );
    this.push(
      this.fanOnlyService,
      C.On,
      this.device.power === "ON" && this.device.mode === "FAN",
    );
    this.push(
      this.dryCoolService,
      C.On,
      this.device.power === "ON" && this.device.mode === "DRY_COOL",
    );
    this.push(this.autoFanService, C.On, this.device.fanSpeed === "AUTO");
    this.push(
      this.swingVService,
      C.On,
      this.device.fanSwing === "VERTICAL" || this.device.fanSwing === "BOTH",
    );
    this.push(
      this.swingHService,
      C.On,
      this.device.fanSwing === "HORIZONTAL" || this.device.fanSwing === "BOTH",
    );

    // HumidifierDehumidifier
    if (this.humidifierService) {
      this.push(
        this.humidifierService,
        C.Active,
        this.humidifierActiveValue(),
      );
      this.push(
        this.humidifierService,
        C.CurrentHumidifierDehumidifierState,
        this.humidifierCurrentState(),
      );
      const humidity = this.humidityValue();
      this.push(
        this.humidifierService,
        C.CurrentRelativeHumidity,
        humidity,
      );
      this.push(
        this.humidifierService,
        C.RelativeHumidityDehumidifierThreshold,
        humidity,
      );
    }
  }

  /** Update one characteristic, or mark it No-Response when offline. */
  private push(
    service: Service,
    characteristic: CharLike,
    value: CharacteristicValue,
  ): void {
    if (this.device.online) {
      service.updateCharacteristic(characteristic, value);
    } else {
      service.updateCharacteristic(characteristic, this.commError());
    }
  }
}
