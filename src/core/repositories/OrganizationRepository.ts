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
  logoUrl: string | null;
  // § live UX review, user-directed - "control every employee the same
  // way, whether clocked in at a site or not." The org-wide radius
  // (meters) applied around a no-site clock-in's own GPS point.
  noSiteAllowedRadiusMeters: number;
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
        .select("id, organization_code, name, status, logo_url, organization_settings(default_language, default_theme, no_site_allowed_radius_meters)")
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
        logoUrl: data.logo_url ?? null,
        noSiteAllowedRadiusMeters: settings?.no_site_allowed_radius_meters ?? 500,
      });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Organization service unavailable.");
    }
  }

  // § live UX review, user-directed - "a place to upload the company
  // logo so it appears in the organization data in the Header."
  // Uploads directly to the public organization-logos bucket (a
  // company logo is meant to be seen, not access-controlled like
  // camera evidence - same rationale as the storage migration's own
  // header comment), then calls the owner-only RPC to record the new
  // URL on the organizations row itself (no direct client UPDATE grant
  // exists on that table, matching every other organization mutation
  // in this codebase).
  async uploadLogo(organizationId: string, file: File): Promise<ServiceResult<string>> {
    try {
      const extension = file.name.split(".").pop() || "png";
      const path = `organizations/${organizationId}/logo-${Date.now()}.${extension}`;

      const { error: uploadError } = await this.client.storage.from("organization-logos").upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) return createError(uploadError.message);

      const { data: publicUrlData } = this.client.storage.from("organization-logos").getPublicUrl(path);
      const logoUrl = publicUrlData.publicUrl;

      const { data, error } = await this.client.rpc("set_prosm_time_organization_logo", { p_logo_url: logoUrl });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to set the organization logo.");

      return createSuccess(logoUrl);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Organization service unavailable.");
    }
  }

  // § live UX review, user-directed - "control every employee the same
  // way, whether clocked in at a site or not." Owner-only, same
  // "no direct client UPDATE grant" posture as uploadLogo above.
  async setNoSiteAllowedRadius(radiusMeters: number): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("set_prosm_time_no_site_radius", { p_radius_meters: radiusMeters });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to set the no-site radius.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Organization service unavailable.");
    }
  }
}

export default new OrganizationRepository();
