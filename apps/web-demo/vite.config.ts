import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@privacy-sdk",
        replacement: path.resolve(__dirname, "../../packages/sdk/src/index.ts"),
      },
      {
        find: "@privacy-sdk-src/",
        replacement: `${path.resolve(__dirname, "../../packages/sdk/src")}/`,
      },
      {
        find: "@stealth-sdk",
        replacement: path.resolve(
          __dirname,
          "../../../plasma-privacy-testkit/ts/src/index.ts",
        ),
      },
      {
        find: "@stealth-sdk-src/",
        replacement: `${path.resolve(
          __dirname,
          "../../../plasma-privacy-testkit/ts/src",
        )}/`,
      },
      {
        find: "assert",
        replacement: path.resolve(__dirname, "./src/shims/assert.ts"),
      },
    ],
  },
  server: {
    fs: {
      allow: [
        path.resolve(__dirname, "../.."),
        path.resolve(__dirname, "../../../plasma-privacy-testkit"),
      ],
    },
  },
});
