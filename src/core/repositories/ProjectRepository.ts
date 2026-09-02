import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface Project {
  id: string;
  siteId: string;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
}

export interface ProjectAssignment {
  id: string;
  projectId: string;
  userId: string;
  userFullName: string;
  userEmail: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface ProjectRow {
  id: string;
  site_id: string;
  name: string;
  code: string | null;
  description: string | null;
  is_active: boolean;
}

function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    code: row.code,
    description: row.description,
    isActive: row.is_active,
  };
}

interface ProjectAssignmentRow {
  id: string;
  project_id: string;
  user_id: string;
  users: { full_name: string; email: string } | { full_name: string; email: string }[] | null;
}

function mapProjectAssignmentRow(row: ProjectAssignmentRow): ProjectAssignment {
  const user = Array.isArray(row.users) ? row.users[0] : row.users;
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    userFullName: user?.full_name ?? "",
    userEmail: user?.email ?? "",
  };
}

// PROSM Time - §14 "Project Selection": Site -> Project -> Employee ->
// Assignment. Reads are RLS-scoped to the caller's own organization;
// every mutation is a real RPC (create/update_prosm_time_project,
// set/remove_prosm_time_project_assignment) that re-checks
// 'projects.manage' server-side - this repository enforces nothing
// itself.
class ProjectRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listProjectsForSite(siteId: string): Promise<ServiceResult<Project[]>> {
    try {
      const { data, error } = await this.client.from("projects").select("*").eq("site_id", siteId).order("name", { ascending: true });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapProjectRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Project service unavailable.");
    }
  }

  // WP-06/§14: "Employees must not be able to select projects to which
  // they are not assigned." This is only what the Clock In picker
  // offers - clock_in_prosm_time_attendance() re-checks the same
  // project_assignments row server-side regardless.
  async listAssignedProjectsForSite(userId: string, siteId: string): Promise<ServiceResult<Project[]>> {
    try {
      const { data, error } = await this.client.from("project_assignments").select("projects!inner(*)").eq("user_id", userId).eq("projects.site_id", siteId);
      if (error) return createError(error.message);
      const projects = (data ?? []).flatMap((row) => {
        const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
        return project ? [mapProjectRow(project)] : [];
      });
      return createSuccess(projects);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Project service unavailable.");
    }
  }

  async createProject(siteId: string, name: string, code: string | null, description: string | null): Promise<ServiceResult<{ projectId: string }>> {
    try {
      const { data, error } = await this.client.rpc("create_prosm_time_project", {
        p_site_id: siteId,
        p_name: name,
        p_code: code,
        p_description: description,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to create this project.");
      return createSuccess({ projectId: data.projectId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Project service unavailable.");
    }
  }

  async updateProject(projectId: string, name: string, code: string | null, description: string | null, isActive: boolean): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("update_prosm_time_project", {
        p_project_id: projectId,
        p_name: name,
        p_code: code,
        p_description: description,
        p_is_active: isActive,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to update this project.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Project service unavailable.");
    }
  }

  async listProjectAssignments(projectId: string): Promise<ServiceResult<ProjectAssignment[]>> {
    try {
      const { data, error } = await this.client.from("project_assignments").select("id, project_id, user_id, users!project_assignments_user_id_fkey(full_name, email)").eq("project_id", projectId);
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapProjectAssignmentRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Project service unavailable.");
    }
  }

  async setProjectAssignment(projectId: string, userId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("set_prosm_time_project_assignment", {
        p_project_id: projectId,
        p_user_id: userId,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to assign this employee to the project.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Project service unavailable.");
    }
  }

  async removeProjectAssignment(projectId: string, userId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("remove_prosm_time_project_assignment", {
        p_project_id: projectId,
        p_user_id: userId,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to remove this project assignment.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Project service unavailable.");
    }
  }
}

export default new ProjectRepository();
