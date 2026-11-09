import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import CallEndRoundedIcon from "@mui/icons-material/CallEndRounded";
import AccessTimeRoundedIcon from "@mui/icons-material/AccessTimeRounded";
import AssignmentLateRoundedIcon from "@mui/icons-material/AssignmentLateRounded";
import { fetchSupervisionQueue, type SupervisionItem } from "../api/client";
import { MetricCard, PageHeader, StatusChip } from "../components/OperationsUI";

const typeLabel = (item: SupervisionItem) => item.status === "not_answered" || item.status === "missed" ? "No answer" : item.stage === "check_out" ? "Check-out review" : "Attendance review";

export function ExceptionsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("all");
  const queue = useQuery({ queryKey: ["supervision-queue", severity], queryFn: () => fetchSupervisionQueue({ severity, limit: 500 }), refetchInterval: 15_000 });
  const all = queue.data || [];
  const filtered = all.filter((item) => !search || `${item.assignmentId} ${item.employee.name} ${item.patient.name} ${item.reason}`.toLowerCase().includes(search.toLowerCase()));

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="ATTENDANCE REVIEW / LIVE EXCEPTION DATA" title="Exceptions & alerts" description="Review assignments with unanswered calls or details that need operations follow-up." />
    {queue.isError && <Alert severity="error">Could not load attendance exceptions from the backend.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Open exceptions" value={String(all.length)} detail="Current attendance review queue" icon={<AssignmentLateRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Not answered" value={String(all.filter((item) => item.status === "not_answered" || item.status === "missed").length)} detail="Retry limit reached" icon={<CallEndRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Needs review" value={String(all.filter((item) => item.status === "review").length)} detail="Attendance details unclear" icon={<AccessTimeRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Location review" value="Unavailable" detail="GPS integration is not connected" icon={<AccessTimeRoundedIcon />} tint="#edf1f8" accent="#69778d" /></Grid>
    </Grid>
    <Card>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} sx={{ p: 2, borderBottom: "1px solid #e8edf3" }}><TextField size="small" label="Search assignment, staff, client" value={search} onChange={(event) => setSearch(event.target.value)} sx={{ flex: 1 }} /><FormControl size="small" sx={{ minWidth: 150 }}><InputLabel>Severity</InputLabel><Select label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value)}><MenuItem value="all">All</MenuItem><MenuItem value="critical">Critical</MenuItem><MenuItem value="high">High</MenuItem></Select></FormControl><Chip label={`${filtered.length} open`} color={filtered.length ? "error" : "success"} variant="outlined" sx={{ alignSelf: { xs: "flex-start", sm: "center" } }} /></Stack>
      {queue.isLoading && <LinearProgress />}
      <TableContainer><Table size="small" aria-label="Attendance exceptions"><TableHead><TableRow>{["Severity", "Assignment / stage", "Employee", "Assigned patient", "Reason", "Attempts", "Status", "Session"].map((label) => <TableCell key={label} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{filtered.map((item) => <TableRow key={item.id} hover><TableCell><StatusChip status={item.severity} /></TableCell><TableCell><Typography variant="body2" fontWeight={700}>{item.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{typeLabel(item)}</Typography></TableCell><TableCell>{item.employee.name}<Typography variant="caption" display="block" color="text.secondary">{item.employee.id || "ID unavailable"}</Typography></TableCell><TableCell>{item.patient.name}</TableCell><TableCell>{item.reason}</TableCell><TableCell>{item.callAttemptCount}</TableCell><TableCell><StatusChip status={item.status} /></TableCell><TableCell><Button size="small" onClick={() => navigate(`/sessions/${item.sessionId}`)}>Open</Button></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {queue.isSuccess && filtered.length === 0 && <Typography align="center" color="text.secondary" sx={{ py: 5 }}>No attendance exceptions require review.</Typography>}
    </Card>
  </Stack>;
}
