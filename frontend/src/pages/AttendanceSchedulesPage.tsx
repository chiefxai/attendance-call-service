import { useEffect, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography } from "@mui/material";
import EventAvailableRoundedIcon from "@mui/icons-material/EventAvailableRounded";
import PlayCircleOutlineRoundedIcon from "@mui/icons-material/PlayCircleOutlineRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import TaskAltRoundedIcon from "@mui/icons-material/TaskAltRounded";
import { fetchAttendance, fetchAthulyaSchedules, fetchSessionArtifacts, type AttendanceRecord, type AthulyaSchedule } from "../api/client";
import { MetricCard, PageHeader, StatusChip } from "../components/OperationsUI";
import { CallRecording } from "../components/CallRecording";

function todayInIndia() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function statusGroup(status: string | null | undefined) {
  const value = String(status || "pending").trim().toLowerCase().replaceAll(/[\s_-]/g, "");
  if (["completed", "complete", "done"].includes(value)) return "completed";
  if (["cancelled", "canceled"].includes(value)) return "cancelled";
  if (["", "pending", "scheduled", "notstarted"].includes(value)) return "pending";
  return "active";
}

function matchingAttendance(schedule: AthulyaSchedule, records: AttendanceRecord[]) {
  const ids = new Set([schedule.athulyaScheduleId, schedule.athulyaSchedulePk].filter(Boolean));
  return records.filter((record) => ids.has(record.assignmentId));
}

function scheduleClock(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && /[T ]/.test(value)) {
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);
  }
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 24 && minute < 60) return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, hour, minute));
  }
  return value;
}

function scheduleDateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  }).format(date);
}

function dateTimeLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
  }).format(date);
}

function AttendanceStage({ records, stage, scheduledTime, emptyLabel }: { records: AttendanceRecord[]; stage: "checkIn" | "checkOut"; scheduledTime: string | null | undefined; emptyLabel: string }) {
  if (!records.length) return <Typography variant="body2" color="text.secondary">{scheduleClock(scheduledTime) === "—" ? emptyLabel : scheduleClock(scheduledTime)}</Typography>;
  return <Stack spacing={0.5}>
    {records.map((record) => <Stack key={record.sessionId} direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
      {records.length > 1 && <Typography variant="caption" color="text.secondary">{record.employee.name}:</Typography>}
      <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>{scheduleClock(record[stage].reportedAt || scheduledTime)}</Typography>
    </Stack>)}
  </Stack>;
}

export function AttendanceSchedulesPage() {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selectedDate, setSelectedDate] = useState(todayInIndia);
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedSchedule, setSelectedSchedule] = useState<AthulyaSchedule | null>(null);
  const schedules = useQuery({
    queryKey: ["athulya-schedules", selectedDate],
    queryFn: () => fetchAthulyaSchedules({ fromDate: selectedDate, toDate: selectedDate }),
    refetchInterval: 30_000,
  });
  const attendance = useQuery({
    queryKey: ["attendance", "schedule-status"],
    queryFn: () => fetchAttendance({ limit: 500 }),
    refetchInterval: 15_000,
  });
  const scheduleAttendance = useQuery({
    queryKey: ["attendance", "schedule-detail", selectedSchedule?.id],
    enabled: Boolean(selectedSchedule),
    queryFn: async () => {
      const ids = [selectedSchedule?.athulyaScheduleId, selectedSchedule?.athulyaSchedulePk].filter((value): value is string => Boolean(value));
      const matches = (await Promise.all(ids.map((search) => fetchAttendance({ search, limit: 500 })))).flat()
        .filter((record) => ids.includes(record.assignmentId));
      return [...new Map(matches.map((record) => [record.sessionId, record])).values()];
    },
    refetchInterval: selectedSchedule ? 15_000 : (false as const),
  });
  const schedulesData = schedules.data || [];
  const scheduleSessions = selectedSchedule
    ? (scheduleAttendance.data || matchingAttendance(selectedSchedule, attendance.data || []))
    : [];
  const conversationQueries = useQueries({ queries: scheduleSessions.map((record) => ({
    queryKey: ["session-artifacts", record.sessionId],
    queryFn: () => fetchSessionArtifacts(record.sessionId),
    enabled: Boolean(selectedSchedule),
    retry: false,
    refetchInterval: selectedSchedule ? 15_000 : (false as const),
  })) });
  const counts = schedulesData.reduce((result, schedule) => {
    result[statusGroup(schedule.status)] += 1;
    return result;
  }, { active: 0, pending: 0, completed: 0, cancelled: 0 });
  const filteredSchedules = schedulesData.filter((schedule) => statusFilter === "all" || statusGroup(schedule.status) === statusFilter);
  useEffect(() => setPage(0), [selectedDate, statusFilter, schedulesData.length]);
  const pageRows = filteredSchedules.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const dateLabel = selectedDate
    ? new Date(`${selectedDate}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })
    : "Choose a date";

  return <Stack spacing={2.5}>
    <PageHeader title="Attendance & schedules" actions={<Chip icon={<EventAvailableRoundedIcon />} label={dateLabel} variant="outlined" />} />
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, sm: 6, md: 3 }}><MetricCard label="Schedules" value={schedules.isLoading ? "—" : schedulesData.length.toLocaleString()} detail="For the selected day" icon={<EventAvailableRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, sm: 6, md: 3 }}><MetricCard label="Active" value={schedules.isLoading ? "—" : counts.active.toLocaleString()} detail="In progress or underway" icon={<PlayCircleOutlineRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, sm: 6, md: 3 }}><MetricCard label="Pending" value={schedules.isLoading ? "—" : counts.pending.toLocaleString()} detail="Waiting to start" icon={<PendingActionsRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 6, sm: 6, md: 3 }}><MetricCard label="Completed" value={schedules.isLoading ? "—" : counts.completed.toLocaleString()} detail="Finished duties" icon={<TaskAltRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
    </Grid>
    <Card>
      {schedules.isLoading && <LinearProgress />}
      {schedules.isError && <Alert severity="error" sx={{ m: 2 }}>Athulya schedules could not be loaded.</Alert>}
      {attendance.isError && <Alert severity="warning" sx={{ m: 2 }}>Our check-in and check-out statuses could not be loaded.</Alert>}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "stretch", sm: "center" }} sx={{ p: 2, borderBottom: "1px solid #e8edf3" }}>
        <TextField type="date" size="small" required label="Schedule date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value || todayInIndia())} InputLabelProps={{ shrink: true }} sx={{ minWidth: { sm: 200 } }} />
        <Button size="small" onClick={() => setSelectedDate(todayInIndia())} disabled={selectedDate === todayInIndia()}>Today</Button>
        <FormControl size="small" sx={{ minWidth: { sm: 190 } }}>
          <InputLabel id="schedule-status-label">Schedule status</InputLabel>
          <Select labelId="schedule-status-label" value={statusFilter} label="Schedule status" onChange={(event) => setStatusFilter(event.target.value)}>
            <MenuItem value="all">All statuses</MenuItem>
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="pending">Pending</MenuItem>
            <MenuItem value="completed">Completed</MenuItem>
            <MenuItem value="cancelled">Cancelled</MenuItem>
          </Select>
        </FormControl>
        <Chip label={`${filteredSchedules.length} schedules`} variant="outlined" sx={{ alignSelf: { xs: "flex-start", sm: "center" } }} />
      </Stack>
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 850 }} aria-label="Athulya schedules and attendance">
          <TableHead><TableRow>{["Patient", "Caregivers", "Service", "Check in", "Check out", "Status", "Details"].map((label) => <TableCell key={label} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {pageRows.map((schedule) => {
              const localTasks = matchingAttendance(schedule, attendance.data || []);
              return <TableRow key={schedule.id} hover>
                <TableCell>{schedule.patient.name || "—"}</TableCell>
                <TableCell>{schedule.caregivers.map((caregiver) => caregiver.name || caregiver.phone).join(", ") || "—"}</TableCell>
                <TableCell>{schedule.service || "—"}</TableCell>
                <TableCell><AttendanceStage records={localTasks} stage="checkIn" scheduledTime={schedule.startTime} emptyLabel={attendance.isLoading ? "Loading…" : attendance.isError ? "Unavailable" : "—"} /></TableCell>
                <TableCell><AttendanceStage records={localTasks} stage="checkOut" scheduledTime={schedule.endTime} emptyLabel={attendance.isLoading ? "Loading…" : attendance.isError ? "Unavailable" : "—"} /></TableCell>
                <TableCell><StatusChip status={schedule.status || "pending"} /></TableCell>
                <TableCell><Button size="small" onClick={() => setSelectedSchedule(schedule)}>Details</Button></TableCell>
              </TableRow>;
            })}
            {schedules.isSuccess && schedulesData.length === 0 && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5 }}>No schedules found for {dateLabel}. Choose another date or sync Athulya schedules in Settings.</TableCell></TableRow>}
            {schedules.isSuccess && schedulesData.length > 0 && filteredSchedules.length === 0 && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5 }}>No {statusFilter} schedules found for {dateLabel}.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination component="div" count={filteredSchedules.length} page={page} onPageChange={(_, nextPage) => setPage(nextPage)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Schedules per page" />
    </Card>

    <Dialog open={Boolean(selectedSchedule)} onClose={() => setSelectedSchedule(null)} fullWidth maxWidth="md" PaperProps={{ sx: { borderRadius: 3 } }}>
      {selectedSchedule && <>
        <DialogTitle sx={{ px: { xs: 2, sm: 3 }, pt: 2.5, pb: 1.5 }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: ".08em" }}>Duty schedule</Typography>
              <Typography variant="h5" fontWeight={750} sx={{ overflowWrap: "anywhere" }}>{selectedSchedule.patient.name || "Patient schedule"}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: .35 }}>{selectedSchedule.service || "Care service"}</Typography>
            </Box>
            <StatusChip status={selectedSchedule.status || "pending"} />
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, py: 2.5, bgcolor: "#fbfcfb" }}>
          <Stack spacing={2}>
            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none", borderColor: "#dfe8e3", bgcolor: "#f4f8f6" }}>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1.5 }}>Duty timing</Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1.2fr 1fr 1fr" }, gap: 2 }}>
                <Detail label="Scheduled date" value={scheduleDateLabel(selectedSchedule.date)} />
                <Detail label="Check-in time" value={scheduleClock(selectedSchedule.startTime)} />
                <Detail label="Check-out time" value={scheduleClock(selectedSchedule.endTime)} />
              </Box>
            </Card>

            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1.5 }}>Patient and care details</Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
                <Detail label="Patient" value={selectedSchedule.patient.name} />
                <Detail label="Patient ID" value={selectedSchedule.patient.id} />
                <Detail label="Patient UHID" value={selectedSchedule.patient.uhid} />
                <Detail label="Service" value={selectedSchedule.service} />
                <Detail label="Care plan" value={selectedSchedule.carePlan} />
                <Detail label="Branch" value={selectedSchedule.branch} />
                <Detail label="Vendor" value={selectedSchedule.vendorCompany} />
                <Detail label="Care Manager" value={selectedSchedule.careManager.name} />
                <Detail label="Care Manager ID" value={selectedSchedule.careManager.id} />
                <Detail label="Care Manager phone" value={selectedSchedule.careManager.phone} />
              </Box>
            </Card>

            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1.5 }}>
                <Box><Typography variant="subtitle2" fontWeight={750}>Assigned caregivers</Typography><Typography variant="caption" color="text.secondary">{selectedSchedule.caregivers.length} assigned</Typography></Box>
              </Stack>
              {selectedSchedule.caregivers.length ? <Stack spacing={1}>
                {selectedSchedule.caregivers.map((caregiver) => <Card key={`${caregiver.id}:${caregiver.phone}`} variant="outlined" sx={{ p: 1.5, boxShadow: "none", bgcolor: "#fff" }}>
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} justifyContent="space-between">
                    <Box><Typography fontWeight={700}>{caregiver.name || "Caregiver"}</Typography><Typography variant="body2" color="text.secondary">{caregiver.id ? `ID ${caregiver.id} · ` : ""}{caregiver.phone || "Phone unavailable"}</Typography></Box>
                    <StatusChip status={caregiver.status || "pending"} />
                  </Stack>
                </Card>)}
              </Stack> : <Alert severity="info">No caregivers are listed on this schedule.</Alert>}
            </Card>

            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Box sx={{ mb: 1.5 }}><Typography variant="subtitle2" fontWeight={750}>Call recordings and transcripts</Typography><Typography variant="caption" color="text.secondary">Every check-in and check-out attempt linked to this schedule.</Typography></Box>
              {scheduleAttendance.isLoading && <LinearProgress />}
              {scheduleAttendance.isError && <Alert severity="error">Could not find attendance call sessions for this schedule.</Alert>}
              {scheduleAttendance.isSuccess && scheduleSessions.length === 0 && <Alert severity="info">No attendance call sessions are linked to this schedule yet.</Alert>}
              {scheduleSessions.map((record, index) => {
                const query = conversationQueries[index];
                const artifacts = query?.data;
                return <Box key={record.sessionId} sx={{ mt: index ? 2 : 0, pt: index ? 2 : 0, borderTop: index ? "1px solid" : undefined, borderColor: "divider" }}>
                  <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="space-between" spacing={.5} sx={{ mb: 1.25 }}>
                    <Box><Typography variant="body2" fontWeight={700}>{record.employee.name || "Caregiver"}</Typography><Typography variant="caption" color="text.secondary">Session {record.sessionId}</Typography></Box>
                    <StatusChip status={record.sessionStatus} />
                  </Stack>
                  {query?.isLoading && <LinearProgress sx={{ mb: 1.25 }} />}
                  {query?.isError && <Alert severity="error" sx={{ mb: 1.25 }}>Could not load this session’s call details.</Alert>}
                  {artifacts && <Stack spacing={1.5}>
                    {(["check_in", "check_out"] as const).map((stage) => {
                      const attempts = artifacts.callAttempts.filter((attempt) => attempt.stage === stage);
                      return <Box key={stage}>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: .75 }}>
                          <Typography variant="body2" fontWeight={700}>{stage === "check_in" ? "Check-in" : "Check-out"}</Typography>
                          <Chip size="small" variant="outlined" label={`${attempts.length} ${attempts.length === 1 ? "call" : "calls"}`} />
                        </Stack>
                        {attempts.length === 0 ? <Typography variant="caption" color="text.secondary">No calls placed for this stage.</Typography> : <Stack spacing={1}>
                          {attempts.map((attempt) => {
                            const transcript = artifacts.transcripts.find((item) => item.callAttemptId === attempt.id);
                            return <Card key={attempt.id} variant="outlined" sx={{ p: 1.5, boxShadow: "none", bgcolor: "#fff" }}>
                              <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} spacing={.75}>
                                <Typography variant="body2" fontWeight={700}>Attempt {attempt.attemptNumber}</Typography>
                                <Stack direction="row" spacing={1} alignItems="center"><StatusChip status={attempt.status} />{attempt.durationSeconds != null && <Typography variant="caption" color="text.secondary">{attempt.durationSeconds}s</Typography>}</Stack>
                              </Stack>
                              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: .5 }}>
                                {attempt.scheduledAt ? dateTimeLabel(attempt.scheduledAt) : "Call time unavailable"}
                                {attempt.answeredAt ? ` · answered ${dateTimeLabel(attempt.answeredAt)}` : ""}
                                {attempt.endedAt ? ` · ended ${dateTimeLabel(attempt.endedAt)}` : ""}
                              </Typography>
                              <Box sx={{ mt: 1.25, pt: 1.25, borderTop: "1px solid", borderColor: "divider" }}>
                                <Typography variant="caption" color="text.secondary" fontWeight={700}>TRANSCRIPT{transcript?.language ? ` · ${transcript.language.toUpperCase()}` : ""}</Typography>
                                {transcript?.text ? <Typography variant="body2" sx={{ mt: .5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{transcript.text}</Typography> : <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: .5 }}>Transcript not available yet.</Typography>}
                              </Box>
                              <Box sx={{ mt: 1.25 }}>
                                {attempt.recordingAvailable ? <CallRecording sessionId={record.sessionId} attemptId={attempt.id} /> : <Typography variant="caption" color="text.secondary">Recording not available yet.</Typography>}
                              </Box>
                            </Card>;
                          })}
                        </Stack>}
                      </Box>;
                    })}
                  </Stack>}
                </Box>;
              })}
            </Card>

            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1.5 }}>Record information</Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
                <Detail label="Schedule record ID" value={selectedSchedule.id} />
                <Detail label="Athulya schedule ID" value={selectedSchedule.athulyaScheduleId} />
                <Detail label="Athulya schedule PK" value={selectedSchedule.athulyaSchedulePk} />
                <Detail label="Last synced" value={dateTimeLabel(selectedSchedule.lastSyncedAt)} />
              </Box>
            </Card>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.75 }}><Button onClick={() => setSelectedSchedule(null)} variant="contained">Close</Button></DialogActions>
      </>}
    </Dialog>
  </Stack>;
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return <Stack spacing={0.35} sx={{ minWidth: 0 }}><Typography variant="caption" color="text.secondary" fontWeight={600}>{label}</Typography><Typography variant="body2" fontWeight={600} sx={{ overflowWrap: "anywhere" }}>{value || "—"}</Typography></Stack>;
}
