import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface ActivationInput {
  activationCode: string;
  organizationName: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerFullName: string;
}

export interface ActivationResultData {
  organizationId: string;
  userId: string;
  licenseNumber: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time - the one pre-session entry point (§5/§37: "Activation /
// Welcome"). Calls activate-organization, which is what actually
// verifies the code server-side against PROSM Management (§5) - this
// repository never talks to PROSM Management directly, and never
// accepts a client-side "activated" flag as truth.
class ActivationRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async activateOrganization(input: ActivationInput): Promise<ServiceResult<ActivationResultData>> {
    try {
      const { data, error } = await this.client.functions.invoke("activate-organization", {
        body: input,
      });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to activate this organization.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to activate this organization.");
      }

      return createSuccess(data?.data ?? null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Activation service unavailable.");
    }
  }
}

export default new ActivationRepository();
