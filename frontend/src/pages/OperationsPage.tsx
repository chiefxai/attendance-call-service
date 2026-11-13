import type { SyntheticEvent } from "react";
import { Box, Button, Chip, Stack, Tab, Tabs } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import { OverviewPage } from "./OverviewPage";
import { ReportsPage } from "./ReportsPage";
import { PageHeader } from "../components/OperationsUI";

export function OperationsPage({ userRole = "admin" }: { userRole?: "admin" | "care_manager" }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("view") === "reports" ? 1 : 0;

  const changeTab = (_event: SyntheticEvent, value: number) => {
    const next = new URLSearchParams(searchParams);
    if (value === 1) next.set("view", "reports");
    else next.delete("view");
    setSearchParams(next, { replace: true });
  };

  return <Stack spacing={2.5}>
    <PageHeader title="Operations dashboard" actions={<><Chip label={new Date().toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })} variant="outlined" /><Button component={RouterLink} to="/attendance" variant="contained" endIcon={<ArrowForwardRoundedIcon />}>Open attendance</Button></>} />
    <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
      <Tabs value={activeTab} onChange={changeTab} aria-label="Operations dashboard sections">
        <Tab label="Overview" id="operations-tab-overview" aria-controls="operations-panel-overview" />
        <Tab label="Reports" id="operations-tab-reports" aria-controls="operations-panel-reports" />
      </Tabs>
    </Box>
    <Box role="tabpanel" id={activeTab === 0 ? "operations-panel-overview" : "operations-panel-reports"}
      aria-labelledby={activeTab === 0 ? "operations-tab-overview" : "operations-tab-reports"}>
      {activeTab === 0 ? <OverviewPage userRole={userRole} embedded /> : <ReportsPage embedded />}
    </Box>
  </Stack>;
}
