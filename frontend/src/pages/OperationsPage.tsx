import { OverviewPage } from "./OverviewPage";

export function OperationsPage({ userRole = "admin" }: { userRole?: "admin" | "care_manager" }) {
  return <OverviewPage userRole={userRole} />;
}
