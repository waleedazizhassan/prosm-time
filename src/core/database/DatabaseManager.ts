import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseClient } from "../api/supabaseClient";

export interface ConnectionCheckResult {
  success: boolean;
  message: string;
}

// PROSM Time's repository access point - every repository gets its
// client via DatabaseManager.getClient(), never by importing
// supabaseClient directly. Mirrors PROSM Platform's own
// src/core/database/DatabaseManager.js convention (shared domain
// convention, WP-01) so a repository written for one product reads
// exactly the same in the other.
class DatabaseManager {
  private client: SupabaseClient | null = null;

  initialize(): SupabaseClient {
    if (!this.client) {
      this.client = requireSupabaseClient();
    }
    return this.client;
  }

  getClient(): SupabaseClient {
    if (!this.client) {
      return this.initialize();
    }
    return this.client;
  }

  async checkConnection(): Promise<ConnectionCheckResult> {
    try {
      const client = this.getClient();
      // organizations is PROSM Time's own first-party table (§34) -
      // exists from PROSM Time's own foundation migration, not
      // borrowed from PROSM Platform's schema of the same name.
      const { error } = await client.from("organizations").select("id").limit(1);

      if (error) {
        return { success: false, message: error.message };
      }

      return { success: true, message: "Database connection successful." };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown database error.",
      };
    }
  }

  reset(): void {
    this.client = null;
  }
}

export default new DatabaseManager();
