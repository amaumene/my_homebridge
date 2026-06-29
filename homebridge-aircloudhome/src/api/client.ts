/**
 * API client for the Hitachi / Shirokuma airCloud Home cloud service.
 *
 * Ported from the Home Assistant Python integration. Handles authentication
 * (sign-in + transparent token refresh), device discovery, and device control.
 *
 * Three-layer rule (from the Python integration): callers should treat this
 * client as the only thing that talks to the cloud. It manages its own access
 * and refresh tokens, refreshing them ahead of expiry and recovering from 401s.
 */

import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from "axios";

import {
  AirCloudHomeApiError,
  AirCloudHomeAuthError,
  AirCloudHomeCommunicationError,
} from "./errors.js";
import {
  type AuthResponse,
  type ControlCommand,
  type ControlPayload,
  type Device,
  type FamilyGroup,
  type FamilyGroupsResponse,
  HUMIDITY_MODES,
  type Mode,
} from "./types.js";
import { clamp, roundToStep } from "../utils.js";

/** Base URL for the airCloud Home API. */
const BASE_URL = "https://api-kuma.aircloudhome.com";

/** Per-request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Refresh tokens this many milliseconds before their stated expiry to account
 * for clock skew and network latency.
 */
const EXPIRY_BUFFER_MS = 60_000;

/** Minimal logger interface (compatible with Homebridge's Logger). */
export interface LoggerLike {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Per-request config extensions used internally to drive the interceptors.
 *
 * `skipAuth` marks the sign-in / refresh endpoints so the request interceptor
 * does not attempt to attach a bearer token or trigger a refresh loop.
 * `_retried` guards the response interceptor against infinite 401 retry loops.
 */
interface RequestConfig extends AxiosRequestConfig {
  skipAuth?: boolean;
  _retried?: boolean;
}

interface InternalRequestConfig extends InternalAxiosRequestConfig {
  skipAuth?: boolean;
  _retried?: boolean;
}

/**
 * API client for AirCloud Home.
 *
 * Public API:
 *   - signIn(): Promise<AuthResponse>
 *   - refreshAccessToken(): Promise<AuthResponse>
 *   - getFamilyGroups(): Promise<FamilyGroup[]>
 *   - getIduList(familyId: number): Promise<Device[]>
 *   - getAllDevices(): Promise<Device[]>
 *   - control(device: Device, changes: ControlCommand): Promise<Device>
 */
export class AirCloudHomeClient {
  private readonly email: string;
  private readonly password: string;
  private readonly log?: LoggerLike;
  private readonly http: AxiosInstance;

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  /** Absolute epoch (ms) when the access token expires. */
  private accessTokenExpiresAt: number | null = null;
  /** Absolute epoch (ms) when the refresh token expires. */
  private refreshTokenExpiresAt: number | null = null;

  /** In-flight token operation, used as a simple mutex. */
  private tokenInFlight: Promise<void> | null = null;

  constructor(email: string, password: string, log?: LoggerLike) {
    this.email = email;
    this.password = password;
    this.log = log;

    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
    });

    this.installInterceptors();
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Sign in with credentials and store the resulting tokens.
   *
   * @throws {AirCloudHomeAuthError} On 401/403 (invalid credentials).
   * @throws {AirCloudHomeCommunicationError} On network/timeout/other errors.
   */
  async signIn(): Promise<AuthResponse> {
    this.log?.debug("airCloud Home: signing in");
    try {
      const response = await this.http.post<AuthResponse>(
        "/iam/auth/sign-in",
        { email: this.email, password: this.password },
        { skipAuth: true } as RequestConfig,
      );
      this.storeTokens(response.data);
      return response.data;
    } catch (error) {
      throw this.toApiError(error, "sign-in");
    }
  }

  /**
   * Refresh the access token using the stored refresh token.
   *
   * @throws {AirCloudHomeAuthError} If the refresh token is invalid/expired
   *   (401/403). The caller should fall back to {@link signIn}.
   * @throws {AirCloudHomeCommunicationError} On network/timeout/other errors.
   */
  async refreshAccessToken(): Promise<AuthResponse> {
    if (!this.refreshToken) {
      throw new AirCloudHomeAuthError(
        "No refresh token available - re-authentication required",
      );
    }

    this.log?.debug("airCloud Home: refreshing access token");
    try {
      const response = await this.http.post<AuthResponse>(
        "/iam/auth/refresh-token",
        undefined,
        {
          skipAuth: true,
          headers: {
            Authorization: `Bearer ${this.refreshToken}`,
            isRefreshToken: "true",
          },
        } as RequestConfig,
      );
      this.storeTokens(response.data);
      return response.data;
    } catch (error) {
      throw this.toApiError(error, "refresh-token");
    }
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  /** Get the list of family groups for the authenticated user. */
  async getFamilyGroups(): Promise<FamilyGroup[]> {
    const response = await this.http.get<FamilyGroupsResponse>(
      "/iam/family-account/v2/groups",
    );
    return response.data?.result ?? [];
  }

  /**
   * Get the list of indoor units for a family group. Each returned device is
   * stamped with `familyId` so later control calls can address it.
   */
  async getIduList(familyId: number): Promise<Device[]> {
    const response = await this.http.get<Device[]>(
      `/rac/ownership/groups/${familyId}/idu-list`,
    );
    const devices = Array.isArray(response.data) ? response.data : [];
    return devices.map((device) => ({ ...device, familyId }));
  }

  /**
   * Discovery entry point: fetch every device across all family groups.
   */
  async getAllDevices(): Promise<Device[]> {
    const groups = await this.getFamilyGroups();
    const devices: Device[] = [];
    for (const group of groups) {
      const idus = await this.getIduList(group.familyId);
      devices.push(...idus);
    }
    return devices;
  }

  // ---------------------------------------------------------------------------
  // Control
  // ---------------------------------------------------------------------------

  /**
   * Apply a partial control change to a device.
   *
   * Builds a full payload by merging `changes` over the device's current known
   * state. `power`, `mode`, `fanSpeed`, `fanSwing` and `iduTemperature` are
   * always sent. `humidity` is included only when the resulting mode is DRY or
   * DRY_COOL (sending it otherwise yields HTTP 400).
   *
   * Value normalization:
   *   - iduTemperature: rounded to nearest 0.5, clamped to 16–32.
   *   - humidity: rounded to nearest 5, clamped to 40–60.
   *
   * @returns The updated device state reflecting the applied changes.
   */
  async control(device: Device, changes: ControlCommand): Promise<Device> {
    if (device.familyId === undefined) {
      throw new AirCloudHomeApiError(
        `Device ${device.id} has no familyId; cannot send control command`,
      );
    }

    const power = changes.power ?? device.power;
    const resolvedMode: Mode = changes.mode ?? device.mode;
    // "UNKNOWN" is an inbound-only reported state; never send it in a PUT or
    // the API may reject it. Coalesce to "AUTO" at the control boundary.
    const mode: Mode = resolvedMode === "UNKNOWN" ? "AUTO" : resolvedMode;
    const fanSpeed = changes.fanSpeed ?? device.fanSpeed;
    const fanSwing = changes.fanSwing ?? device.fanSwing;

    const rawTemperature =
      changes.iduTemperature ?? device.iduTemperature ?? 22;
    const iduTemperature = clamp(roundToStep(rawTemperature, 0.5), 16, 32);

    const payload: ControlPayload = {
      power,
      mode,
      fanSpeed,
      fanSwing,
      iduTemperature,
    };

    // Include humidity only when the device actually reports it AND the
    // effective state is ON + a humidity-capable mode (DRY / DRY_COOL).
    // Never fabricate a default (matches the HA integration; avoids HTTP 400).
    let appliedHumidity: number | undefined;
    if (
      device.humidity !== undefined &&
      power === "ON" &&
      HUMIDITY_MODES.has(mode)
    ) {
      const rawHumidity = changes.humidity ?? device.humidity;
      appliedHumidity = clamp(roundToStep(rawHumidity, 5), 40, 60);
      payload.humidity = appliedHumidity;
    }

    await this.http.put(
      `/rac/basic-idu-control/general-control-command/${device.id}`,
      payload,
      { params: { familyId: device.familyId } },
    );

    // Return optimistic synthesised state. The server may normalise/clamp values
    // differently; the next poll is the authoritative reconciliation point.
    // The PUT response itself carries no device state (only a command id).
    return {
      ...device,
      power,
      mode,
      fanSpeed,
      fanSwing,
      iduTemperature,
      // Always carry the caller‑requested humidity through the cache so it
      // survives even when the current mode does not accept humidity (the API
      // simply ignores it in an incompatible mode). appliedHumidity is the
      // value that was actually sent to the API (DRY/DRY_COOL only); fall back
      // to whatever the caller asked for, then the device's prior value.
      humidity: changes.humidity ?? device.humidity,
      online: true, // a successful PUT proves connectivity
    };
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  /**
   * Ensure a usable access token exists before a request goes out.
   *
   * Decision tree (serialised via a single in-flight promise so concurrent
   * callers do not trigger multiple refreshes):
   *   1. Access token still valid -> nothing to do.
   *   2. No access token, or refresh token expired/missing -> full sign-in.
   *   3. Access token near expiry, refresh token valid -> refresh; if the
   *      refresh fails with an auth error, fall back to a full sign-in.
   */
  private async ensureValidToken(): Promise<void> {
    if (this.isAccessTokenValid()) {
      return;
    }

    // Coalesce concurrent callers onto a single in-flight operation.
    if (this.tokenInFlight) {
      await this.tokenInFlight;
      return;
    }

    this.tokenInFlight = this.performTokenRefresh().finally(() => {
      this.tokenInFlight = null;
    });
    await this.tokenInFlight;
  }

  private async performTokenRefresh(): Promise<void> {
    // Re-check: another caller may have refreshed while we were queued.
    if (this.isAccessTokenValid()) {
      return;
    }

    if (!this.accessToken || !this.isRefreshTokenValid()) {
      await this.signIn();
      return;
    }

    try {
      await this.refreshAccessToken();
    } catch (error) {
      if (error instanceof AirCloudHomeAuthError) {
        this.log?.debug(
          "airCloud Home: refresh failed, falling back to sign-in",
        );
        await this.signIn();
        return;
      }
      throw error;
    }
  }

  private storeTokens(data: AuthResponse): void {
    const now = Date.now();
    if (data.token) {
      this.accessToken = data.token;
      this.accessTokenExpiresAt =
        typeof data.access_token_expires_in === "number"
          ? now + data.access_token_expires_in
          : null;
    }
    if (data.refreshToken) {
      this.refreshToken = data.refreshToken;
      if (typeof data.refresh_token_expires_in === "number") {
        this.refreshTokenExpiresAt = now + data.refresh_token_expires_in;
      }
      // If no new refresh expiry is provided, keep the previously stored value.
    }
  }

  private isAccessTokenValid(): boolean {
    if (!this.accessToken) {
      return false;
    }
    if (this.accessTokenExpiresAt === null) {
      return true;
    }
    return Date.now() < this.accessTokenExpiresAt - EXPIRY_BUFFER_MS;
  }

  private isRefreshTokenValid(): boolean {
    if (!this.refreshToken) {
      return false;
    }
    if (this.refreshTokenExpiresAt === null) {
      return true;
    }
    return Date.now() < this.refreshTokenExpiresAt - EXPIRY_BUFFER_MS;
  }

  // ---------------------------------------------------------------------------
  // Interceptors & error mapping
  // ---------------------------------------------------------------------------

  private installInterceptors(): void {
    // Request: ensure a valid token and attach the bearer header, except for
    // the auth endpoints themselves (which set their own headers via skipAuth).
    this.http.interceptors.request.use(
      async (config: InternalRequestConfig) => {
        if (config.skipAuth) {
          return config;
        }
        await this.ensureValidToken();
        if (this.accessToken) {
          config.headers.set("Authorization", `Bearer ${this.accessToken}`);
        }
        return config;
      },
    );

    // Response: on a 401 for a non-auth, not-yet-retried request, refresh the
    // token (falling back to sign-in) and retry the original request once.
    this.http.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const config = error.config as InternalRequestConfig | undefined;
        const status = error.response?.status;

        if (
          status === 401 &&
          config &&
          !config.skipAuth &&
          !config._retried
        ) {
          config._retried = true;
          try {
            // Route through the mutex-guarded path so concurrent 401s coalesce
            // onto a single in-flight token refresh.
            await this.ensureValidToken();
          } catch (refreshError) {
            return Promise.reject(
              this.toApiError(refreshError, config.url ?? "request"),
            );
          }
          if (this.accessToken) {
            config.headers.set(
              "Authorization",
              `Bearer ${this.accessToken}`,
            );
          }
          try {
            return await this.http.request(config);
          } catch (retryError) {
            return Promise.reject(
              this.toApiError(retryError, config.url ?? "request"),
            );
          }
        }

        return Promise.reject(this.toApiError(error, config?.url ?? "request"));
      },
    );
  }

  /**
   * Map an unknown thrown value (typically an AxiosError) onto the client's
   * error hierarchy. Already-mapped errors pass through unchanged.
   */
  private toApiError(error: unknown, context: string): AirCloudHomeApiError {
    if (error instanceof AirCloudHomeApiError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 401 || status === 403) {
        return new AirCloudHomeAuthError(
          `Authentication failed for ${context} (HTTP ${status})`,
        );
      }
      if (status !== undefined) {
        const body =
          typeof error.response?.data === "string"
            ? error.response?.data
            : JSON.stringify(error.response?.data ?? "");
        this.log?.debug(
          `airCloud Home: HTTP ${status} from ${context}: ${body}`,
        );
        return new AirCloudHomeCommunicationError(
          `Unexpected HTTP ${status} for ${context}`,
        );
      }
      return new AirCloudHomeCommunicationError(
        `Communication error for ${context}: ${error.message}`,
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return new AirCloudHomeApiError(
      `Unexpected error for ${context}: ${message}`,
    );
  }
}
