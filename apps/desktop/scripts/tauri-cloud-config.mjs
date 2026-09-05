const DEFAULT_CLOUD_ORIGIN = "https://adea.dev";

export function normalizeDesktopCloudOrigin(value = DEFAULT_CLOUD_ORIGIN) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("Desktop cloud origin must be an HTTPS origin or loopback HTTP origin");
  }
  return url.origin;
}

export function createTauriCloudConfig(value) {
  const cloudOrigin = normalizeDesktopCloudOrigin(value);
  return {
    app: {
      security: {
        csp: [
          "default-src 'self' customprotocol: asset:",
          `connect-src 'self' blob: ipc: http://ipc.localhost ${cloudOrigin} ws://127.0.0.1:1420`,
          "img-src 'self' asset: data: blob: https://raw.githubusercontent.com",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self'",
        ].join("; "),
      },
    },
  };
}
