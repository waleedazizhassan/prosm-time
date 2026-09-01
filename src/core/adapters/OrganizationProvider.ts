// WP-24/§36 - "Define adapter interfaces for... organization...
// providers." See ./README.md. Shape matches OrganizationRepository's
// own real Organization type.
//
// Today's real implementation: OrganizationRepository
// (src/core/repositories/OrganizationRepository.ts), backed by PROSM
// Time's own `organizations`/`organization_settings` tables - the
// standalone system of record. A future PROSM Platform-native
// integration would resolve the same shape from PROSM Platform's own
// organization model instead (§36: "explicit mapping when migrating
// data" - see docs/DATA_OWNERSHIP.md for the stable-ID note).

export interface OrganizationContext {
  id: string;
  organizationCode: string;
  name: string;
  status: string;
  defaultLanguage: string;
  defaultTheme: string;
}

export interface OrganizationProvider {
  getCurrentOrganization(): Promise<OrganizationContext | null>;
}
