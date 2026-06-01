/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as cashier from "../cashier.js";
import type * as cashierCore from "../cashierCore.js";
import type * as lightning from "../lightning.js";
import type * as lndClient from "../lndClient.js";
import type * as plinko from "../plinko.js";
import type * as plinkoCore from "../plinkoCore.js";
import type * as users from "../users.js";
import type * as walletCore from "../walletCore.js";
import type * as wallets from "../wallets.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  cashier: typeof cashier;
  cashierCore: typeof cashierCore;
  lightning: typeof lightning;
  lndClient: typeof lndClient;
  plinko: typeof plinko;
  plinkoCore: typeof plinkoCore;
  users: typeof users;
  walletCore: typeof walletCore;
  wallets: typeof wallets;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
