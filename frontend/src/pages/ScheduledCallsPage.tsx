import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography } from "@mui/material";
import EventNoteRoundedIcon from "@mui/icons-material/EventNoteRounded";
import PhoneInTalkRoundedIcon from "@mui/icons-material/PhoneInTalkRounded";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import { fetchAthulyaSchedules, fetchScheduledAthulyaCalls, fetchSessionArtifacts, type AthulyaSchedule, type ScheduledAthulyaCallItem } from "../api/client";
import { CallRecording } from "../components/CallRecording";
import { MetricCard, PageHeader, StatusChip } from "../components/OperationsUI";

const ZONE = "Asia/Kolkata";

function todayInIndia() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function timeLabel(value: string | null | undefined) {
  if (!value) return "—";
  if (/[T ]/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: ZONE }).format(date);
  }
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return value;
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "pm" : "am"}`;
}

function fullDateTime(value: string | null | undefined) {
  if (!value) return "No queued run";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: ZONE }).format(date);
}

function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00+05:30`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: ZONE }).format(date);
}

function queueStatus(item: ScheduledAthulyaCallItem | undefined, schedule: AthulyaSchedule) {
  if (["cancelled", "canceled"].includes(String(schedule.status || "").toLowerCase())) return "cancelled";
  if (item?.queueJobStatus === "queued") return "queued";
  if (item?.queueJobStatus === "running") return "processing";
  if (item?.activeCallStatus) return "calling";
  const task = String(item?.taskStatus || "").toLowerCase().replaceAll(/[_-]/g, " ");
  if (["confirmed", "completed"].includes(task)) return "completed";
  if (["cancelled", "canceled"].includes(task)) return "cancelled";
  const latest = String(item?.latestAttemptStatus || "").toLowerCase().replaceAll(/[_-]/g, " ");
  if (["no answer", "not answered", "failed", "missed"].includes(latest) && !item?.queueJobStatus) return "needs attention";
  return "not queued";
}

type Row = {
  key: string;
  schedule: AthulyaSchedule;
  caregiverName: string;
  stage: "Check-in" | "Check-out";
  stageKey: "check_in" | "check_out";
  dutyTime: string;
  queueStatus: string;
  callTime: string;
  attemptNumber: number | null;
  systemItem: ScheduledAthulyaCallItem | undefined;
};

export function ScheduledCallsPage() {
  const [selectedDate, setSelectedDate] = useState(todayInIndia);
  const [statusFilter, setStatusFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selectedRow, setSelectedRow] = useState<Row | null>(null);
  const schedulesQuery = useQuery({
    queryKey: ["admin-scheduled-calls", "athulya", selectedDate],
    queryFn: () => fetchAthulyaSchedules({ fromDate: selectedDate, toDate: selectedDate }),
    refetchInterval: 30_000,
  });
  const systemCallsQuery = useQuery({
    queryKey: ["admin-scheduled-calls", "system-queue", selectedDate],
    queryFn: () => fetchScheduledAthulyaCalls(selectedDate),
    refetchInterval: 10_000,
  });

  const selectedSessionId = selectedRow?.systemItem?.sessionId || "";
  const artifactsQuery = useQuery({
    queryKey: ["session-artifacts", selectedSessionId],
    queryFn: () => fetchSessionArtifacts(selectedSessionId),
    enabled: Boolean(selectedSessionId),
    retry: false,
    refetchInterval: selectedRow ? 10_000 : false,
  });
  const schedules = schedulesQuery.data || [];
  const systemCalls = systemCallsQuery.data?.items || [];
  const rows = useMemo<Row[]>(() => schedules.flatMap((schedule) => {
    const caregivers = schedule.caregivers.length
      ? schedule.caregivers
      : [{ id: "", name: "No caregiver assigned", phone: "", status: "" }];
    return caregivers.flatMap((caregiver) => ([
      { stage: "Check-in" as const, stageKey: "check_in" as const, dutyTime: timeLabel(schedule.startTime) },
      { stage: "Check-out" as const, stageKey: "check_out" as const, dutyTime: timeLabel(schedule.endTime) },
    ].map(({ stage, stageKey, dutyTime }) => {
      const item = systemCalls.find((call) =>
        call.assignmentId === schedule.athulyaScheduleId
        && (!schedule.athulyaSchedulePk || call.schedulePk === schedule.athulyaSchedulePk)
        && call.caregiverId === caregiver.id
        && call.stage === stageKey);
      const actualQueueStatus = queueStatus(item, schedule);
      const callTime = item?.queueRunAt
        ? fullDateTime(item.queueRunAt)
        : item?.activeStartedAt
          ? `Started ${fullDateTime(item.activeStartedAt)}`
          : item?.nextCallAt
            ? `Expected ${fullDateTime(item.nextCallAt)} · no job queued`
            : "No queued run";
      const attemptNumber = item?.queuedAttemptNumber || item?.activeAttemptNumber || item?.latestAttemptNumber || null;
      return {
        key: `${schedule.id}:${caregiver.id || "unassigned"}:${stageKey}`,
        schedule, caregiverName: caregiver.name || caregiver.phone || "—",
        stage, stageKey, dutyTime, queueStatus: actualQueueStatus, callTime, attemptNumber, systemItem: item,
      };
    })));
  }), [schedules, systemCalls]);

  const filtered = rows.filter((row) =>
    (stageFilter === "all" || row.stageKey === stageFilter)
    && (statusFilter === "all" || row.queueStatus === statusFilter));
  const queueCount = rows.filter((row) => row.queueStatus === "queued").length;
  const activeCount = rows.filter((row) => ["calling", "processing"].includes(row.queueStatus)).length;
  const attentionCount = rows.filter((row) => ["not queued", "needs attention"].includes(row.queueStatus)).length;
  const dateText = dateLabel(selectedDate);

  return <Stack spacing={2.5}>
    <PageHeader title="Scheduled calls" actions={<Chip icon={<EventNoteRoundedIcon />} label={dateText} variant="outlined" />} />
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Athulya schedules" value={schedulesQuery.isLoading ? "—" : schedules.length.toLocaleString()} detail="Imported for this date" icon={<EventNoteRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Queued in our system" value={systemCallsQuery.isLoading ? "—" : queueCount.toLocaleString()} detail="Upcoming check-in and check-out jobs" icon={<PhoneInTalkRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Calls in progress" value={systemCallsQuery.isLoading ? "—" : activeCount.toLocaleString()} detail="Being placed or currently active" icon={<PhoneInTalkRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Needs attention" value={schedulesQuery.isLoading || systemCallsQuery.isLoading ? "—" : attentionCount.toLocaleString()} detail="Expected call has no active queue job" icon={<ReportProblemOutlinedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
    </Grid>
    <Card>
      {(schedulesQuery.isLoading || systemCallsQuery.isFetching) && <LinearProgress />}
      {schedulesQuery.isError && <Alert severity="error" sx={{ m: 2 }}>Could not load Athulya schedules. Check the Athulya sync status in Settings.</Alert>}
      {systemCallsQuery.isError && <Alert severity="error" sx={{ m: 2 }}>Could not verify the system call queue. Queue status is not available.</Alert>}
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} alignItems={{ xs: "stretch", md: "center" }} sx={{ p: 2, borderBottom: "1px solid #e8edf3" }}>
        <TextField type="date" size="small" label="Schedule date" value={selectedDate} onChange={(event) => { setSelectedDate(event.target.value || todayInIndia()); setPage(0); }} InputLabelProps={{ shrink: true }} sx={{ minWidth: { md: 210 } }} />
        <FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="scheduled-stage-label">Call stage</InputLabel><Select labelId="scheduled-stage-label" value={stageFilter} label="Call stage" onChange={(event) => { setStageFilter(event.target.value); setPage(0); }}><MenuItem value="all">All stages</MenuItem><MenuItem value="check_in">Check-in</MenuItem><MenuItem value="check_out">Check-out</MenuItem></Select></FormControl>
        <FormControl size="small" sx={{ minWidth: 190 }}><InputLabel id="scheduled-status-label">System queue status</InputLabel><Select labelId="scheduled-status-label" value={statusFilter} label="System queue status" onChange={(event) => { setStatusFilter(event.target.value); setPage(0); }}><MenuItem value="all">All statuses</MenuItem>{["queued", "processing", "calling", "completed", "not queued", "needs attention", "cancelled"].map((status) => <MenuItem key={status} value={status} sx={{ textTransform: "capitalize" }}>{status}</MenuItem>)}</Select></FormControl>
        <Chip label={`${filtered.length} call items`} variant="outlined" sx={{ alignSelf: { xs: "flex-start", md: "center" } }} />
      </Stack>
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 1120 }} aria-label="Athulya schedules and system call jobs">
          <TableHead><TableRow>{["Schedule ID", "Patient", "Caregiver", "Service", "Call stage", "Duty time", "System queue", "Next system call", "Details"].map((label) => <TableCell key={label} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {filtered.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage).map((row) => <TableRow key={row.key} hover>
              <TableCell><Typography variant="body2" fontWeight={650}>{row.schedule.athulyaScheduleId || row.schedule.athulyaSchedulePk}</Typography></TableCell>
              <TableCell><Typography variant="body2" fontWeight={650}>{row.schedule.patient.name || "—"}</Typography><Typography variant="caption" color="text.secondary">{row.schedule.patient.uhid || row.schedule.patient.id || ""}</Typography></TableCell>
              <TableCell>{row.caregiverName}</TableCell>
              <TableCell>{row.schedule.service || "—"}</TableCell>
              <TableCell>{row.stage}</TableCell>
              <TableCell><Typography variant="body2">{row.dutyTime}</Typography>{row.schedule.date && <Typography variant="caption" color="text.secondary">{dateLabel(row.schedule.date)}</Typography>}</TableCell>
              <TableCell><StatusChip status={row.queueStatus} />{row.attemptNumber ? <Typography variant="caption" color="text.secondary" display="block">Attempt {row.attemptNumber}</Typography> : null}</TableCell>
              <TableCell><Typography variant="body2">{row.callTime}</Typography></TableCell>
              <TableCell><Button size="small" onClick={() => setSelectedRow(row)}>View details</Button></TableCell>
            </TableRow>)}
            {schedulesQuery.isSuccess && schedules.length === 0 && <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5 }}>No Athulya schedules were imported for {dateText}. Run a manual sync for this date in Settings.</TableCell></TableRow>}
            {schedulesQuery.isSuccess && schedules.length > 0 && filtered.length === 0 && <TableRow><TableCell colSpan={8} align="center" sx={{ py: 5 }}>No call items match these filters.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination component="div" count={filtered.length} page={page} onPageChange={(_, next) => setPage(next)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Call items per page" />
    </Card>

    <Dialog open={Boolean(selectedRow)} onClose={() => setSelectedRow(null)} fullWidth maxWidth="md">
      {selectedRow && <>
        <DialogTitle>Scheduled call details</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1 }}>Athulya duty</Typography>
              <Grid container spacing={1.5}>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Schedule ID</Typography><Typography>{selectedRow.schedule.athulyaScheduleId || selectedRow.schedule.athulyaSchedulePk}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Call stage</Typography><Typography>{selectedRow.stage}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Patient</Typography><Typography>{selectedRow.schedule.patient.name || "—"}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Caregiver</Typography><Typography>{selectedRow.caregiverName}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Service</Typography><Typography>{selectedRow.schedule.service || "—"}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Duty date and time</Typography><Typography>{selectedRow.schedule.date ? dateLabel(selectedRow.schedule.date) : "—"} · {selectedRow.dutyTime}</Typography></Grid>
              </Grid>
            </Box>
            <Divider />
            <Box>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1 }}>Our call scheduling</Typography>
              <Grid container spacing={1.5}>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Queue status</Typography><Box><StatusChip status={selectedRow.queueStatus} /></Box></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Next system call</Typography><Typography>{selectedRow.callTime}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Queue job ID</Typography><Typography sx={{ overflowWrap: "anywhere" }}>{selectedRow.systemItem?.queueJobId || "No active queue job"}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Internal session ID</Typography><Typography sx={{ overflowWrap: "anywhere" }}>{selectedRow.systemItem?.sessionId || "No internal session found"}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Task status</Typography><Typography>{selectedRow.systemItem?.taskStatus || "No task created"}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Delivery status</Typography><Typography>{selectedRow.systemItem?.deliveryStatus || "—"}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Call attempts</Typography><Typography>{selectedRow.systemItem?.attemptCount ?? 0}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Latest attempt</Typography><Typography>{selectedRow.systemItem?.latestAttemptNumber ? `#${selectedRow.systemItem.latestAttemptNumber} · ${selectedRow.systemItem.latestAttemptStatus || "status unavailable"}` : "No attempts yet"}</Typography></Grid>
                <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Current call state</Typography><Typography>{selectedRow.systemItem?.activeCallStatus || "No active call"}</Typography></Grid>
              </Grid>
            </Box>
            <Divider />
            <Box>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1 }}>Call recording and transcript · {selectedRow.stage}</Typography>
              {!selectedSessionId && <Alert severity="info">No system session exists for this caregiver and call stage yet.</Alert>}
              {selectedSessionId && artifactsQuery.isLoading && <LinearProgress />}
              {selectedSessionId && artifactsQuery.isError && <Alert severity="error">Could not load the call recording and transcript.</Alert>}
              {selectedSessionId && artifactsQuery.isSuccess && (() => {
                const attempts = artifactsQuery.data.callAttempts.filter((attempt) => attempt.stage === selectedRow.stageKey);
                if (!attempts.length) return <Alert severity="info">No call attempts have been recorded for this stage yet. This section refreshes automatically.</Alert>;
                return <Stack spacing={1.5}>
                  {attempts.map((attempt) => {
                    const transcript = artifactsQuery.data.transcripts.find((item) => item.callAttemptId === attempt.id);
                    return <Card key={attempt.id} variant="outlined" sx={{ p: 1.75, boxShadow: "none" }}>
                      <Stack spacing={1.25}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          <Typography variant="body2" fontWeight={700}>Attempt {attempt.attemptNumber}</Typography>
                          <StatusChip status={attempt.status} />
                          {attempt.durationSeconds != null && <Typography variant="caption" color="text.secondary">{attempt.durationSeconds}s</Typography>}
                          {attempt.answeredAt && <Typography variant="caption" color="text.secondary">Answered {fullDateTime(attempt.answeredAt)}</Typography>}
                        </Stack>
                        {attempt.recordingAvailable
                          ? <CallRecording sessionId={selectedSessionId} attemptId={attempt.id} />
                          : <Typography variant="body2" color="text.secondary">Recording is not available for this attempt yet.</Typography>}
                        <Box>
                          <Typography variant="caption" fontWeight={700} color="text.secondary">TRANSCRIPT</Typography>
                          {transcript?.text
                            ? <Typography variant="body2" sx={{ mt: .5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{transcript.text}</Typography>
                            : <Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>Transcript is not available yet.</Typography>}
                        </Box>
                      </Stack>
                    </Card>;
                  })}
                </Stack>;
              })()}
            </Box>

          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setSelectedRow(null)}>Close</Button></DialogActions>
      </>}
    </Dialog>
    <Alert severity="info">This view compares each Athulya duty with the actual job in our queue. “Queued” confirms our system has scheduled the call; “Next system call” shows the queue run time. The queue status refreshes every 10 seconds.</Alert>
  </Stack>;
}
