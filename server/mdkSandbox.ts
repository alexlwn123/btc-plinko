import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";

type Env = Record<string, string | undefined>;
type SandboxSdk = typeof import("./mdkSdk");
const require = createRequire(import.meta.url);
const STAGING = {
  MDK_API_BASE_URL: "https://staging.moneydevkit.com/rpc",
  MDK_NETWORK: "signet",
  MDK_VSS_URL: "https://vss.staging.moneydevkit.com/vss",
  MDK_ESPLORA_URL: "https://mutinynet.com/api",
  MDK_RGS_URL: "https://rgs.staging.moneydevkit.com/snapshot",
  MDK_LSP_NODE_ID: "03fd9a377576df94cc7e458471c43c400630655083dee89df66c6ad38d1b7acffd",
  MDK_LSP_ADDRESS: "lsp.staging.moneydevkit.com:9735",
} as const;

export function sandboxConfigured(env: Env) {
  try {
    sandboxConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function sandboxConfig(env: Env) {
  if (env.MDK_NETWORK !== STAGING.MDK_NETWORK)
    throw new Error("Only Money Dev Kit staging on Signet is allowed.");
  if (!env.MDK_ACCESS_TOKEN?.trim() || !env.MDK_MNEMONIC?.trim())
    throw new Error("Money Dev Kit staging credentials are not configured.");
  for (const [key, expected] of Object.entries(STAGING)) {
    if (env[key] && env[key] !== expected)
      throw new Error("Only Money Dev Kit staging on Signet is allowed.");
  }
  return {
    ...STAGING,
    MDK_ACCESS_TOKEN: env.MDK_ACCESS_TOKEN,
    MDK_MNEMONIC: env.MDK_MNEMONIC,
    MDK_PREVIEW: "false",
    NEXT_PUBLIC_MDK_PREVIEW: "false",
  };
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleSandboxRequest(
  request: Request,
  env: Env = process.env,
  loadSdk: () => SandboxSdk = () => require("./generated/mdkSdk.cjs"),
): Promise<Response> {
  if (request.method === "GET") {
    return json({ mdkConfigured: sandboxConfigured(env), network: "signet", redeemable: false });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    // Pin the test network before the SDK can initialize its Lightning node.
    Object.assign(process.env, sandboxConfig(env));
    return await loadSdk().POST(request);
  } catch {
    return json(
      {
        error:
          "Signet checkout unavailable. Check the staging credentials and network configuration.",
      },
      503,
    );
  }
}

// Shared Node adapter for Vite development and Vercel Functions.
export async function sandboxNodeHandler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  try {
    let body = "";
    if (req.body !== undefined)
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    else
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 16_384) {
          res.writeHead(413).end();
          return;
        }
      }
    if (body.length > 16_384) {
      res.writeHead(413).end();
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const protocol = process.env.VERCEL ? "https" : "http";
    const request = new Request(`${protocol}://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      ...(req.method === "POST" ? { body } : {}),
    });
    const response = await handleSandboxRequest(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Sandbox request failed." }));
  }
}
