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

/** Modes in which a humidity setpoint is accepted by the API. */
export const HUMIDITY_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "DRY",
  "DRY_COOL",
]);

/**
 * Response body from `POST /iam/auth/sign-in` and
 * `POST /iam/auth/refresh-token`.
 *
 * `*_expires_in` values are durations in **milliseconds**.
 */
export interface AuthResponse {
  token: string;
  refreshToken: string;
  access_token_expires_in: number;
  refresh_token_expires_in: number;
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
  iduTemperature: number | null;
  roomTemperature: number | null;
  fanSpeed: FanSpeed;
  fanSwing: FanSwing;
  humidity?: number;
  online: boolean;
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
  humidity?: number;
}

/**
 * Full control payload sent to the API. `power`, `mode`, `fanSpeed`,
 * `fanSwing` and `iduTemperature` are always present; `humidity` is included
 * only when the resulting mode accepts it (DRY / DRY_COOL).
 */
export interface ControlPayload {
  power: Power;
  mode: Mode;
  fanSpeed: FanSpeed;
  fanSwing: FanSwing;
  iduTemperature: number;
  humidity?: number;
}
