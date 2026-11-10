import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Box, Button, Card, CardContent, Chip, Grid, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import HowToRegRoundedIcon from "@mui/icons-material/HowToRegRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import CrisisAlertRoundedIcon from "@mui/icons-material/CrisisAlertRounded";
import CallRoundedIcon from "@mui/icons-material/CallRounded";
import { fetchAgents, fetchAttendance, fetchOperationsSummary, type AttendanceRecord, type OperationsSummary } from "../api/client";
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

export function OverviewPage({ showAgents = false }: { showAgents?: boolean }) {
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState("");
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: fetchAgents });
  const summaryQuery = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary, refetchInterval: 15_000 });
  const attendanceQuery = useQuery({ queryKey: ["attendance", "recent"], queryFn: () => fetchAttendance({ limit: 500 }), refetchInterval: 15_000 });
  const summary: OperationsSummary | undefined = summaryQuery.data;
  const chartData = useMemo(() => buildOverviewCharts(attendanceQuery.data || []), [attendanceQuery.data]);

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
    { label: "Scheduled today", value: metricValue(summary?.scheduledToday), detail: "Assignments scheduled for today", icon: <GroupRoundedIcon /> },
    { label: "Verified check-ins / check-outs", value: summary ? `${metricValue(summary.checkInsConfirmed)} / ${metricValue(summary.checkOutsConfirmed)}` : "—", detail: "Arrivals / duty completion confirmations", icon: <HowToRegRoundedIcon />, tint: "#e5f5ee", accent: "#178264" },
    { label: "Pending check-ins", value: metricValue(summary?.checkInsPending), detail: "Scheduled, calling, or follow-up", icon: <PendingActionsRoundedIcon />, tint: "#fff3df", accent: "#b8751a" },
    { label: "Exceptions", value: metricValue(summary?.exceptions), detail: "No-answer or review required", icon: <CrisisAlertRoundedIcon />, tint: "#fff0ed", accent: "#c44747" },
  ];
  const pipeline = [
    { name: "Completed calls", value: summary?.completedCalls || 0, percent: summary?.callsToday ? (summary.completedCalls / summary.callsToday) * 100 : 0, color: "success" },
    { name: "Active calls", value: summary?.activeCalls || 0, percent: summary?.maxConcurrentCalls ? (summary.activeCalls / summary.maxConcurrentCalls) * 100 : 0, color: "primary" },
    { name: "Waiting calls", value: summary?.callsWaiting || 0, percent: summary?.scheduledToday ? (summary.callsWaiting / summary.scheduledToday) * 100 : 0, color: "warning" },
  ];

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="WORKFORCE INTELLIGENCE / ATTENDANCE OPERATIONS" title="Operations dashboard" description="Monitor scheduled employee check-in and check-out calls from the live attendance service."
      actions={<><Chip label={new Date().toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })} variant="outlined" /><Button component={RouterLink} to="/attendance" variant="contained" endIcon={<ArrowForwardRoundedIcon />}>Open attendance</Button></>} />
    {(summaryQuery.isError || attendanceQuery.isError) && <Alert severity="error">Could not load live operations data. Check backend availability and authenticated organization access.</Alert>}
    <Grid container spacing={1.75}>
      {metrics.map((metric) => <Grid key={metric.label} size={{ xs: 12, sm: 6, md: 3 }}><MetricCard {...metric} /></Grid>)}
    </Grid>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, xl: 7 }}><SectionCard title="Check-in and check-out trend" subtitle="Confirmed employee-reported arrival and departure times over the past 7 days."><AttendanceTrendChart points={chartData.trend} /></SectionCard></Grid>
      <Grid size={{ xs: 12, xl: 5 }}><SectionCard title="Attendance status mix" subtitle="Current session distribution from the latest attendance records."><AttendanceStatusChart slices={chartData.statusSlices} /></SectionCard></Grid>
      <Grid size={{ xs: 12, md: 6 }}><SectionCard title="Call attempts per session" subtitle="Retry volume helps identify staff who need operational follow-up."><RetryVolumeChart buckets={chartData.retryBuckets} /></SectionCard></Grid>
      <Grid size={{ xs: 12, md: 6 }}><SectionCard title="Attendance by calling language" subtitle="Session outcomes grouped by the employee's selected language."><LanguageOutcomeChart rows={chartData.languageStacks} /></SectionCard></Grid>
    </Grid>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 7 }}><SectionCard title="Attendance status" subtitle="Confirmed and pending check-ins and check-outs from PostgreSQL.">
        {summaryQuery.isLoading ? <LinearProgress /> : <Stack spacing={2.2}>
          {[{ label: "Check-ins confirmed", value: summary?.checkInsConfirmed || 0, total: summary?.scheduledToday || 0, color: "#1557c0" }, { label: "Check-outs confirmed", value: summary?.checkOutsConfirmed || 0, total: summary?.scheduledToday || 0, color: "#178264" }, { label: "Check-ins pending", value: summary?.checkInsPending || 0, total: summary?.scheduledToday || 0, color: "#c07b24" }].map((item) => <Box key={item.label}><Stack direction="row" justifyContent="space-between" sx={{ mb: .7 }}><Typography variant="body2">{item.label}</Typography><Typography variant="body2" fontWeight={700}>{item.value} / {item.total}</Typography></Stack><LinearProgress variant="determinate" value={item.total ? Math.min(100, item.value / item.total * 100) : 0} sx={{ height: 8, borderRadius: 5, bgcolor: "#edf0f5", "& .MuiLinearProgress-bar": { bgcolor: item.color, borderRadius: 5 } }} /></Box>)}
        </Stack>}
      </SectionCard></Grid>
      <Grid size={{ xs: 12, lg: 5 }}><SectionCard title="Outbound call pipeline" subtitle="Current provider call and durable retry queue state." action={<Chip size="small" label={`${summary?.activeCalls ?? "—"} / ${summary?.maxConcurrentCalls ?? "—"} active`} variant="outlined" />}>
        {summaryQuery.isLoading ? <LinearProgress /> : pipeline.map((row) => <Box key={row.name} sx={{ mb: 2.1 }}><Stack direction="row" justifyContent="space-between" sx={{ mb: .7 }}><Typography variant="body2">{row.name}</Typography><Typography variant="body2" fontWeight={700}>{row.value}</Typography></Stack><LinearProgress variant="determinate" value={Math.max(0, Math.min(100, row.percent))} color={row.color as "success" | "warning" | "primary"} sx={{ height: 7, borderRadius: 5, bgcolor: "#edf0f5" }} /></Box>)}
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
