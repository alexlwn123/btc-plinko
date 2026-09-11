import { build } from "esbuild";

// MDK publishes extensionless ESM imports. Bundle for Node/Vercel, keeping the native addon external.
await build({
  entryPoints: ["server/mdkSdk.ts"],
  outfile: "server/generated/mdkSdk.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["@moneydevkit/lightning-js"],
  logLevel: "warning",
});
