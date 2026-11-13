import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Chip, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography } from "@mui/material";
import EventNoteRoundedIcon from "@mui/icons-material/EventNoteRounded";
import PhoneInTalkRoundedIcon from "@mui/icons-material/PhoneInTalkRounded";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import { fetchAttendance, fetchAthulyaSchedules, type AttendanceRecord, type AthulyaSchedule } from "../api/client";
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
  const clockHour = hour % 12 || 12;
  return `${clockHour}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "pm" : "am"}`;
}

function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00+05:30`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: ZONE }).format(date);
}

function matchAttendance(schedule: AthulyaSchedule, records: AttendanceRecord[]) {
  const ids = new Set([schedule.athulyaScheduleId, schedule.athulyaSchedulePk].filter(Boolean));
  return records.find((item) => ids.has(item.assignmentId));
}

function stageStatus(schedule: AthulyaSchedule, record: AttendanceRecord | undefined, stage: "checkIn" | "checkOut") {
  const sourceStatus = String(schedule.status || "").toLowerCase().replaceAll(/[_-]/g, " ");
  if (["cancelled", "canceled"].includes(sourceStatus)) return "cancelled";
  if (!record) return "not queued";
  const status = String(record[stage]?.status || "scheduled").toLowerCase().replaceAll(/[_-]/g, " ");
  if (["confirmed", "completed", "calling", "in progress", "processing", "not answered", "missed", "delayed", "exception", "follow up", "retrying", "review"].includes(status)) return status;
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  return "scheduled";
}

function stageTime(schedule: AthulyaSchedule, record: AttendanceRecord | undefined, stage: "checkIn" | "checkOut") {
  const reportedAt = record?.[stage]?.reportedAt;
  if (reportedAt) return timeLabel(reportedAt);
  return timeLabel(stage === "checkIn" ? schedule.startTime : schedule.endTime);
}

type Row = {
  key: string;
  schedule: AthulyaSchedule;
  stage: "Check-in" | "Check-out";
  status: string;
  time: string;
  caregiver: string;
};

export function ScheduledCallsPage() {
  const [selectedDate, setSelectedDate] = useState(todayInIndia);
  const [statusFilter, setStatusFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const schedulesQuery = useQuery({
    queryKey: ["admin-scheduled-calls", "schedules", selectedDate],
    queryFn: () => fetchAthulyaSchedules({ fromDate: selectedDate, toDate: selectedDate }),
    refetchInterval: 30_000,
  });
  const attendanceQuery = useQuery({
    queryKey: ["admin-scheduled-calls", "attendance"],
    queryFn: () => fetchAttendance({ limit: 500 }),
    refetchInterval: 15_000,
  });

  const schedules = schedulesQuery.data || [];
  const attendance = attendanceQuery.data || [];
  const rows = useMemo<Row[]>(() => schedules.flatMap((schedule) => {
    const record = matchAttendance(schedule, attendance);
    const caregiver = schedule.caregivers.map((person) => person.name || person.phone).filter(Boolean).join(", ") || "—";
    return ([
      { key: `${schedule.id}:check-in`, schedule, stage: "Check-in" as const, status: stageStatus(schedule, record, "checkIn"), time: stageTime(schedule, record, "checkIn"), caregiver },
      { key: `${schedule.id}:check-out`, schedule, stage: "Check-out" as const, status: stageStatus(schedule, record, "checkOut"), time: stageTime(schedule, record, "checkOut"), caregiver },
    ]);
  }), [schedules, attendance]);
  const filtered = rows.filter((row) =>
    (stageFilter === "all" || row.stage.toLowerCase().replace("-", "_") === stageFilter)
    && (statusFilter === "all" || row.status === statusFilter));
  const attentionCount = rows.filter((row) => ["not answered", "missed", "delayed", "exception", "not queued"].includes(row.status)).length;
  const activeCount = rows.filter((row) => ["calling", "in progress", "processing", "retrying", "follow up"].includes(row.status)).length;
  const dateText = dateLabel(selectedDate);

  return <Stack spacing={2.5}>
    <PageHeader title="Scheduled calls" actions={<Chip icon={<EventNoteRoundedIcon />} label={dateText} variant="outlined" />} />
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 4 }}><MetricCard label="Athulya schedules" value={schedulesQuery.isLoading ? "—" : schedules.length.toLocaleString()} detail="Imported for this date" icon={<EventNoteRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 4 }}><MetricCard label="Calls in progress" value={attendanceQuery.isLoading ? "—" : activeCount.toLocaleString()} detail="Check-in and check-out stages" icon={<PhoneInTalkRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 4 }}><MetricCard label="Needs attention" value={schedulesQuery.isLoading || attendanceQuery.isLoading ? "—" : attentionCount.toLocaleString()} detail="Missed, delayed, or not queued" icon={<ReportProblemOutlinedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
    </Grid>
    <Card>
      {(schedulesQuery.isLoading || attendanceQuery.isFetching) && <LinearProgress />}
      {schedulesQuery.isError && <Alert severity="error" sx={{ m: 2 }}>Could not load Athulya schedules. Check the Athulya sync status in Settings.</Alert>}
      {attendanceQuery.isError && <Alert severity="warning" sx={{ m: 2 }}>Call statuses could not be refreshed. Scheduled Athulya duties are still listed.</Alert>}
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} alignItems={{ xs: "stretch", md: "center" }} sx={{ p: 2, borderBottom: "1px solid #e8edf3" }}>
        <TextField type="date" size="small" label="Schedule date" value={selectedDate} onChange={(event) => { setSelectedDate(event.target.value || todayInIndia()); setPage(0); }} InputLabelProps={{ shrink: true }} sx={{ minWidth: { md: 210 } }} />
        <FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="scheduled-stage-label">Call stage</InputLabel><Select labelId="scheduled-stage-label" value={stageFilter} label="Call stage" onChange={(event) => { setStageFilter(event.target.value); setPage(0); }}><MenuItem value="all">All stages</MenuItem><MenuItem value="check_in">Check-in</MenuItem><MenuItem value="check_out">Check-out</MenuItem></Select></FormControl>
        <FormControl size="small" sx={{ minWidth: 190 }}><InputLabel id="scheduled-status-label">Call status</InputLabel><Select labelId="scheduled-status-label" value={statusFilter} label="Call status" onChange={(event) => { setStatusFilter(event.target.value); setPage(0); }}><MenuItem value="all">All statuses</MenuItem>{["scheduled", "not queued", "calling", "in progress", "processing", "retrying", "confirmed", "not answered", "delayed", "cancelled"].map((status) => <MenuItem key={status} value={status} sx={{ textTransform: "capitalize" }}>{status}</MenuItem>)}</Select></FormControl>
        <Chip label={`${filtered.length} call items`} variant="outlined" sx={{ alignSelf: { xs: "flex-start", md: "center" } }} />
      </Stack>
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 980 }} aria-label="Athulya scheduled calls">
          <TableHead><TableRow>{["Schedule ID", "Patient", "Caregiver(s)", "Service", "Call stage", "Scheduled / reported time", "Status"].map((label) => <TableCell key={label} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {filtered.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage).map((row) => <TableRow key={row.key} hover>
              <TableCell><Typography variant="body2" fontWeight={650}>{row.schedule.athulyaScheduleId || row.schedule.athulyaSchedulePk}</Typography></TableCell>
              <TableCell><Typography variant="body2" fontWeight={650}>{row.schedule.patient.name || "—"}</Typography><Typography variant="caption" color="text.secondary">{row.schedule.patient.uhid || row.schedule.patient.id || ""}</Typography></TableCell>
              <TableCell>{row.caregiver}</TableCell>
              <TableCell>{row.schedule.service || "—"}</TableCell>
              <TableCell>{row.stage}</TableCell>
              <TableCell><Typography variant="body2">{row.time}</Typography>{row.schedule.date && <Typography variant="caption" color="text.secondary">{dateLabel(row.schedule.date)}</Typography>}</TableCell>
              <TableCell><StatusChip status={row.status} /></TableCell>
            </TableRow>)}
            {schedulesQuery.isSuccess && schedules.length === 0 && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5 }}>No Athulya schedules were imported for {dateText}. Run a manual sync for this date in Settings.</TableCell></TableRow>}
            {schedulesQuery.isSuccess && schedules.length > 0 && filtered.length === 0 && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5 }}>No call items match these filters.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination component="div" count={filtered.length} page={page} onPageChange={(_, next) => setPage(next)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Call items per page" />
    </Card>
    <Alert severity="info">This view follows Athulya’s imported duty schedule. Each schedule appears as separate check-in and check-out call items; call status refreshes automatically.</Alert>
  </Stack>;
}
