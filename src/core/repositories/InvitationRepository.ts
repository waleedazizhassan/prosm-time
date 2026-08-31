import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface RedeemInvitationInput {
  email: string;
  verificationCode: string;
  newPassword: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time - the invited employee's own entry point (§12), no
// session exists yet. Calls redeem-invitation, which validates the
// real invitation server-side and sets the real password - this
// repository never decides redemption success itself.
class InvitationRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async redeemInvitation(input: RedeemInvitationInput): Promise<ServiceResult<{ userId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("redeem-invitation", { body: input });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to redeem this invitation.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to redeem this invitation.");
      }

      return createSuccess(data?.data ?? null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Invitation service unavailable.");
    }
  }
}

export default new InvitationRepository();
