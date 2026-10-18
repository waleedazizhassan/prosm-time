import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time secure authentication (§12: "Separate authentication
// identity from employee/workforce profile... Authorization enforced
// server-side with RLS and Edge Functions"). This wraps Supabase Auth's
// own session mechanics only - the real identity fact (organization,
// role, is_owner) always comes from a server-enforced `users` row read
// (UserRepository), never from anything stored on the auth session
// itself.
class AuthService {
  get client() {
    return DatabaseManager.getClient();
  }

  async signIn(email: string, password: string): Promise<ServiceResult> {
    try {
      const { error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Sign-in service unavailable.");
    }
  }

  async signOut(): Promise<ServiceResult> {
    try {
      const { error } = await this.client.auth.signOut();
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Sign-out service unavailable.");
    }
  }

  // § real bug, user-reported - the Windows desktop build "signs out"
  // on every restart even though the session token genuinely persists
  // to disk (confirmed directly in the Electron app's own storage
  // file). Root cause: a fresh Electron process opens its on-disk
  // storage backend asynchronously, and this very first getSession()
  // call - fired the instant the page's JS runs - can race ahead of
  // that and read an empty store, even though the real data is there
  // a moment later. A plain browser tab reload doesn't hit this (the
  // storage backend for that origin is already warm); a genuinely
  // logged-out user still gets null instantly on the retry too, so
  // this costs nothing in the real "not signed in" case.
  async getSession() {
    const { data } = await this.client.auth.getSession();
    if (data.session) return data.session;

    await new Promise((resolve) => setTimeout(resolve, 250));
    const retry = await this.client.auth.getSession();
    return retry.data.session;
  }

  // Owner 2026-10-18: "the app doesn't open offline". A session saved on
  // this device (Supabase keeps it as sb-<project>-auth-token). With no
  // connection, an expired session cannot be renewed, so getSession() gives
  // nothing - or keeps retrying - although the person is still signed in.
  // Supabase removes this entry itself when a session is really ended or
  // invalid, so its presence means "signed in, waiting for a connection".
  hasStoredSession(): boolean {
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) ?? "";
        if (!/^sb-.+-auth-token$/.test(key)) continue;
        const stored = JSON.parse(localStorage.getItem(key) ?? "null") as { refresh_token?: string } | null;
        if (stored?.refresh_token) return true;
      }
    } catch {
      // storage unavailable or unreadable
    }
    return false;
  }

  onAuthStateChange(callback: (event: string, session: unknown) => void) {
    return this.client.auth.onAuthStateChange(callback);
  }

  // § real bug, user-reported - the Android app "signs itself out"
  // after being backgrounded for a while. Root cause: supabase-js's
  // own autoRefreshToken relies on a JS setInterval to renew the
  // access token before it expires, and Android suspends WebView timers
  // while the app is backgrounded (screen off, app switched away from)
  // to save battery - the timer simply never fires. If the access token
  // (1 hour lifetime) expires during that suspension, the app looks
  // signed-out the instant the user returns, even though the longer-
  // lived refresh token on disk is still perfectly valid and could
  // silently repair the session. Called on app resume (useSessionResume,
  // native + web) rather than left to the background timer alone.
  async refreshSession() {
    try {
      const { data, error } = await this.client.auth.refreshSession();
      return !error && Boolean(data.session);
    } catch {
      return false;
    }
  }
}

export default new AuthService();
