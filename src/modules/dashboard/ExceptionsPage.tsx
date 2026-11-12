import { Navigate, useSearchParams } from "react-router-dom";

// Owner 2026-11-12: the moments to explain moved into My file -> Attendance -> Exceptions; old links and
// notifications land there, on the same exception.
export default function ExceptionsPage() {
  const [searchParams] = useSearchParams();
  const id = searchParams.get("exceptionId");
  return <Navigate to={`/me?tab=attendance&view=exceptions${id ? `&exceptionId=${encodeURIComponent(id)}` : ""}`} replace />;
}
