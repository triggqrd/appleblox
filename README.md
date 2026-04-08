# AppleBlox

<div align="center">
<img src=".github/assets/logo.png" style="width:30%;">
</div>

---

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/AppleBlox/appleblox/build.yml?color=%23F43F5E)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/AppleBlox/appleblox/total?color=%23F43F5E)
![GitHub License](https://img.shields.io/github/license/AppleBlox/appleblox?color=%23F43F5E)
![GitHub package.json version](https://img.shields.io/github/package-json/v/AppleBlox/appleblox?color=%23F43F5E)
![Static Badge](https://img.shields.io/badge/built_with_apples-%23F43F5E)
[![Discord](https://img.shields.io/discord/1263512148450082837?logo=discord&logoColor=white&label=discord&color=4d3dff)](https://discord.gg/MWHgn8VNZT)

AppleBlox is a Roblox launcher for **MacOS**, inspired by [Bloxstrap](https://github.com/pizzaboxer/bloxstrap). It includes features such as DiscordRPC and Fast-flags, with ongoing development for additional functionality.

The latest version is available on the [Releases](https://github.com/AppleBlox/appleblox/releases/latest) page. For more recent (development) builds, see the [nightly releases](https://nightly.link/AppleBlox/appleblox/workflows/build/dev?preview).

## Features

AppleBlox supports many useful features, notably the ability to change the Roblox font and icon color along with other assets, go past your screen's refresh rate cap, show what you're playing on Discord, choose which region you want to prioritize joining, and many more features, all documented on the [official documentation](https://docs.appleblox.com).

## Development

Setting up the AppleBlox development environment:

1. Clone the repository
2. Execute `bun install`

Development commands:

- `bun run --bun dev`: Start the development environment
- `bun run --bun build`: Package the application
- `bun run --bun release`: Build and create a PKG installer

AppleBlox is built using [Svelte](https://svelte.dev) for the frontend and [NeutralinoJS](https://neutralino.js.org) for the backend. NeutralinoJS is a lightweight C++ alternative to Electron or NW.JS, suitable for single-platform applications. More information is available at [neutralino.js.org/docs](https://neutralino.js.org/docs).

## Pre-compiled Binaries

The build script utilizes pre-compiled binaries for `alerter` and `discord-rpc-cli` to simplify the build process:

- `alerter`: Sourced from [vjeantet/alerter](https://github.com/vjeantet/alerter) releases
- `discord-rpc-cli`: Built from [AppleBlox/Discord-RPC-cli](https://github.com/AppleBlox/Discord-RPC-cli)

## Privacy Policy

AppleBlox does not collect, store, or transmit any personal data. The only information sent to external non-Roblox servers are statistics about the Roblox game servers you join (uptime, region, ...), when you use the "Region selection" feature. AppleBlox uses the [RoValra[(https://www.rovalra.com/) API and needs to transmit this data to make sure the API stays up-to-date. No personal data is ever collected.

## Contributing

Contributions are welcome. Please feel free to submit issues, pull requests, or discuss ideas. For further discussion, contact `contact@origaming.ch` or reach out on Discord `@Origaming`.

## Gallery

<div float="left">
    <img src=".github/assets/src1.png" style="width:45%;">
    <img src=".github/assets/src2.png" style="width:45%;">
    <img src=".github/assets/src3.png" style="width:45%;">
    <img src=".github/assets/src4.png" style="width:45%;">
    <img src=".github/assets/src7.png" style="width:45%;">
    <img src=".github/assets/src5.png" style="width:45%;">
    <img src=".github/assets/src6.png" style="width:35%;">
</div>

## Credits

- Logo: @typeofnull
- Inspiration: @pizzaboxer's Bloxstrap
- Icons: lucide-svelte & icons8
- Objective-C sidecar: Generated with assistance from ClaudeAI and ChatGPT. Contributors are sought to replace this code.
