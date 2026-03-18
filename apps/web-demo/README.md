# Plasma Privacy Web Demo

Plain React + Vite web demo for the Plasma privacy stack in this workspace.

## What it does

- Connects an injected EVM wallet
- Switches the wallet to Plasma Testnet
- Derives a stealth meta-address from the testkit’s versioned signing flow
- Seeds a demo wallet through a local helper service
- Creates and deposits a real privacy note on Plasma testnet
- Generates browser proofs from local circuit artifacts
- Runs the tested relayed-withdrawal flow against the local relayer

## Run the full demo

Fresh clone setup:

```bash
git clone <your-fork-url>
cd privacy-pools-core
yarn
cd apps/web-demo && npm install && cd ../..
```

From the repo root:

Terminal 1:

```bash
cd /Users/seokhyunsim/Developer/Privacy/privacy-pools-core
npm run demo:helper
```

Terminal 2:

```bash
cd /Users/seokhyunsim/Developer/Privacy/privacy-pools-core
npm run demo:relayer
```

Terminal 3:

```bash
cd /Users/seokhyunsim/Developer/Privacy/privacy-pools-core
npm run demo:web
```

Or run the same commands directly from the demo and relayer folders:

Terminal 1:

```bash
cd /Users/seokhyunsim/Developer/Privacy/privacy-pools-core/apps/web-demo
npm install
npm run helper
```

Terminal 2:

```bash
cd /Users/seokhyunsim/Developer/Privacy/privacy-pools-core/packages/relayer
yarn start:ts
```

Terminal 3:

```bash
cd /Users/seokhyunsim/Developer/Privacy/privacy-pools-core/apps/web-demo
npm run dev
```

The app expects:

- helper at `http://127.0.0.1:8787`
- relayer at `http://127.0.0.1:3000`

Both URLs are editable in the UI.

## Build

```bash
cd /Users/seokhyunsim/Developer/Privacy/privacy-pools-core/apps/web-demo
npm run build
npm run preview
```

## Notes

- The helper is test-only and uses the same Plasma updater/deployer key already present in the repo’s test scripts.
- Circuit artifacts are served from `public/artifacts`.
- The relayed withdrawal path mirrors the existing Plasma E2E flow instead of introducing a separate demo-only backend.
