import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, Typography } from "@mui/material";
import { fetchAttendance, fetchAthulyaSchedules, type AttendanceRecord, type AthulyaSchedule } from "../api/client";
import { PageHeader, StatusChip } from "../components/OperationsUI";

function matchingAttendance(schedule: AthulyaSchedule, records: AttendanceRecord[]) {
  const ids = new Set([schedule.athulyaScheduleId, schedule.athulyaSchedulePk].filter(Boolean));
  return records.filter((record) => ids.has(record.assignmentId));
}

function AttendanceStage({ records, stage, emptyLabel }: { records: AttendanceRecord[]; stage: "checkIn" | "checkOut"; emptyLabel: string }) {
  if (!records.length) return <Typography variant="body2" color="text.secondary">{emptyLabel}</Typography>;
  return <Stack spacing={0.5}>
    {records.map((record) => <Stack key={record.sessionId} direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
      {records.length > 1 && <Typography variant="caption" color="text.secondary">{record.employee.name}:</Typography>}
      <StatusChip status={record[stage].status || "pending"} />
    </Stack>)}
  </Stack>;
}

export function AttendanceSchedulesPage() {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selectedSchedule, setSelectedSchedule] = useState<AthulyaSchedule | null>(null);
  const schedules = useQuery({
    queryKey: ["athulya-schedules", "all"],
    queryFn: () => fetchAthulyaSchedules(),
    refetchInterval: 30_000,
  });
  const attendance = useQuery({
    queryKey: ["attendance", "schedule-status"],
    queryFn: () => fetchAttendance({ limit: 500 }),
    refetchInterval: 15_000,
  });
  const schedulesData = schedules.data || [];
  useEffect(() => setPage(0), [schedulesData.length]);
  const pageRows = schedulesData.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);

  return <Stack spacing={2.5}>
    <PageHeader title="Attendance & schedules" />
    <Card>
      {schedules.isLoading && <LinearProgress />}
      {schedules.isError && <Alert severity="error" sx={{ m: 2 }}>Athulya schedules could not be loaded.</Alert>}
      {attendance.isError && <Alert severity="warning" sx={{ m: 2 }}>Our check-in and check-out statuses could not be loaded.</Alert>}
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 1100 }} aria-label="Athulya schedules and attendance">
          <TableHead><TableRow>{["Date", "Patient", "Care Manager", "Caregivers", "Service", "Branch", "Athulya status", "Check-in", "Check-out", "Details"].map((label) => <TableCell key={label} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {pageRows.map((schedule) => {
              const localTasks = matchingAttendance(schedule, attendance.data || []);
              return <TableRow key={schedule.id} hover>
                <TableCell>{schedule.date || "—"}</TableCell>
                <TableCell>{schedule.patient.name || "—"}</TableCell>
                <TableCell>{schedule.careManager.name || "—"}<Typography variant="caption" display="block" color="text.secondary">{schedule.careManager.phone || ""}</Typography></TableCell>
                <TableCell>{schedule.caregivers.map((caregiver) => caregiver.name || caregiver.phone).join(", ") || "—"}</TableCell>
                <TableCell>{schedule.service || "—"}</TableCell>
                <TableCell>{schedule.branch || "—"}</TableCell>
                <TableCell><StatusChip status={schedule.status || "pending"} /></TableCell>
                <TableCell><AttendanceStage records={localTasks} stage="checkIn" emptyLabel={attendance.isLoading ? "Loading…" : attendance.isError ? "Unavailable" : "Not scheduled"} /></TableCell>
                <TableCell><AttendanceStage records={localTasks} stage="checkOut" emptyLabel={attendance.isLoading ? "Loading…" : attendance.isError ? "Unavailable" : "Not scheduled"} /></TableCell>
                <TableCell><Button size="small" onClick={() => setSelectedSchedule(schedule)}>Details</Button></TableCell>
              </TableRow>;
            })}
            {schedules.isSuccess && schedulesData.length === 0 && <TableRow><TableCell colSpan={10} align="center" sx={{ py: 5 }}>No Athulya schedules imported yet. An Admin can configure and sync schedules in Settings.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination component="div" count={schedulesData.length} page={page} onPageChange={(_, nextPage) => setPage(nextPage)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Schedules per page" />
    </Card>

    <Dialog open={Boolean(selectedSchedule)} onClose={() => setSelectedSchedule(null)} fullWidth maxWidth="md">
      {selectedSchedule && <>
        <DialogTitle>Schedule details</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
            <Detail label="Patient" value={selectedSchedule.patient.name} />
            <Detail label="Patient ID" value={selectedSchedule.patient.id} />
            <Detail label="Patient UHID" value={selectedSchedule.patient.uhid} />
            <Detail label="Schedule record ID" value={selectedSchedule.id} />
            <Detail label="Athulya schedule_id" value={selectedSchedule.athulyaScheduleId} />
            <Detail label="Athulya schedule PK" value={selectedSchedule.athulyaSchedulePk} />
            <Detail label="Date" value={selectedSchedule.date} />
            <Detail label="Start time" value={selectedSchedule.startTime} />
            <Detail label="End time" value={selectedSchedule.endTime} />
            <Detail label="Care Manager" value={`${selectedSchedule.careManager.name || "—"}${selectedSchedule.careManager.id ? ` · ID ${selectedSchedule.careManager.id}` : ""}${selectedSchedule.careManager.phone ? ` · ${selectedSchedule.careManager.phone}` : ""}`} />
            <Detail label="Service" value={selectedSchedule.service} />
            <Detail label="Care plan" value={selectedSchedule.carePlan} />
            <Detail label="Branch" value={selectedSchedule.branch} />
            <Detail label="Vendor" value={selectedSchedule.vendorCompany} />
            <Stack spacing={0.5}>
              <Typography variant="overline" color="text.secondary">Athulya status</Typography>
              <Chip size="small" label={selectedSchedule.status || "pending"} sx={{ alignSelf: "flex-start", textTransform: "capitalize" }} />
            </Stack>
            <Detail label="Last synced" value={selectedSchedule.lastSyncedAt ? new Date(selectedSchedule.lastSyncedAt).toLocaleString() : "—"} />
          </Box>
          <Stack spacing={1} sx={{ mt: 2.5 }}>
            <Typography variant="subtitle1" fontWeight={700}>Caregivers</Typography>
            {selectedSchedule.caregivers.length ? selectedSchedule.caregivers.map((caregiver) => <Card key={`${caregiver.id}:${caregiver.phone}`} variant="outlined" sx={{ p: 1.5, boxShadow: "none" }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} justifyContent="space-between">
                <Box><Typography fontWeight={650}>{caregiver.name || "Caregiver"}</Typography><Typography variant="body2" color="text.secondary">{caregiver.id ? `ID ${caregiver.id} · ` : ""}{caregiver.phone || "Phone unavailable"}</Typography></Box>
                <StatusChip status={caregiver.status || "pending"} />
              </Stack>
            </Card>) : <Typography variant="body2" color="text.secondary">No caregivers listed for this schedule.</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setSelectedSchedule(null)}>Close</Button></DialogActions>
      </>}
    </Dialog>
  </Stack>;
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return <Stack spacing={0.25}><Typography variant="overline" color="text.secondary">{label}</Typography><Typography>{value || "—"}</Typography></Stack>;
}
