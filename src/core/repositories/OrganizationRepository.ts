import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface Organization {
  id: string;
  organizationCode: string;
  name: string;
  status: string;
  defaultLanguage: string;
  defaultTheme: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time - the caller's own organization + settings (§11:
// "Organization/company profile"). RLS ("members can view own
// organization"/"...own organization settings", 20260831110000) means
// this always resolves to exactly the caller's own tenant - there is no
// organizationId parameter to pass or forge.
class OrganizationRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getCurrentOrganization(): Promise<ServiceResult<Organization>> {
    try {
      const { data, error } = await this.client
        .from("organizations")
        .select("id, organization_code, name, status, organization_settings(default_language, default_theme)")
        .maybeSingle();

      if (error) return createError(error.message);
      if (!data) return createError("Organization not found.");

      const settings = Array.isArray(data.organization_settings) ? data.organization_settings[0] : data.organization_settings;

      return createSuccess({
        id: data.id,
        organizationCode: data.organization_code,
        name: data.name,
        status: data.status,
        defaultLanguage: settings?.default_language ?? "en",
        defaultTheme: settings?.default_theme ?? "dark",
      });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Organization service unavailable.");
    }
  }
}

export default new OrganizationRepository();
