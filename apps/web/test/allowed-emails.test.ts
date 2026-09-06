import { afterEach, describe, expect, test } from "bun:test";

import { emailAllowlistConfigured, isAllowedEmail } from "../src/server/allowed-emails";

const VARIABLE = "ADEA_ALLOWED_EMAILS";

const previous = process.env[VARIABLE];

function setAllowlist(value: string | undefined) {
  if (value === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = value;
}

describe("email allowlist", () => {
  afterEach(() => {
    if (previous === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = previous;
  });

  test("is unconfigured when the variable is unset or blank", () => {
    setAllowlist(undefined);
    expect(emailAllowlistConfigured()).toBe(false);
    expect(isAllowedEmail("anyone@example.com")).toBe(true);
    expect(isAllowedEmail(undefined)).toBe(true);

    setAllowlist("   ");
    expect(emailAllowlistConfigured()).toBe(false);
  });

  test("matches listed emails case-insensitively and trims entries", () => {
    setAllowlist(" Andrew.Mahoney.F@Gmail.com , any@niftyleague.com,ali@niftyleague.com");
    expect(emailAllowlistConfigured()).toBe(true);
    expect(isAllowedEmail("andrew.mahoney.f@gmail.com")).toBe(true);
    expect(isAllowedEmail("ANY@NIFTYLEAGUE.COM")).toBe(true);
    expect(isAllowedEmail("ali@niftyleague.com")).toBe(true);
    expect(isAllowedEmail("someone.else@example.com")).toBe(false);
  });

  test("rejects sessions without an email while the allowlist is active", () => {
    setAllowlist("andrew.mahoney.f@gmail.com");
    expect(isAllowedEmail(undefined)).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
  });
});
