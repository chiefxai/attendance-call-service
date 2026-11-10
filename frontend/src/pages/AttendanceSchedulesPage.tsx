import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Button, Card, Stack, Tab, Tabs } from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import { PageHeader } from "../components/OperationsUI";
import { AttendancePage } from "./AttendancePage";
import { DutySchedulesPage } from "./DutySchedulesPage";

type Section = "attendance" | "schedules";

export function AttendanceSchedulesPage({ defaultSection = "attendance" }: { defaultSection?: Section }) {
  const [section, setSection] = useState<Section>(defaultSection);

  return (
    <Stack spacing={2.5}>
      <PageHeader
        eyebrow="SHIFT OPERATIONS"
        title="Attendance & schedules"
        description="Manage staff duty assignments and verify their check-in and check-out times in one place."
        actions={<Button component={RouterLink} to="/assignments/new" variant="contained" startIcon={<AddRoundedIcon />}>New assignment</Button>}
      />
      <Card sx={{ px: 1, pt: 0.5 }}>
        <Tabs
          value={section}
          onChange={(_event, value: Section) => setSection(value)}
          aria-label="Attendance and duty schedules"
          variant="scrollable"
          allowScrollButtonsMobile
        >
          <Tab value="attendance" label="Attendance" />
          <Tab value="schedules" label="Duty schedules" />
        </Tabs>
      </Card>
      {section === "attendance" ? <AttendancePage embedded /> : <DutySchedulesPage embedded />}
    </Stack>
  );
}
