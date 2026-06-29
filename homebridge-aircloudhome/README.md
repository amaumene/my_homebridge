# homebridge-aircloudhome

Homebridge plugin for **Hitachi / Shirokuma** air conditioners that are managed
through the **airCloud Home** cloud service. It exposes each indoor unit (IDU)
to HomeKit as a Heater/Cooler accessory.

## What it is

A TypeScript Homebridge dynamic platform plugin that talks to the airCloud Home
cloud API (`https://api-kuma.aircloudhome.com`). It signs in with your airCloud
Home account, discovers your indoor units, polls their state, and forwards
control commands (power, mode, temperature, fan speed, swing).

## Install

```bash
npm install -g homebridge-aircloudhome
```

Or install via the Homebridge UI by searching for **Shirokuma AC (airCloud Home)**.

## Configuration

Add a platform block to your Homebridge `config.json` (or use the Homebridge UI
config form):

```json
{
  "platforms": [
    {
      "platform": "AirCloudHome",
      "name": "AirCloudHome",
      "email": "you@example.com",
      "password": "your-password",
      "pollInterval": 300
    }
  ]
}
```

| Option         | Type    | Default        | Description                                         |
| -------------- | ------- | -------------- | --------------------------------------------------- |
| `name`         | string  | `AirCloudHome` | Platform display name.                               |
| `email`        | string  | —              | airCloud Home account email. **Required.**          |
| `password`     | string  | —              | airCloud Home account password. **Required.**       |
| `pollInterval` | integer | `300`          | State refresh interval in seconds (minimum `60`).   |

## Supported features

- Automatic discovery of indoor units across all family groups
- Power on/off
- Modes: Heating, Cooling, Fan, Dry, Dry Cool, Auto
- Target temperature (16–32 °C, 0.5 °C steps)
- Fan speed (Auto, levels 1–5)
- Fan swing (Auto, Off, Vertical, Horizontal, Both)
- Humidity setpoint for Dry / Dry Cool modes (40–60 %, 5 % steps)
- Current room temperature reporting

## License

MIT
