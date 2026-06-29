/**
 * Error hierarchy for the airCloud Home API client.
 *
 * Mirrors the Python integration's exception hierarchy:
 *
 *   AirCloudHomeApiError (base)
 *   ├── AirCloudHomeCommunicationError (network / timeout / non-2xx)
 *   └── AirCloudHomeAuthError (401 / 403 authentication failures)
 */

/** Base exception indicating a general API error. */
export class AirCloudHomeApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirCloudHomeApiError";
    // Restore prototype chain (needed when targeting ES5/ES2015 down-levels).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Authentication failure (HTTP 401 / 403). The caller should re-authenticate. */
export class AirCloudHomeAuthError extends AirCloudHomeApiError {
  constructor(message: string) {
    super(message);
    this.name = "AirCloudHomeAuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Communication failure (network error, timeout, or non-2xx response). */
export class AirCloudHomeCommunicationError extends AirCloudHomeApiError {
  constructor(message: string) {
    super(message);
    this.name = "AirCloudHomeCommunicationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
