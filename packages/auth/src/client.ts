"use client";

import { createAuthClient } from "@neondatabase/auth/next";

import { createAuthAdapter } from "./adapter";
import { createNeonAuthDriver, type NeonSdk } from "./neon-driver";

export function createNeonClientAdapter() {
  return createAuthAdapter(createNeonAuthDriver(createAuthClient() as unknown as NeonSdk));
}
