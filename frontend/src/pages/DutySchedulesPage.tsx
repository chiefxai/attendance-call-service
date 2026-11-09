import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import AddCircleOutlineRoundedIcon from "@mui/icons-material/AddCircleOutlineRounded";
import CalendarMonthRoundedIcon from "@mui/icons-material/CalendarMonthRounded";
import CallMadeRoundedIcon from "@mui/icons-material/CallMadeRounded";
import ShareLocationRoundedIcon from "@mui/icons-material/ShareLocationRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import { fetchAttendance, fetchOperationsSummary } from "../api/client";
import { MetricCard, PageHeader, StatusChip } from "../components/OperationsUI";

const dateTime = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export function DutySchedulesPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [shift, setShift] = useState("all");
  const sessions = useQuery({ queryKey: ["attendance", "schedule-list"], queryFn: () => fetchAttendance({ limit: 500 }), refetchInterval: 15_000 });
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary });
  const records = sessions.data || [];
  const filtered = records.filter((row) => (!search || `${row.assignmentId} ${row.employee.name} ${row.patient.name}`.toLowerCase().includes(search.toLowerCase()))
    && (shift === "all" || (shift === "day" ? new Date(row.scheduledStartAt).getHours() >= 6 && new Date(row.scheduledStartAt).getHours() < 18 : new Date(row.scheduledStartAt).getHours() < 6 || new Date(row.scheduledStartAt).getHours() >= 18)));
  const nextCalls = [...records].sort((a, b) => new Date(a.scheduledStartAt).getTime() - new Date(b.scheduledStartAt).getTime()).slice(0, 4);

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="ASSIGNMENT DISPATCH / CALL SCHEDULES" title="Duty schedules" description="Assignments and scheduled outbound attendance calls received by the service." actions={<><Button variant="outlined" disabled>Bulk upload</Button><Button variant="outlined" disabled>Sync from host system</Button><Button component={RouterLink} to="/assignments/new" variant="contained" startIcon={<AddCircleOutlineRoundedIcon />}>Create assignment</Button></>} />
    {(sessions.isError || summary.isError) && <Alert severity="error">Could not load schedules from the backend.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Scheduled today" value={summary.data?.scheduledToday.toLocaleString() ?? "—"} detail="Assignments in today's shift window" icon={<CalendarMonthRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Check-in confirmed" value={summary.data?.checkInsConfirmed.toLocaleString() ?? "—"} detail="Reported employee arrivals" icon={<CallMadeRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Location verification" value="Not connected" detail="GPS integration is not enabled" icon={<ShareLocationRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Attendance exceptions" value={summary.data?.exceptions.toLocaleString() ?? "—"} detail="Not answered or review required" icon={<WarningAmberRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
    </Grid>
    <Card sx={{ p: { xs: 2, sm: 2.75 } }}>
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={1.5} sx={{ mb: 2 }}><Box><Typography variant="h6">Scheduled call timeline</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4 }}>Next scheduled check-in calls from current assignments.</Typography></Box><Chip label="Times shown in your local timezone" variant="outlined" /></Stack>
      {sessions.isLoading && <LinearProgress />}
      {nextCalls.length ? <Grid container spacing={1.5}>{nextCalls.map((row) => <Grid key={row.sessionId} size={{ xs: 12, sm: 6, lg: 3 }}><Card variant="outlined" sx={{ p: 1.75, boxShadow: "none", borderColor: "#e6ebf2", cursor: "pointer" }} onClick={() => navigate(`/sessions/${row.sessionId}`)}><Stack direction="row" justifyContent="space-between"><Typography fontWeight={750}>{dateTime(row.scheduledStartAt)}</Typography><StatusChip status={row.checkIn.status} /></Stack><Typography variant="body2" sx={{ mt: 1.3, fontWeight: 650 }}>{row.employee.name}</Typography><Typography variant="caption" color="text.secondary">{row.patient.name} · {row.assignmentId}</Typography></Card></Grid>)}</Grid> : <Alert severity="info">No scheduled assignments are available yet.</Alert>}
    </Card>
    <Card>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} sx={{ p: 2, borderBottom: "1px solid #e8edf3" }}><TextField size="small" label="Filter staff, patient, or assignment" value={search} onChange={(event) => setSearch(event.target.value)} sx={{ flex: 1 }} /><FormControl size="small" sx={{ minWidth: 160 }}><InputLabel>Shift</InputLabel><Select value={shift} label="Shift" onChange={(event) => setShift(event.target.value)}><MenuItem value="all">All shifts</MenuItem><MenuItem value="day">Day shift</MenuItem><MenuItem value="night">Night shift</MenuItem></Select></FormControl><Chip label={`${filtered.length} assignments`} variant="outlined" sx={{ alignSelf: { xs: "flex-start", sm: "center" } }} /></Stack>
      {sessions.isLoading && <LinearProgress />}
      <TableContainer><Table size="small" aria-label="Duty schedule assignments"><TableHead><TableRow>{["Assignment / staff", "Patient", "Scheduled duty", "Check-in", "Check-out", "Language", "Session", "Actions"].map((item) => <TableCell key={item} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{item}</TableCell>)}</TableRow></TableHead><TableBody>{filtered.map((row) => <TableRow key={row.sessionId} hover><TableCell><Typography variant="body2" fontWeight={700}>{row.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{row.employee.name} · {row.employee.id || "ID unavailable"}</Typography></TableCell><TableCell>{row.patient.name}</TableCell><TableCell>{dateTime(row.scheduledStartAt)}<Typography variant="caption" color="text.secondary" display="block">to {dateTime(row.scheduledEndAt)}</Typography></TableCell><TableCell><StatusChip status={row.checkIn.status} /></TableCell><TableCell><StatusChip status={row.checkOut.status} /></TableCell><TableCell>{row.language.toUpperCase()}</TableCell><TableCell><StatusChip status={row.sessionStatus} /></TableCell><TableCell><Button size="small" onClick={() => navigate(`/sessions/${row.sessionId}`)}>Details</Button></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {sessions.isSuccess && filtered.length === 0 && <Typography align="center" color="text.secondary" sx={{ py: 4 }}>No assignments match these filters.</Typography>}
    </Card>
  </Stack>;
}
