export type AuthUser = {
  id: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
};

export type AuthSession = {
  user: AuthUser;
  accessToken?: string;
  expiresAt?: string;
};

export interface AuthProvider {
  getSession(): Promise<AuthSession | null>;
  signIn(): Promise<AuthSession>;
  signOut(): Promise<void>;
}

export const guestAuthProvider: AuthProvider = {
  async getSession() {
    return null;
  },
  async signIn() {
    return { user: { id: "guest", displayName: "Guest operator" } };
  },
  async signOut() {},
};
