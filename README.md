# Privacy Pool Protocol — Plasma Network Fork

> **This is a fork of [0xbow-io/privacy-pools-core](https://github.com/0xbow-io/privacy-pools-core)** adapted for [Plasma Network](https://plasma.io) (chain ID 9746). See **[PLASMA-CHANGELOG.md](./PLASMA-CHANGELOG.md)** for a detailed description of every change from upstream and the reasoning behind it.

Privacy Pool is a blockchain protocol that enables private asset transfers. Users can deposit funds publicly and partially withdraw them privately, provided they can prove membership in an approved set of addresses.

## Overview

The protocol implements a system of smart contracts and zero-knowledge proofs to enable privacy-preserving transfers while maintaining compliance through approved address sets. It supports both native assets and ERC20 token transfers.

## Repository Structure

This is a Yarn workspaces monorepo containing four packages:

```
├── packages/
│   ├── circuits/    # Zero-knowledge circuits
│   └── contracts/   # Smart contract implementations
│   └── relayer/     # Minimal relayer implementation
│   └── sdk/         # Typescript toolkit
```

See the README in each package for detailed information about their specific implementations:

- [Circuits Package](./packages/circuits/README.md)
- [Contracts Package](./packages/contracts/README.md)
- [Relayer Package](./packages/relayer/README.md)
- [SDK Package](./packages/sdk/README.md)

## Development

To set up the development environment:

```bash
# Install dependencies
yarn
```

## Web Demo

An end-to-end Plasma web demo is available in [`apps/web-demo`](./apps/web-demo/README.md). From the repo root, run:

```bash
# Terminal 1
npm run demo:helper

# Terminal 2
npm run demo:relayer

# Terminal 3
npm run demo:web
```

The demo walks through wallet connect, funding, deposit, browser proving, and relayed withdrawal on Plasma testnet using the same addresses and flow already covered by the repo's tests.
