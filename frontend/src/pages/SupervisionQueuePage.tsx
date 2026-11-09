import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import CallMadeRoundedIcon from "@mui/icons-material/CallMadeRounded";
import ScheduleRoundedIcon from "@mui/icons-material/ScheduleRounded";
import FactCheckRoundedIcon from "@mui/icons-material/FactCheckRounded";
import AssignmentLateRoundedIcon from "@mui/icons-material/AssignmentLateRounded";
import { fetchSupervisionQueue } from "../api/client";
import { MetricCard, PageHeader, StatusChip } from "../components/OperationsUI";

const timeLabel = (value: string) => new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export function SupervisionQueuePage() {
  const navigate = useNavigate();
  const [severity, setSeverity] = useState("all");
  const [search, setSearch] = useState("");
  const queue = useQuery({ queryKey: ["supervision-queue", severity], queryFn: () => fetchSupervisionQueue({ severity, limit: 500 }), refetchInterval: 15_000 });
  const items = (queue.data || []).filter((item) => !search || `${item.assignmentId} ${item.employee.name} ${item.patient.name} ${item.reason}`.toLowerCase().includes(search.toLowerCase()));
  const unanswered = items.filter((item) => item.status === "not_answered" || item.status === "missed").length;
  const review = items.filter((item) => item.status === "review").length;
  const checkout = items.filter((item) => item.stage === "check_out").length;

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="OPERATIONS / ATTENDANCE SUPERVISION" title="Pending attendance & exceptions queue" description="Live sessions requiring human review because calls were unanswered or attendance details were unclear." actions={<Chip label="Read-only queue" variant="outlined" />} />
    {queue.isError && <Alert severity="error">Could not load the supervision queue from the backend.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Triage needed" value={String(items.length)} detail="Current queue items" icon={<AssignmentLateRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Not answered" value={String(unanswered)} detail="Configured retry limit reached" icon={<CallMadeRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Verification review" value={String(review)} detail="Unclear or incomplete call result" icon={<FactCheckRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Check-out review" value={String(checkout)} detail="Duty completion needs attention" icon={<ScheduleRoundedIcon />} /></Grid>
    </Grid>
    <Card>
      <Stack direction={{ xs: "column", lg: "row" }} spacing={1.2} sx={{ p: 2, borderBottom: "1px solid #e8edf3" }}><TextField size="small" label="Search assignment, employee, patient" value={search} onChange={(event) => setSearch(event.target.value)} sx={{ flex: 1 }} /><FormControl size="small" sx={{ minWidth: 150 }}><InputLabel>Severity</InputLabel><Select label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value)}><MenuItem value="all">All severities</MenuItem><MenuItem value="critical">Critical</MenuItem><MenuItem value="high">High</MenuItem></Select></FormControl><Chip label={`${items.length} items`} variant="outlined" sx={{ alignSelf: { xs: "flex-start", lg: "center" } }} /></Stack>
      {queue.isLoading && <LinearProgress />}
      <TableContainer><Table size="small" aria-label="Attendance supervision queue"><TableHead><TableRow>{["Queue / severity", "Assignment / stage", "Employee & patient", "Reason", "Call attempts", "Scheduled time", "Status", "Session"].map((label) => <TableCell key={label} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{items.map((item) => <TableRow key={item.id} hover><TableCell><Typography variant="body2" fontWeight={700}>{item.id.slice(0, 8)}</Typography><StatusChip status={item.severity} /></TableCell><TableCell><Typography variant="body2" fontWeight={650}>{item.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{item.stage.replaceAll("_", " ")}</Typography></TableCell><TableCell><Typography variant="body2" fontWeight={650}>{item.employee.name}</Typography><Typography variant="caption" color="text.secondary">{item.patient.name}</Typography></TableCell><TableCell>{item.reason}</TableCell><TableCell>{item.callAttemptCount}</TableCell><TableCell>{timeLabel(item.scheduledAt)}</TableCell><TableCell><StatusChip status={item.status} /></TableCell><TableCell><Button size="small" onClick={() => navigate(`/sessions/${item.sessionId}`)}>Open</Button></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {queue.isSuccess && items.length === 0 && <Typography align="center" color="text.secondary" sx={{ py: 5 }}>The attendance supervision queue is clear.</Typography>}
    </Card>
  </Stack>;
}
