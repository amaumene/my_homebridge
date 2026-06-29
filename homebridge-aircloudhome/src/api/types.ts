/**
 * TypeScript types for the airCloud Home cloud API.
 *
 * These mirror the shapes returned/consumed by the cloud service and the
 * Python integration's data model.
 */

/** Power state of an indoor unit. */
export type Power = "ON" | "OFF";

/** Operating mode of an indoor unit. */
export type Mode =
  | "HEATING"
  | "COOLING"
  | "FAN"
  | "DRY"
  | "DRY_COOL"
  | "AUTO"
  | "UNKNOWN";

/** Fan speed setting. */
export type FanSpeed = "AUTO" | "LV1" | "LV2" | "LV3" | "LV4" | "LV5";

/** Fan swing / louver setting. */
export type FanSwing = "AUTO" | "OFF" | "VERTICAL" | "HORIZONTAL" | "BOTH";

/**
 * Response body from `POST /iam/auth/sign-in` and
 * `POST /iam/auth/refresh-token`.
 *
 * `*_expires_in` values are durations in **milliseconds**.
 */
export interface AuthResponse {
  token: string;
  refreshToken: string;
  /** Duration in ms. Absent on some refresh responses. */
  access_token_expires_in?: number;
  /** Duration in ms. Absent on refresh responses (only sign-in returns it). */
  refresh_token_expires_in?: number;
}

/** A single family group the account belongs to. */
export interface FamilyGroup {
  familyId: number;
  [key: string]: unknown;
}

/** Response body from `GET /iam/family-account/v2/groups`. */
export interface FamilyGroupsResponse {
  result: FamilyGroup[];
}

/**
 * An indoor unit (IDU) and its current reported state.
 *
 * `familyId` is stamped onto each device by the client after fetching the
 * IDU list, so that subsequent control calls know which family to address.
 */
export interface Device {
  id: number;
  name: string;
  power: Power;
  mode: Mode;
  /**
   * In every mode except AUTO this is the absolute target setpoint (16-32 °C).
   * In AUTO the cloud reuses this field for the relative comfort offset
   * (-3..+3 °C, 0.5 step) and mirrors it into {@link relativeTemperature}.
   */
  iduTemperature: number | null;
  roomTemperature: number | null;
  /**
   * AUTO-mode comfort offset (-3..+3 °C) reported by the cloud. Mirrors
   * `iduTemperature` while in AUTO and is 0 in every other mode.
   */
  relativeTemperature?: number;
  fanSpeed: FanSpeed;
  fanSwing: FanSwing;
  online: boolean;
  /** Cloud-reported critical fault flag, surfaced as HomeKit StatusFault. */
  criticalError?: boolean;
  serialNumber?: string;
  model?: string;
  vendorThingId?: string;
  familyId?: number;
}

/**
 * Partial control update. Any omitted field is taken from the device's
 * current known state when building the full payload.
 */
export interface ControlCommand {
  power?: Power;
  mode?: Mode;
  fanSpeed?: FanSpeed;
  fanSwing?: FanSwing;
  iduTemperature?: number;
}

/**
 * Full control payload sent to the API. `power`, `mode`, `fanSpeed`,
 * `fanSwing` and `iduTemperature` are always present.
 */
export interface ControlPayload {
  power: Power;
  mode: Mode;
  fanSpeed: FanSpeed;
  fanSwing: FanSwing;
  iduTemperature: number;
}
