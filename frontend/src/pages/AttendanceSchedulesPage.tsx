import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import AssessmentRoundedIcon from "@mui/icons-material/AssessmentRounded";
import CrisisAlertRoundedIcon from "@mui/icons-material/CrisisAlertRounded";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import { fetchAttendance, fetchOperationsSummary, type AttendanceRecord } from "../api/client";
import { MetricCard, PageHeader, SearchFilterBar, StatusChip } from "../components/OperationsUI";

const dateTime = (value: string | null) => value
  ? new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })
  : "—";
type AttendanceStatus = "pending" | "checkin" | "checkout" | "processing" | "delayed";

function attendanceStatus(row: AttendanceRecord): AttendanceStatus {
  const statuses = [row.checkIn.status, row.checkOut.status];
  if (statuses.some((value) => value === "calling" || value === "processing")) return "processing";
  if (statuses.some((value) => ["follow_up", "not_answered", "missed", "review"].includes(value))) return "delayed";
  if (row.checkIn.status === "confirmed" && row.checkOut.status === "confirmed") return "checkout";
  if (row.checkIn.status === "confirmed") return "checkin";
  return "pending";
}

function delayDetail(row: AttendanceRecord) {
  const delayed = ([{ label: "Check-in", data: row.checkIn, reason: row.stageReasons.checkIn }, { label: "Check-out", data: row.checkOut, reason: row.stageReasons.checkOut }] as const)
    .find(({ data }) => ["follow_up", "not_answered", "missed", "review"].includes(data.status));
  if (!delayed) return "";
  const reasonLabels: Record<string, string> = {
    not_answered: "No answer", consecutive_no_answer_limit_reached: "Retry limit reached",
    employee_requested_callback: "Staff requested a callback", check_in_not_confirmed: "Arrival not confirmed",
    check_out_not_confirmed: "Departure not confirmed", callback_time_unclear: "Callback time unclear",
  };
  const reason = delayed.reason ? reasonLabels[delayed.reason] || delayed.reason.replaceAll("_", " ") : delayed.data.status.replaceAll("_", " ");
  const callAt = delayed.data.nextCallAt ? new Date(delayed.data.nextCallAt) : null;
  const nextCall = callAt
    ? callAt.getTime() <= Date.now()
      ? ` · Retry overdue since ${dateTime(callAt.toISOString())}; being rescheduled`
      : ` · Next call ${dateTime(callAt.toISOString())}`
    : "";
  return `${delayed.label} · ${reason}${nextCall}`;
}

function AttendanceStatusChip({ status }: { status: AttendanceStatus }) {
  const label = { pending: "Pending", checkin: "Check-in", checkout: "Check-out", processing: "Processing", delayed: "Delayed" }[status];
  const color = status === "checkout" || status === "checkin" ? "success" : status === "delayed" ? "error" : "warning";
  return <Chip size="small" color={color} label={label} sx={{ fontWeight: 650 }} />;
}

function exportCsv(data: AttendanceRecord[]) {
  const header = ["Session ID", "Assignment", "Staff", "Staff ID", "Patient", "Patient ID", "Scheduled start", "Scheduled end", "Attendance status", "Check-in status", "Check-in time", "Check-out status", "Check-out time"];
  const csv = [header, ...data.map((row) => [row.sessionId, row.assignmentId, row.employee.name, row.employee.id || "", row.patient.name, row.patient.id || "", row.scheduledStartAt, row.scheduledEndAt, attendanceStatus(row), row.checkIn.status, row.checkIn.reportedAt || "", row.checkOut.status, row.checkOut.reportedAt || ""])]
    .map((values) => values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "attendance.csv";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function AttendanceSchedulesPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [language, setLanguage] = useState("all");
  const [shift, setShift] = useState("all");
  const query = useQuery({ queryKey: ["attendance", "list"], queryFn: () => fetchAttendance({ limit: 500 }), refetchInterval: 15_000 });
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary });
  const records = query.data || [];
  const filtered = records.filter((row) =>
    (!search || `${row.assignmentId} ${row.employee.name} ${row.patient.name} ${row.employee.id || ""}`.toLowerCase().includes(search.toLowerCase()))
    && (status === "all" || attendanceStatus(row) === status)
    && (language === "all" || row.language.toLowerCase() === language)
    && (shift === "all" || (shift === "day"
      ? new Date(row.scheduledStartAt).getHours() >= 6 && new Date(row.scheduledStartAt).getHours() < 18
      : new Date(row.scheduledStartAt).getHours() < 6 || new Date(row.scheduledStartAt).getHours() >= 18)),
  );
  const activeFilters = Number(status !== "all") + Number(language !== "all") + Number(shift !== "all");
  const nextCalls = [...records]
    .sort((a, b) => new Date(a.scheduledStartAt).getTime() - new Date(b.scheduledStartAt).getTime())
    .slice(0, 4);

  return <Stack spacing={2.5}>
    <PageHeader
      eyebrow="SHIFT OPERATIONS"
      title="Attendance & schedules"
      description="Manage duty assignments, scheduled calls, and actual employee check-in and check-out times in one place."
      actions={<><Button variant="outlined" startIcon={<FileDownloadRoundedIcon />} disabled={!records.length} onClick={() => exportCsv(filtered)}>Export CSV</Button><Button component={RouterLink} to="/assignments/new" variant="contained" startIcon={<AddRoundedIcon />}>New assignment</Button></>}
    />
    {(query.isError || summary.isError) && <Alert severity="error">Attendance and schedule data could not be loaded. Check backend availability and workspace access.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Total scheduled" value={summary.data?.scheduledToday.toLocaleString() ?? "—"} detail="Today's assignments" icon={<GroupRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Verified check-ins" value={summary.data?.checkInsConfirmed.toLocaleString() ?? "—"} detail="Confirmed arrival times" icon={<AssessmentRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Pending verification" value={summary.data?.checkInsPending.toLocaleString() ?? "—"} detail="Scheduled, calling, processing, or follow-up" icon={<PendingActionsRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Needs attention" value={summary.data?.exceptions.toLocaleString() ?? "—"} detail="No-answer or review flags" icon={<CrisisAlertRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
    </Grid>

    <Card sx={{ p: { xs: 2, sm: 2.75 } }}>
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={1.5} sx={{ mb: 2 }}>
        <Box><Typography variant="h6">Scheduled call timeline</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4 }}>Next scheduled check-in calls from current assignments.</Typography></Box>
        <Chip label="Times shown in your local timezone" variant="outlined" />
      </Stack>
      {query.isLoading && <LinearProgress />}
      {nextCalls.length
        ? <Grid container spacing={1.5}>{nextCalls.map((row) => <Grid key={row.sessionId} size={{ xs: 12, sm: 6, lg: 3 }}>
          <Card variant="outlined" sx={{ p: 1.75, boxShadow: "none", borderColor: "#e6ebf2", cursor: "pointer" }} onClick={() => navigate(`/sessions/${row.sessionId}`)}>
            <Stack direction="row" justifyContent="space-between"><Typography fontWeight={750}>{dateTime(row.scheduledStartAt)}</Typography><StatusChip status={row.checkIn.status} /></Stack>
            <Typography variant="body2" sx={{ mt: 1.3, fontWeight: 650 }}>{row.employee.name}</Typography>
            <Typography variant="caption" color="text.secondary">{row.patient.name} · {row.assignmentId}</Typography>
          </Card>
        </Grid>)}</Grid>
        : <Alert severity="info">No scheduled assignments are available yet.</Alert>}
    </Card>

    <Card>
      <SearchFilterBar
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search staff, patient, or assignment"
        activeFilters={activeFilters}
        resultCount={filtered.length}
        resultLabel="records"
        onClearFilters={() => { setStatus("all"); setLanguage("all"); setShift("all"); }}
        filters={<>
          <FormControl size="small" fullWidth><InputLabel>Attendance status</InputLabel><Select label="Attendance status" value={status} onChange={(event) => setStatus(event.target.value)}><MenuItem value="all">All statuses</MenuItem>{(["pending", "checkin", "checkout", "processing", "delayed"] as const).map((value) => <MenuItem key={value} value={value}>{value === "checkin" ? "Check-in" : value === "checkout" ? "Check-out" : value[0].toUpperCase() + value.slice(1)}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Shift</InputLabel><Select label="Shift" value={shift} onChange={(event) => setShift(event.target.value)}><MenuItem value="all">All shifts</MenuItem><MenuItem value="day">Day shift</MenuItem><MenuItem value="night">Night shift</MenuItem></Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Language</InputLabel><Select label="Language" value={language} onChange={(event) => setLanguage(event.target.value)}><MenuItem value="all">All languages</MenuItem>{["ta", "en", "ml", "te"].map((value) => <MenuItem key={value} value={value}>{value.toUpperCase()}</MenuItem>)}</Select></FormControl>
        </>}
      />
      {query.isLoading && <LinearProgress />}
      <TableContainer sx={{ maxHeight: 560 }}><Table stickyHeader size="small" aria-label="Attendance and duty schedule records">
        <TableHead><TableRow>{["Assignment / staff", "Patient", "Scheduled duty", "Check-in time", "Check-out time", "Language", "Attendance status", "Details"].map((label) => <TableCell key={label} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead>
        <TableBody>{filtered.map((row) => <TableRow key={row.sessionId} hover>
          <TableCell><Typography variant="body2" fontWeight={700}>{row.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{row.employee.name} · {row.employee.id || "staff ID unavailable"}</Typography></TableCell>
          <TableCell><Typography variant="body2" fontWeight={650}>{row.patient.name}</Typography><Typography variant="caption" color="text.secondary">{row.patient.id || "patient ID unavailable"}</Typography></TableCell>
          <TableCell sx={{ whiteSpace: "nowrap" }}>{dateTime(row.scheduledStartAt)}<Typography variant="caption" display="block" color="text.secondary">to {dateTime(row.scheduledEndAt)}</Typography></TableCell>
          <TableCell sx={{ whiteSpace: "nowrap" }}><Typography variant="body2">{dateTime(row.checkIn.reportedAt)}</Typography></TableCell>
          <TableCell sx={{ whiteSpace: "nowrap" }}><Typography variant="body2">{dateTime(row.checkOut.reportedAt)}</Typography></TableCell>
          <TableCell>{row.language.toUpperCase()}</TableCell>
          <TableCell><AttendanceStatusChip status={attendanceStatus(row)} />{attendanceStatus(row) === "delayed" && <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: .5, maxWidth: 220 }}>{delayDetail(row)}</Typography>}</TableCell>
          <TableCell><Button size="small" onClick={() => navigate(`/sessions/${row.sessionId}`)}>View</Button></TableCell>
        </TableRow>)}</TableBody>
      </Table></TableContainer>
      {query.isSuccess && filtered.length === 0 && <Typography color="text.secondary" align="center" sx={{ py: 5 }}>No attendance or schedule records match these filters.</Typography>}
    </Card>
  </Stack>;
}
