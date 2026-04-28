/**
 * Public type surface for prxy-local.
 *
 * Re-exports the canonical request/response shapes plus the Module + Storage
 * SDK interfaces. Modules in this repo import from here directly. Future plan
 * is to publish `@prxy/module-sdk` to npm so both the cloud and local editions
 * can consume the same package.
 */

export * from './canonical.js';
export * from './sdk.js';
