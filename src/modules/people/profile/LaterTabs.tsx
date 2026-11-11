import type { EmployeeProfile } from "../../../core/repositories/EmployeeProfileRepository";
import ProfileDocumentsPanel from "../../documents/ProfileDocumentsPanel";
import ProfilePenaltiesPanel from "../../penalties/ProfilePenaltiesPanel";

// HR suite: the profile tabs that belong to the documents (feature 2) and penalties (feature 1) modules
export function ProfileDocumentsTab({ profile, onChanged }: { profile: EmployeeProfile; onChanged: () => void }) {
  return <ProfileDocumentsPanel profile={profile} onChanged={onChanged} />;
}

export function ProfilePenaltiesTab({ profile }: { profile: EmployeeProfile }) {
  return <ProfilePenaltiesPanel profile={profile} />;
}
