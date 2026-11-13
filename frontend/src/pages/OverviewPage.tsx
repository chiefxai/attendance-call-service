import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import HowToRegRoundedIcon from "@mui/icons-material/HowToRegRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import CrisisAlertRoundedIcon from "@mui/icons-material/CrisisAlertRounded";
import CallRoundedIcon from "@mui/icons-material/CallRounded";
import { fetchAgents, fetchAttendance, fetchCareManagerNotifications, fetchOperationsSummary, markCareManagerNotificationRead, type AttendanceRecord, type OperationsSummary } from "../api/client";
import { AttendanceStatusChart, AttendanceTrendChart, LanguageOutcomeChart, RetryVolumeChart, type AttendanceChartStatus } from "../components/BusinessCharts";
import { MetricCard, PageHeader, SectionCard, StatusChip } from "../components/OperationsUI";

const timeLabel = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const metricValue = (value: number | undefined) => value?.toLocaleString() ?? "—";

type DashboardStatus = AttendanceChartStatus;
const dashboardStatuses: DashboardStatus[] = ["pending", "checkin", "checkout", "processing", "delayed"];

function getDashboardStatus(row: AttendanceRecord): DashboardStatus {
  const stages = [row.checkIn.status, row.checkOut.status];
  if (stages.some((status) => status === "calling" || status === "processing")) return "processing";
  if (stages.some((status) => ["follow_up", "not_answered", "missed", "review"].includes(status))) return "delayed";
  if (row.checkIn.status === "confirmed" && row.checkOut.status === "confirmed") return "checkout";
  if (row.checkIn.status === "confirmed") return "checkin";
  return "pending";
}

function buildOverviewCharts(records: AttendanceRecord[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date, key, label: date.toLocaleDateString([], { weekday: "short" }), checkIns: 0, checkOuts: 0 };
  });
  const byDay = new Map(days.map((day) => [day.key, day]));
  records.forEach((record) => {
    if (record.checkIn.reportedAt) {
      const date = new Date(record.checkIn.reportedAt);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const point = byDay.get(key);
      if (point) point.checkIns += 1;
    }
    if (record.checkOut.reportedAt) {
      const date = new Date(record.checkOut.reportedAt);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const point = byDay.get(key);
      if (point) point.checkOuts += 1;
    }
  });

  const statusCounts: Record<DashboardStatus, number> = { pending: 0, checkin: 0, checkout: 0, processing: 0, delayed: 0 };
  const retryBuckets = [{ label: "0", value: 0 }, { label: "1–2", value: 0 }, { label: "3–4", value: 0 }, { label: "5+", value: 0 }];
  const languages: Record<string, { label: string; values: Record<DashboardStatus, number> }> = {};
  const languageLabels: Record<string, string> = { ta: "Tamil", tamil: "Tamil", en: "English", english: "English", ml: "Malayalam", malayalam: "Malayalam", te: "Telugu", telugu: "Telugu" };
  records.forEach((record) => {
    const status = getDashboardStatus(record);
    statusCounts[status] += 1;
    const attempts = record.callAttemptCount || 0;
    const bucket = attempts === 0 ? 0 : attempts <= 2 ? 1 : attempts <= 4 ? 2 : 3;
    retryBuckets[bucket].value += 1;
    const code = record.language.toLowerCase();
    const label = languageLabels[code] || "Other";
    languages[label] ||= { label, values: { pending: 0, checkin: 0, checkout: 0, processing: 0, delayed: 0 } };
    languages[label].values[status] += 1;
  });
  const languageOrder = ["Tamil", "English", "Malayalam", "Telugu", "Other"];
  return {
    trend: days,
    statusSlices: dashboardStatuses.map((status) => ({ status, value: statusCounts[status] })),
    retryBuckets,
    languageStacks: languageOrder.filter((label) => languages[label]).map((label) => languages[label]),
  };
}

export function OverviewPage({ showAgents = false, userRole = "admin", embedded = false }: { showAgents?: boolean; userRole?: "admin" | "care_manager"; embedded?: boolean }) {
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState("");
  const [drilldown, setDrilldown] = useState<{ title: string; records: AttendanceRecord[] } | null>(null);
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: fetchAgents });
  const summaryQuery = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary, refetchInterval: 15_000 });
  const attendanceQuery = useQuery({ queryKey: ["attendance", "recent"], queryFn: () => fetchAttendance({ limit: 500 }), refetchInterval: 15_000 });
  const queryClient = useQueryClient();
  const careManagerAlerts = useQuery({ queryKey: ["care-manager-notifications"], queryFn: fetchCareManagerNotifications, enabled: userRole === "care_manager", refetchInterval: 30_000 });
  const markAlertRead = useMutation({ mutationFn: markCareManagerNotificationRead, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["care-manager-notifications"] }) });
  const summary: OperationsSummary | undefined = summaryQuery.data;
  const chartData = useMemo(() => buildOverviewCharts(attendanceQuery.data || []), [attendanceQuery.data]);
  const openRecords = (title: string, predicate: (record: AttendanceRecord) => boolean) => {
    setDrilldown({ title, records: (attendanceQuery.data || []).filter(predicate) });
  };
  const dateKey = (value: string) => {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const todayKey = dateKey(new Date().toISOString());
  const statusLabel = (status: DashboardStatus) => status === "checkin" ? "Check-in" : status === "checkout" ? "Check-out" : status[0].toUpperCase() + status.slice(1);
  const filterStatus = (status: DashboardStatus) => openRecords(`${statusLabel(status)} sessions`, (record) => getDashboardStatus(record) === status);
  const languageName = (language: string) => ({ ta: "Tamil", tamil: "Tamil", en: "English", english: "English", ml: "Malayalam", malayalam: "Malayalam", te: "Telugu", telugu: "Telugu" }[language.toLowerCase()] || "Other");
  const filterAttempts = (bucket: string) => openRecords(`${bucket} call attempts`, (record) => {
    const attempts = record.callAttemptCount || 0;
    return bucket === "0" ? attempts === 0 : bucket === "1–2" ? attempts >= 1 && attempts <= 2 : bucket === "3–4" ? attempts >= 3 && attempts <= 4 : attempts >= 5;
  });

  if (showAgents) return <Stack spacing={3}>
    <PageHeader eyebrow="AI OPERATIONS" title="Calling agents" description="Agents configured for this authenticated workspace." />
    {agentsQuery.isError && <Alert severity="error">Could not load agents: {agentsQuery.error.message}</Alert>}
    <SectionCard title="Configured agents" subtitle="Agent configuration is managed through the backend API.">
      {agentsQuery.isLoading ? <LinearProgress /> : null}
      {agentsQuery.isSuccess && agentsQuery.data.length === 0 ? <Alert severity="info">No agents are configured yet. Create an agent through the backend before scheduling assignments.</Alert> : null}
      {agentsQuery.data?.map((agent) => <Stack key={agent.id} direction="row" justifyContent="space-between" alignItems="center" sx={{ borderTop: "1px solid #edf0f4", py: 1.7 }}><Box><Typography fontWeight={700}>{agent.name}</Typography><Typography variant="body2" color="text.secondary">{agent.language.toUpperCase()} · {agent.voice || "Default voice"}</Typography></Box><StatusChip status={agent.active ? "active" : "inactive"} /></Stack>)}
    </SectionCard>
  </Stack>;

  const metrics = [
    { label: "Scheduled today", value: metricValue(summary?.scheduledToday), detail: "Assignments scheduled for today · click to view", icon: <GroupRoundedIcon />, onClick: () => openRecords("Scheduled today", (record) => dateKey(record.scheduledStartAt) === todayKey) },
    { label: "Verified check-ins / check-outs", value: summary ? `${metricValue(summary.checkInsConfirmed)} / ${metricValue(summary.checkOutsConfirmed)}` : "—", detail: "Arrivals / duty completion · click to view", icon: <HowToRegRoundedIcon />, tint: "#e5f5ee", accent: "#178264", onClick: () => openRecords("Verified attendance", (record) => record.checkIn.status === "confirmed" || record.checkOut.status === "confirmed") },
    { label: "Pending check-ins", value: metricValue(summary?.checkInsPending), detail: "Scheduled, calling, or follow-up · click to view", icon: <PendingActionsRoundedIcon />, tint: "#fff3df", accent: "#b8751a", onClick: () => filterStatus("pending") },
    { label: "Exceptions", value: metricValue(summary?.exceptions), detail: "No-answer or review required · click to view", icon: <CrisisAlertRoundedIcon />, tint: "#fff0ed", accent: "#c44747", onClick: () => filterStatus("delayed") },
  ];
  const pipeline = [
    { name: "Completed calls", value: summary?.completedCalls || 0, percent: summary?.callsToday ? (summary.completedCalls / summary.callsToday) * 100 : 0, color: "success", onClick: () => openRecords("Completed attendance calls", (record) => record.checkIn.status === "confirmed" && record.checkOut.status === "confirmed") },
    { name: "Active calls", value: summary?.activeCalls || 0, percent: summary?.maxConcurrentCalls ? (summary.activeCalls / summary.maxConcurrentCalls) * 100 : 0, color: "primary", onClick: () => filterStatus("processing") },
    { name: "Waiting calls", value: summary?.callsWaiting || 0, percent: summary?.scheduledToday ? (summary.callsWaiting / summary.scheduledToday) * 100 : 0, color: "warning", onClick: () => filterStatus("pending") },
  ];

  return <Stack spacing={2.5}>
    {!embedded && <PageHeader eyebrow="WORKFORCE INTELLIGENCE / ATTENDANCE OPERATIONS" title="Operations dashboard" description="Monitor scheduled employee check-in and check-out calls from the live attendance service."
      actions={<><Chip label={new Date().toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })} variant="outlined" /><Button component={RouterLink} to="/attendance" variant="contained" endIcon={<ArrowForwardRoundedIcon />}>Open attendance</Button></>} />
    }
    {userRole === "care_manager" && <SectionCard title="Care manager alerts" subtitle="Attendance calls that reached the unanswered-call limit need follow-up.">
      {careManagerAlerts.isError && <Alert severity="error">Could not load care manager alerts.</Alert>}
      {careManagerAlerts.data?.length === 0 && <Alert severity="success">No new care manager alerts.</Alert>}
      <Stack spacing={1}>{careManagerAlerts.data?.map((alert) => <Card key={alert.id} variant="outlined" sx={{ p: 1.5, boxShadow: "none", borderColor: alert.readAt ? "divider" : "warning.light" }}><Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} justifyContent="space-between" alignItems={{ sm: "center" }}><Box><Typography variant="body2" fontWeight={700}>{alert.title}</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4 }}>{alert.message}</Typography><Typography variant="caption" color="text.secondary">{new Date(alert.createdAt).toLocaleString()}</Typography></Box>{!alert.readAt && <Button size="small" onClick={() => markAlertRead.mutate(alert.id)} disabled={markAlertRead.isPending}>Mark reviewed</Button>}</Stack></Card>)}</Stack>
    </SectionCard>}
    {(summaryQuery.isError || attendanceQuery.isError) && <Alert severity="error">Could not load live operations data. Check backend availability and authenticated organization access.</Alert>}
    <Grid container spacing={1.75}>
      {metrics.map((metric) => <Grid key={metric.label} size={{ xs: 12, sm: 6, md: 3 }}><MetricCard {...metric} /></Grid>)}
    </Grid>
    <Grid container spacing={1.75}>
      {userRole === "admin" && <Grid size={{ xs: 12, sm: 6, md: 3 }}><MetricCard label="Care Managers" value={metricValue(summary?.careManagers)} detail="Active application accounts" icon={<GroupRoundedIcon />} onClick={() => navigate("/care-managers")} /></Grid>}
      <Grid size={{ xs: 12, sm: 6, md: 3 }}><MetricCard label="Caregivers" value={metricValue(summary?.caregivers)} detail="Active organization records" icon={<GroupRoundedIcon />} onClick={() => navigate("/staff")} /></Grid>
      <Grid size={{ xs: 12, sm: 6, md: 3 }}><MetricCard label="Patients" value={metricValue(summary?.patients)} detail="Active organization records" icon={<GroupRoundedIcon />} onClick={() => navigate("/patients")} /></Grid>
      <Grid size={{ xs: 12, sm: 6, md: 3 }}><MetricCard label="Completed schedules" value={metricValue(summary?.completedSchedules)} detail="Both attendance stages confirmed" icon={<HowToRegRoundedIcon />} tint="#e5f5ee" accent="#178264" onClick={() => navigate("/attendance?status=completed")} /></Grid>
    </Grid>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, xl: 7 }}><SectionCard title="Check-in and check-out trend" subtitle="Select a day to see the sessions behind its totals."><AttendanceTrendChart points={chartData.trend} onSelectDay={(key) => openRecords(`Attendance on ${key}`, (record) => [record.checkIn.reportedAt, record.checkOut.reportedAt].some((time) => time && dateKey(time) === key))} /></SectionCard></Grid>
      <Grid size={{ xs: 12, xl: 5 }}><SectionCard title="Attendance status mix" subtitle="Select a status to view its sessions."><AttendanceStatusChart slices={chartData.statusSlices} onSelectStatus={filterStatus} /></SectionCard></Grid>
      <Grid size={{ xs: 12, md: 6 }}><SectionCard title="Call attempts per session" subtitle="Select a bar to review sessions by retry count."><RetryVolumeChart buckets={chartData.retryBuckets} onSelectBucket={filterAttempts} /></SectionCard></Grid>
      <Grid size={{ xs: 12, md: 6 }}><SectionCard title="Attendance by calling language" subtitle="Select a colored segment to view matching sessions."><LanguageOutcomeChart rows={chartData.languageStacks} onSelectLanguageStatus={(language, status) => openRecords(`${language} · ${statusLabel(status)}`, (record) => languageName(record.language) === language && getDashboardStatus(record) === status)} /></SectionCard></Grid>
    </Grid>
    <Dialog open={Boolean(drilldown)} onClose={() => setDrilldown(null)} fullWidth maxWidth="md">
      <DialogTitle>{drilldown?.title}</DialogTitle>
      <DialogContent dividers>
        {!drilldown?.records.length ? <Typography color="text.secondary" sx={{ py: 2 }}>No sessions match this widget.</Typography> : <Stack divider={<Box sx={{ borderBottom: "1px solid #edf0f4" }} />}>
          {drilldown.records.map((record) => <Stack key={record.sessionId} direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} justifyContent="space-between" sx={{ py: 1.2 }}>
            <Box sx={{ minWidth: 0 }}><Typography variant="body2" fontWeight={700}>{record.employee.name} · {record.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{record.patient.name} · {new Date(record.scheduledStartAt).toLocaleString()}</Typography></Box>
            <Stack direction="row" spacing={1} alignItems="center"><StatusChip status={getDashboardStatus(record)} /><Button size="small" onClick={() => navigate(`/sessions/${encodeURIComponent(record.sessionId)}`)}>View</Button></Stack>
          </Stack>)}
        </Stack>}
      </DialogContent>
      <DialogActions><Button onClick={() => setDrilldown(null)}>Close</Button><Button component={RouterLink} to="/attendance" onClick={() => setDrilldown(null)}>Open attendance</Button></DialogActions>
    </Dialog>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 7 }}><SectionCard title="Attendance status" subtitle="Confirmed and pending check-ins and check-outs from PostgreSQL.">
        {summaryQuery.isLoading ? <LinearProgress /> : <Stack spacing={2.2}>
          {[{ label: "Check-ins confirmed", value: summary?.checkInsConfirmed || 0, total: summary?.scheduledToday || 0, color: "#1557c0", predicate: (record: AttendanceRecord) => record.checkIn.status === "confirmed" }, { label: "Check-outs confirmed", value: summary?.checkOutsConfirmed || 0, total: summary?.scheduledToday || 0, color: "#178264", predicate: (record: AttendanceRecord) => record.checkOut.status === "confirmed" }, { label: "Check-ins pending", value: summary?.checkInsPending || 0, total: summary?.scheduledToday || 0, color: "#c07b24", predicate: (record: AttendanceRecord) => record.checkIn.status !== "confirmed" }].map((item) => <Box key={item.label} role="button" tabIndex={0} onClick={() => openRecords(item.label, item.predicate)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openRecords(item.label, item.predicate); } }} sx={{ cursor: "pointer", borderRadius: 1, p: .5, mx: -.5, "&:hover": { bgcolor: "action.hover" }, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" } }}><Stack direction="row" justifyContent="space-between" sx={{ mb: .7 }}><Typography variant="body2">{item.label}</Typography><Typography variant="body2" fontWeight={700}>{item.value} / {item.total}</Typography></Stack><LinearProgress variant="determinate" value={item.total ? Math.min(100, item.value / item.total * 100) : 0} sx={{ height: 8, borderRadius: 5, bgcolor: "#edf0f5", "& .MuiLinearProgress-bar": { bgcolor: item.color, borderRadius: 5 } }} /></Box>)}
        </Stack>}
      </SectionCard></Grid>
      <Grid size={{ xs: 12, lg: 5 }}><SectionCard title="Outbound call pipeline" subtitle="Current provider call and durable retry queue state." action={<Chip size="small" label={`${summary?.activeCalls ?? "—"} / ${summary?.maxConcurrentCalls ?? "—"} active`} variant="outlined" />}>
        {summaryQuery.isLoading ? <LinearProgress /> : pipeline.map((row) => <Box key={row.name} role="button" tabIndex={0} onClick={row.onClick} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); row.onClick(); } }} sx={{ mb: 2.1, cursor: "pointer", borderRadius: 1, p: .5, mx: -.5, "&:hover": { bgcolor: "action.hover" }, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" } }}><Stack direction="row" justifyContent="space-between" sx={{ mb: .7 }}><Typography variant="body2">{row.name}</Typography><Typography variant="body2" fontWeight={700}>{row.value}</Typography></Stack><LinearProgress variant="determinate" value={Math.max(0, Math.min(100, row.percent))} color={row.color as "success" | "warning" | "primary"} sx={{ height: 7, borderRadius: 5, bgcolor: "#edf0f5" }} /></Box>)}
        <Button component={RouterLink} to="/call-center" fullWidth endIcon={<ArrowForwardRoundedIcon />}>Open AI call center</Button>
      </SectionCard></Grid>
    </Grid>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 7 }}><SectionCard title="Recent assignment activity" subtitle="Latest saved assignment sessions." action={<Button component={RouterLink} to="/attendance" size="small" endIcon={<ArrowForwardRoundedIcon />}>All assignments</Button>}>
        {attendanceQuery.isLoading && <LinearProgress />}
        {attendanceQuery.data?.length === 0 && <Alert severity="info">No assignments have been received yet.</Alert>}
        {attendanceQuery.data?.slice(0, 6).map((item) => <Stack key={item.sessionId} direction="row" spacing={1.5} alignItems="center" sx={{ py: 1.25, borderTop: "1px solid #edf0f4" }}><Box sx={{ width: 34, height: 34, display: "grid", placeItems: "center", borderRadius: 2, bgcolor: "#f0f3f8", color: "primary.main" }}><CallRoundedIcon fontSize="small" /></Box><Box sx={{ flexGrow: 1 }}><Typography variant="body2" fontWeight={700}>{item.employee.name} · {item.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{item.patient.name} · {timeLabel(item.scheduledStartAt)}</Typography></Box><StatusChip status={item.checkIn.status} /><Button size="small" onClick={() => navigate(`/sessions/${item.sessionId}`)}>View</Button></Stack>)}
      </SectionCard></Grid>
      <Grid size={{ xs: 12, md: 5 }}><Card sx={{ height: "100%" }}><CardContent sx={{ p: 2.75 }}>
        <Typography variant="h6">Find an assignment session</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5, mb: 2.5 }}>Open its current check-in and check-out status.</Typography>
        <TextField fullWidth label="Session ID" placeholder="Paste the session UUID" value={sessionId} onChange={(event) => setSessionId(event.target.value)} size="small" />
        <Button fullWidth variant="contained" endIcon={<ArrowForwardRoundedIcon />} disabled={!sessionId.trim()} onClick={() => navigate(`/sessions/${encodeURIComponent(sessionId.trim())}`)} sx={{ mt: 1.5 }}>View session status</Button>
      </CardContent></Card></Grid>
    </Grid>
  </Stack>;
}
