import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Grid, Stack, TextField, Typography } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import HowToRegRoundedIcon from "@mui/icons-material/HowToRegRounded";
import CrisisAlertRoundedIcon from "@mui/icons-material/CrisisAlertRounded";
import PhoneInTalkRoundedIcon from "@mui/icons-material/PhoneInTalkRounded";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import ScheduleRoundedIcon from "@mui/icons-material/ScheduleRounded";
import DonutLargeRoundedIcon from "@mui/icons-material/DonutLargeRounded";
import { fetchAttendance, fetchCareManagerNotifications, markCareManagerNotificationRead, type AttendanceRecord } from "../api/client";
import { AttendanceStatusChart, AttendanceTrendChart, LanguageOutcomeChart, RetryVolumeChart, type AttendanceChartStatus } from "../components/BusinessCharts";
import { MetricCard, PageHeader, SectionCard, StatusChip } from "../components/OperationsUI";
import { ReportsPage } from "./ReportsPage";
import { APP_TIME_ZONE, appDateKey, formatAppDate, formatAppDateTime } from "../utils/dateTime";

type DashboardStatus = AttendanceChartStatus;
const dashboardStatuses: DashboardStatus[] = ["pending", "checkin", "checkout", "processing", "delayed"];
const metricValue = (value: number | undefined) => value?.toLocaleString() ?? "—";

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

function getDashboardStatus(row: AttendanceRecord): DashboardStatus {
  const stages = [row.checkIn.status, row.checkOut.status];
  if (stages.some((status) => status === "calling" || status === "processing")) return "processing";
  if (stages.some((status) => ["follow_up", "not_answered", "missed", "review"].includes(status))) return "delayed";
  if (row.checkIn.status === "confirmed" && row.checkOut.status === "confirmed") return "checkout";
  if (row.checkIn.status === "confirmed") return "checkin";
  return "pending";
}

function buildDashboardCharts(records: AttendanceRecord[], selectedDate: string) {
  const [year, month, day] = selectedDate.split("-").map(Number);
  const trend = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day - (6 - index), 12));
    const key = date.toISOString().slice(0, 10);
    const label = new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: APP_TIME_ZONE }).format(date);
    return { key, label, checkIns: 0, checkOuts: 0 };
  });
  const byDay = new Map(trend.map((day) => [day.key, day]));
  const selectedRecords = records.filter((record) => appDateKey(record.scheduledStartAt) === selectedDate);
  const counts: Record<DashboardStatus, number> = { pending: 0, checkin: 0, checkout: 0, processing: 0, delayed: 0 };
  const byLanguage = new Map<string, Record<DashboardStatus, number>>();
  const retryBuckets = [{ label: "0", value: 0 }, { label: "1", value: 0 }, { label: "2", value: 0 }, { label: "3+", value: 0 }];
  records.forEach((record) => {
    if (record.checkIn.reportedAt) {
      const point = byDay.get(appDateKey(record.checkIn.reportedAt));
      if (point) point.checkIns += 1;
    }
    if (record.checkOut.reportedAt) {
      const point = byDay.get(appDateKey(record.checkOut.reportedAt));
      if (point) point.checkOuts += 1;
    }
  });
  selectedRecords.forEach((record) => {
    const status = getDashboardStatus(record);
    counts[status] += 1;
    const language = record.language?.trim() || "Unknown";
    const languageCounts = byLanguage.get(language) || { pending: 0, checkin: 0, checkout: 0, processing: 0, delayed: 0 };
    languageCounts[status] += 1;
    byLanguage.set(language, languageCounts);
    const bucketIndex = Math.min(record.callAttemptCount, 3);
    retryBuckets[bucketIndex].value += 1;
  });
  const languageRows = [...byLanguage.entries()]
    .map(([label, values]) => ({ label, values }))
    .sort((left, right) => Object.values(right.values).reduce((sum, value) => sum + value, 0) - Object.values(left.values).reduce((sum, value) => sum + value, 0))
    .slice(0, 5);
  return { trend, statusSlices: dashboardStatuses.map((status) => ({ status, value: counts[status] })), retryBuckets, languageRows };
}

export function OverviewPage({ userRole = "admin" }: { userRole?: "admin" | "care_manager"; embedded?: boolean }) {
  const navigate = useNavigate();
  const [drilldown, setDrilldown] = useState<{ title: string; records: AttendanceRecord[] } | null>(null);
  const [dashboardDate, setDashboardDate] = useState(() => appDateKey(new Date()));
  const todayKey = appDateKey(new Date());
  const chartStartDate = shiftDateKey(dashboardDate, -6);
  const attendanceQuery = useQuery({
    queryKey: ["attendance", "dashboard", chartStartDate, dashboardDate],
    queryFn: () => fetchAttendance({ fromDate: chartStartDate, toDate: dashboardDate, limit: 500 }),
    refetchInterval: dashboardDate === todayKey ? 15_000 : false,
  });
  const queryClient = useQueryClient();
  const careManagerAlerts = useQuery({ queryKey: ["care-manager-notifications"], queryFn: fetchCareManagerNotifications, enabled: userRole === "care_manager", refetchInterval: 30_000 });
  const markAlertRead = useMutation({ mutationFn: markCareManagerNotificationRead, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["care-manager-notifications"] }) });
  const records = attendanceQuery.data || [];
  const dashboardRecords = records.filter((record) => appDateKey(record.scheduledStartAt) === dashboardDate);
  const charts = useMemo(() => buildDashboardCharts(records, dashboardDate), [records, dashboardDate]);
  const dateKey = appDateKey;
  const openRecords = (title: string, predicate: (record: AttendanceRecord) => boolean, source = dashboardRecords) => setDrilldown({ title, records: source.filter(predicate) });
  const activeCalls = dashboardRecords.filter((record) => [record.checkIn.status, record.checkOut.status].some((status) => status === "calling" || status === "processing"));
  const pendingCheckouts = dashboardRecords.filter((record) => record.checkIn.status === "confirmed" && record.checkOut.status !== "confirmed");
  const overdueCheckins = dashboardRecords.filter((record) => record.checkIn.status !== "confirmed" && new Date(record.scheduledStartAt).getTime() < (dashboardDate === todayKey ? Date.now() : Number.POSITIVE_INFINITY));
  const completedForDate = dashboardRecords.filter((record) => record.checkIn.status === "confirmed" && record.checkOut.status === "confirmed").length;
  const checkInsForDate = dashboardRecords.filter((record) => record.checkIn.status === "confirmed").length;
  const checkOutsForDate = dashboardRecords.filter((record) => record.checkOut.status === "confirmed").length;
  const exceptionsForDate = dashboardRecords.filter((record) => getDashboardStatus(record) === "delayed").length;
  const completionRate = dashboardRecords.length ? `${Math.round(completedForDate / dashboardRecords.length * 100)}%` : "—";
  const statusLabel = (status: DashboardStatus) => status === "checkin" ? "Check-in" : status === "checkout" ? "Check-out" : status[0].toUpperCase() + status.slice(1);
  const filterStatus = (status: DashboardStatus) => openRecords(`${statusLabel(status)} sessions`, (record) => getDashboardStatus(record) === status);

  const metrics = [
    { label: "Scheduled", value: attendanceQuery.isLoading || attendanceQuery.isError ? "—" : metricValue(dashboardRecords.length), detail: `Assignments on ${formatAppDate(`${dashboardDate}T12:00:00+05:30`, { day: "numeric", month: "short", year: "numeric" })}`, icon: <GroupRoundedIcon />, onClick: () => openRecords("Scheduled sessions", () => true) },
    { label: "Confirmed check-ins", value: attendanceQuery.isLoading || attendanceQuery.isError ? "—" : metricValue(checkInsForDate), detail: "Attendance arrivals recorded", icon: <HowToRegRoundedIcon />, tint: "#e5f5ee", accent: "#178264", onClick: () => openRecords("Confirmed check-ins", (record) => record.checkIn.status === "confirmed") },
    { label: "Confirmed check-outs", value: attendanceQuery.isLoading || attendanceQuery.isError ? "—" : metricValue(checkOutsForDate), detail: "Duty completions recorded", icon: <LogoutRoundedIcon />, tint: "#edf2ff", accent: "#4267b2", onClick: () => openRecords("Confirmed check-outs", (record) => record.checkOut.status === "confirmed") },
    { label: "Exceptions", value: attendanceQuery.isLoading || attendanceQuery.isError ? "—" : metricValue(exceptionsForDate), detail: "No-answer or review required", icon: <CrisisAlertRoundedIcon />, tint: "#fff0ed", accent: "#c44747", onClick: () => filterStatus("delayed") },
  ];

  return <Stack spacing={2.5}>
    <PageHeader title="Attendance dashboard"
      actions={<><TextField type="date" size="small" label="Dashboard date" value={dashboardDate} onChange={(event) => setDashboardDate(event.target.value)} InputLabelProps={{ shrink: true }} inputProps={{ max: todayKey }} /><Button component={RouterLink} to="/attendance" variant="contained" endIcon={<ArrowForwardRoundedIcon />}>Open attendance</Button></>} />
    {userRole === "care_manager" && <SectionCard title="Care manager alerts" subtitle="Attendance calls that reached the unanswered-call limit need follow-up.">
      {careManagerAlerts.isError && <Alert severity="error">Could not load care manager alerts.</Alert>}
      {careManagerAlerts.data?.length === 0 && <Alert severity="success">No new care manager alerts.</Alert>}
      <Stack spacing={1}>{careManagerAlerts.data?.map((alert) => <Box key={alert.id} sx={{ p: 1.5, border: "1px solid", borderColor: alert.readAt ? "divider" : "warning.light", borderRadius: 2 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} justifyContent="space-between" alignItems={{ sm: "center" }}>
          <Box><Typography variant="body2" fontWeight={700}>{alert.title}</Typography><Typography variant="body2" color="text.secondary">{alert.message}</Typography><Typography variant="caption" color="text.secondary">{formatAppDateTime(alert.createdAt)}</Typography></Box>
          {!alert.readAt && <Button size="small" onClick={() => markAlertRead.mutate(alert.id)} disabled={markAlertRead.isPending}>Mark reviewed</Button>}
        </Stack>
      </Box>)}</Stack>
    </SectionCard>}
    {attendanceQuery.isError && <Alert severity="error">Could not load attendance data for the selected date. Check backend availability and authenticated organization access.</Alert>}
    <Grid container spacing={1.75}>
      {metrics.map((metric) => <Grid key={metric.label} size={{ xs: 12, sm: 6, md: 3 }}><MetricCard {...metric} /></Grid>)}
    </Grid>
    <SectionCard title="Operational pulse">
      <Grid container spacing={1.5}>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard compact label="Calls in progress" value={attendanceQuery.isLoading || attendanceQuery.isError ? "—" : metricValue(activeCalls.length)} detail="Check-in or check-out call underway" icon={<PhoneInTalkRoundedIcon />} tint="#edf2ff" accent="#4267b2" onClick={() => setDrilldown({ title: "Calls in progress", records: activeCalls })} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard compact label="Check-outs pending" value={attendanceQuery.isLoading || attendanceQuery.isError ? "—" : metricValue(pendingCheckouts.length)} detail="Checked in; duty completion not confirmed" icon={<LogoutRoundedIcon />} tint="#e5f5ee" accent="#178264" onClick={() => setDrilldown({ title: "Check-outs pending", records: pendingCheckouts })} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard compact label="Overdue check-ins" value={attendanceQuery.isLoading || attendanceQuery.isError ? "—" : metricValue(overdueCheckins.length)} detail="Scheduled start passed without confirmation" icon={<ScheduleRoundedIcon />} tint="#fff3df" accent="#b8751a" onClick={() => setDrilldown({ title: "Overdue check-ins", records: overdueCheckins })} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard compact label="Session completion" value={attendanceQuery.isLoading || attendanceQuery.isError ? "—" : completionRate} detail={attendanceQuery.isLoading || attendanceQuery.isError ? "Waiting for attendance data" : `${completedForDate.toLocaleString()} of ${dashboardRecords.length.toLocaleString()} sessions complete`} icon={<DonutLargeRoundedIcon />} tint="#f1eefe" accent="#7356a8" onClick={() => setDrilldown({ title: "Completed sessions", records: dashboardRecords.filter((record) => record.checkIn.status === "confirmed" && record.checkOut.status === "confirmed") })} /></Grid>
      </Grid>
      {records.length >= 500 && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>Insights show up to 500 sessions across the selected date and prior six days.</Typography>}
    </SectionCard>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, xl: 7 }}><SectionCard title="Check-in and check-out trend" subtitle="Seven days ending on the selected date. Select a day to view its attendance records.">
        <AttendanceTrendChart points={charts.trend} onSelectDay={(key) => openRecords(`Attendance on ${key}`, (record) => [record.checkIn.reportedAt, record.checkOut.reportedAt].some((time) => time && dateKey(time) === key), records)} />
      </SectionCard></Grid>
      <Grid size={{ xs: 12, xl: 5 }}><SectionCard title="Attendance status" subtitle="Status distribution for the selected date.">
        <AttendanceStatusChart slices={charts.statusSlices} onSelectStatus={filterStatus} />
      </SectionCard></Grid>
    </Grid>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 5 }}><SectionCard title="Call attempts per session" subtitle={`Attendance sessions scheduled through ${dashboardDate}`}>
        <RetryVolumeChart buckets={charts.retryBuckets} onSelectBucket={(bucket) => openRecords(`${bucket} call attempts`, (record) => bucket === "3+" ? record.callAttemptCount >= 3 : record.callAttemptCount === Number(bucket))} />
      </SectionCard></Grid>
      <Grid size={{ xs: 12, md: 7 }}><SectionCard title="Attendance by language" subtitle="Status mix for the most common calling languages.">
        <LanguageOutcomeChart rows={charts.languageRows} onSelectLanguageStatus={(language, status) => openRecords(`${language} · ${statusLabel(status)}`, (record) => (record.language?.trim() || "Unknown") === language && getDashboardStatus(record) === status)} />
      </SectionCard></Grid>
    </Grid>
    <ReportsPage />
    <Dialog open={Boolean(drilldown)} onClose={() => setDrilldown(null)} fullWidth maxWidth="md">
      <DialogTitle>{drilldown?.title}</DialogTitle>
      <DialogContent dividers>
        {!drilldown?.records.length ? <Typography color="text.secondary" sx={{ py: 2 }}>No sessions match this selection.</Typography> : <Stack divider={<Box sx={{ borderBottom: "1px solid #edf0f4" }} />}>
          {drilldown.records.map((record) => <Stack key={record.sessionId} direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} justifyContent="space-between" sx={{ py: 1.2 }}>
            <Box sx={{ minWidth: 0 }}><Typography variant="body2" fontWeight={700}>{record.employee.name} · {record.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{record.patient.name} · {formatAppDateTime(record.scheduledStartAt)}</Typography></Box>
            <Stack direction="row" spacing={1} alignItems="center"><StatusChip status={getDashboardStatus(record)} /><Button size="small" onClick={() => navigate(`/sessions/${encodeURIComponent(record.sessionId)}`)}>View</Button></Stack>
          </Stack>)}
        </Stack>}
      </DialogContent>
      <DialogActions><Button onClick={() => setDrilldown(null)}>Close</Button><Button component={RouterLink} to="/attendance" onClick={() => setDrilldown(null)}>Open attendance</Button></DialogActions>
    </Dialog>
  </Stack>;
}
