// Keep the database package's public import path stable while the pure capture
// contract remains safe for browser-side diagnostic callers.
export {
  NATIVE_SESSION_INVENTORY_MAX_OUTPUT_BYTES,
  NATIVE_SESSION_INVENTORY_PAGE_LIMIT,
  NATIVE_SESSION_INVENTORY_PAGE_TIMEOUT_MS,
  NativeSessionInventoryError,
  captureNativeSessionSection,
  type NativeSessionInventoryFailure,
  type NativeSessionInventoryPage,
  type NativeSessionInventoryScope,
  type NativeSessionInventorySession,
  type NativeSessionInventorySource,
} from '@adea-ai/types/native-session-inventory'
