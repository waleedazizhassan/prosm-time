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

// PROSM Time - the forgotten-password user's own entry point, no
// session exists yet. Mirrors InvitationRepository's own shape exactly
// - real validation always happens server-side (request-password-reset/
// reset-password), this repository never decides success itself.
class PasswordResetRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async requestReset(email: string): Promise<ServiceResult<{ message: string; email: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("request-password-reset", { body: { email } });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to request a password reset.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to request a password reset.");
      }

      return createSuccess(data?.data ?? null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Password reset service unavailable.");
    }
  }

  async resetPassword(input: { email: string; verificationCode: string; newPassword: string }): Promise<ServiceResult<{ userId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("reset-password", { body: input });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to reset this password.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to reset this password.");
      }

      return createSuccess(data?.data ?? null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Password reset service unavailable.");
    }
  }
}

export default new PasswordResetRepository();
