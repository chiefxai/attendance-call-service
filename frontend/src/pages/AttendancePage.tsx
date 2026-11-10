import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import AssessmentRoundedIcon from "@mui/icons-material/AssessmentRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import CrisisAlertRoundedIcon from "@mui/icons-material/CrisisAlertRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import { fetchAttendance, fetchOperationsSummary, type AttendanceRecord } from "../api/client";
import { MetricCard, PageHeader, SearchFilterBar, StatusChip } from "../components/OperationsUI";

const dateTime = (value: string | null) => value ? new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—";
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
  const link = document.createElement("a"); link.href = url; link.download = "attendance.csv"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function AttendancePage({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [language, setLanguage] = useState("all");
  const query = useQuery({ queryKey: ["attendance", "list"], queryFn: () => fetchAttendance({ limit: 500 }), refetchInterval: 15_000 });
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary });
  const records = query.data || [];
  const filtered = records.filter((row) => (!search || `${row.assignmentId} ${row.employee.name} ${row.patient.name} ${row.employee.id || ""}`.toLowerCase().includes(search.toLowerCase()))
    && (status === "all" || attendanceStatus(row) === status)
    && (language === "all" || row.language.toLowerCase() === language));
  const activeFilters = Number(status !== "all") + Number(language !== "all");

  return <Stack spacing={2.5}>
    {!embedded && <PageHeader eyebrow="SHIFT VERIFICATION / LIVE ATTENDANCE DATA" title="Attendance management" description="Track saved employee check-in and check-out sessions across home-care assignments." actions={<><Button variant="outlined" startIcon={<FileDownloadRoundedIcon />} disabled={!records.length} onClick={() => exportCsv(filtered)}>Export CSV</Button><Button component={RouterLink} to="/assignments/new" variant="contained" startIcon={<AddRoundedIcon />}>New assignment</Button></>} />}
    {embedded && <Stack direction="row" justifyContent="flex-end"><Button variant="outlined" startIcon={<FileDownloadRoundedIcon />} disabled={!records.length} onClick={() => exportCsv(filtered)}>Export CSV</Button></Stack>}
    {(query.isError || summary.isError) && <Alert severity="error">Attendance data could not be loaded. Check backend availability and workspace access.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Total scheduled" value={summary.data?.scheduledToday.toLocaleString() ?? "—"} detail="Today's assignments" icon={<GroupRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Verified check-ins" value={summary.data?.checkInsConfirmed.toLocaleString() ?? "—"} detail="Confirmed arrival times" icon={<AssessmentRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Pending verification" value={summary.data?.checkInsPending.toLocaleString() ?? "—"} detail="Scheduled, calling, processing, or follow-up" icon={<PendingActionsRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Needs attention" value={summary.data?.exceptions.toLocaleString() ?? "—"} detail="No-answer or review flags" icon={<CrisisAlertRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
    </Grid>
    <Card>
      <SearchFilterBar
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search staff, patient, or assignment"
        activeFilters={activeFilters}
        resultCount={filtered.length}
        resultLabel="records"
        onClearFilters={() => { setStatus("all"); setLanguage("all"); }}
        filters={<>
          <FormControl size="small" fullWidth><InputLabel>Verification status</InputLabel><Select label="Verification status" value={status} onChange={(event) => setStatus(event.target.value)}><MenuItem value="all">All statuses</MenuItem>{(["pending", "checkin", "checkout", "processing", "delayed"] as const).map((value) => <MenuItem key={value} value={value}>{value === "checkin" ? "Check-in" : value === "checkout" ? "Check-out" : value[0].toUpperCase() + value.slice(1)}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Language</InputLabel><Select label="Language" value={language} onChange={(event) => setLanguage(event.target.value)}><MenuItem value="all">All languages</MenuItem>{["ta", "en", "ml", "te"].map((value) => <MenuItem key={value} value={value}>{value.toUpperCase()}</MenuItem>)}</Select></FormControl>
        </>}
      />
      {query.isLoading && <LinearProgress />}
      <TableContainer sx={{ maxHeight: 560 }}><Table stickyHeader size="small" aria-label="Attendance records">
        <TableHead><TableRow>{["Assignment / staff", "Client", "Scheduled shift", "Check-in time", "Check-out time", "Language", "Attendance status", "Details"].map((label) => <TableCell key={label} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead>
        <TableBody>{filtered.map((row) => <TableRow key={row.sessionId} hover>
          <TableCell><Typography variant="body2" fontWeight={700}>{row.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{row.employee.name} · {row.employee.id || "staff ID unavailable"}</Typography></TableCell>
          <TableCell><Typography variant="body2" fontWeight={650}>{row.patient.name}</Typography><Typography variant="caption" color="text.secondary">{row.patient.id || "patient ID unavailable"}</Typography></TableCell>
          <TableCell sx={{ whiteSpace: "nowrap" }}>{dateTime(row.scheduledStartAt)}<Typography variant="caption" display="block" color="text.secondary">to {dateTime(row.scheduledEndAt)}</Typography></TableCell>
          <TableCell sx={{ whiteSpace: "nowrap" }}><StatusChip status={row.checkIn.status} /><Typography variant="caption" display="block" color="text.secondary">{dateTime(row.checkIn.reportedAt)}</Typography></TableCell>
          <TableCell sx={{ whiteSpace: "nowrap" }}><StatusChip status={row.checkOut.status} /><Typography variant="caption" display="block" color="text.secondary">{dateTime(row.checkOut.reportedAt)}</Typography></TableCell>
          <TableCell>{row.language.toUpperCase()}</TableCell><TableCell><AttendanceStatusChip status={attendanceStatus(row)} />{attendanceStatus(row) === "delayed" && <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: .5, maxWidth: 220 }}>{delayDetail(row)}</Typography>}</TableCell><TableCell><Button size="small" onClick={() => navigate(`/sessions/${row.sessionId}`)}>View</Button></TableCell>
        </TableRow>)}</TableBody>
      </Table></TableContainer>
      {query.isSuccess && filtered.length === 0 && <Typography color="text.secondary" align="center" sx={{ py: 5 }}>No attendance sessions match these filters.</Typography>}
    </Card>
  </Stack>;
}
