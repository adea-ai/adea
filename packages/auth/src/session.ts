export type ProviderSessionInput = {
  session?: {
    expiresAt?: Date | string;
    id?: string;
  };
  user?: {
    email?: string | null;
    id?: string;
    name?: string | null;
  };
};

export type AuthResult = Readonly<{
  identity: Readonly<{
    provider: "neon";
    subject: string;
  }>;
  profile: Readonly<{
    displayName?: string;
    email?: string;
  }>;
  session: Readonly<{
    expiresAt: string;
    id: string;
  }>;
}>;

export function normalizeNeonSession(
  value: ProviderSessionInput | null | undefined,
  now = new Date()
): AuthResult | null {
  if (!value) return null;

  const sessionId = value.session?.id;
  const subject = value.user?.id;
  const expiresAt = value.session?.expiresAt ? new Date(value.session.expiresAt) : undefined;
  if (!sessionId || !subject || !expiresAt || Number.isNaN(expiresAt.valueOf())) {
    throw new Error("Neon Auth returned a malformed session");
  }
  if (expiresAt <= now) {
    throw new Error("Neon Auth session is expired");
  }

  return Object.freeze({
    identity: Object.freeze({ provider: "neon" as const, subject }),
    session: Object.freeze({ expiresAt: expiresAt.toISOString(), id: sessionId }),
    profile: Object.freeze({
      ...(value.user?.name ? { displayName: value.user.name } : {}),
      ...(value.user?.email ? { email: value.user.email } : {}),
    }),
  });
}
