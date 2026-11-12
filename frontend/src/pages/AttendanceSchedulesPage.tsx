import { useQuery } from "@tanstack/react-query";
import { Alert, Card, LinearProgress, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { fetchAthulyaSchedules } from "../api/client";
import { PageHeader } from "../components/OperationsUI";

export function AttendanceSchedulesPage() {
  const schedules = useQuery({
    queryKey: ["athulya-schedules", "all"],
    queryFn: () => fetchAthulyaSchedules(),
    refetchInterval: 30_000,
  });

  return <Stack spacing={2.5}>
    <PageHeader title="Attendance & schedules" />
    <Card>
      {schedules.isLoading && <LinearProgress />}
      {schedules.isError && <Alert severity="error" sx={{ m: 2 }}>Athulya schedules could not be loaded.</Alert>}
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 900 }} aria-label="Athulya schedules">
          <TableHead><TableRow>{["Date", "Patient", "Patient ID / UHID", "Care Manager", "Caregivers", "Scheduled time", "Service", "Branch", "Status"].map((label) => <TableCell key={label} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {schedules.data?.map((schedule) => <TableRow key={schedule.id} hover>
              <TableCell>{schedule.date || "—"}</TableCell>
              <TableCell>{schedule.patient.name || "—"}</TableCell>
              <TableCell>{schedule.patient.id || "—"} / {schedule.patient.uhid || "—"}</TableCell>
              <TableCell>{schedule.careManager.name || "—"}<Typography variant="caption" display="block" color="text.secondary">{schedule.careManager.phone || ""}</Typography></TableCell>
              <TableCell>{schedule.caregivers.map((caregiver) => caregiver.name || caregiver.phone).join(", ") || "—"}</TableCell>
              <TableCell sx={{ whiteSpace: "nowrap" }}>{schedule.startTime || "—"} – {schedule.endTime || "—"}</TableCell>
              <TableCell>{schedule.service || "—"}</TableCell>
              <TableCell>{schedule.branch || "—"}</TableCell>
              <TableCell>{schedule.status || "—"}</TableCell>
            </TableRow>)}
            {schedules.isSuccess && schedules.data.length === 0 && <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5 }}>No Athulya schedules imported yet. An Admin can configure and sync schedules in Settings.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  </Stack>;
}
