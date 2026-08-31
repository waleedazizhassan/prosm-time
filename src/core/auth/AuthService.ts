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

  async getSession() {
    const { data } = await this.client.auth.getSession();
    return data.session;
  }

  onAuthStateChange(callback: (event: string, session: unknown) => void) {
    return this.client.auth.onAuthStateChange(callback);
  }
}

export default new AuthService();
