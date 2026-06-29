/**
 * Plugin entry point.
 *
 * Registers the AirCloudHome dynamic platform with Homebridge.
 */

import type { API } from "homebridge";

import { AirCloudHomePlatform } from "./platform.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AirCloudHomePlatform);
};
