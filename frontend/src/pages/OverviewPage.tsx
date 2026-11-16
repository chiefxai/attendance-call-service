import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, Stack, Typography } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import HowToRegRoundedIcon from "@mui/icons-material/HowToRegRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import CrisisAlertRoundedIcon from "@mui/icons-material/CrisisAlertRounded";
import { fetchAttendance, fetchCareManagerNotifications, fetchOperationsSummary, markCareManagerNotificationRead, type AttendanceRecord, type OperationsSummary } from "../api/client";
import { AttendanceStatusChart, AttendanceTrendChart, type AttendanceChartStatus } from "../components/BusinessCharts";
import { MetricCard, PageHeader, SectionCard, StatusChip } from "../components/OperationsUI";
import { ReportsPage } from "./ReportsPage";

type DashboardStatus = AttendanceChartStatus;
const dashboardStatuses: DashboardStatus[] = ["pending", "checkin", "checkout", "processing", "delayed"];
const metricValue = (value: number | undefined) => value?.toLocaleString() ?? "—";

function getDashboardStatus(row: AttendanceRecord): DashboardStatus {
  const stages = [row.checkIn.status, row.checkOut.status];
  if (stages.some((status) => status === "calling" || status === "processing")) return "processing";
  if (stages.some((status) => ["follow_up", "not_answered", "missed", "review"].includes(status))) return "delayed";
  if (row.checkIn.status === "confirmed" && row.checkOut.status === "confirmed") return "checkout";
  if (row.checkIn.status === "confirmed") return "checkin";
  return "pending";
}

function buildDashboardCharts(records: AttendanceRecord[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const trend = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date, key, label: date.toLocaleDateString([], { weekday: "short" }), checkIns: 0, checkOuts: 0 };
  });
  const byDay = new Map(trend.map((day) => [day.key, day]));
  const counts: Record<DashboardStatus, number> = { pending: 0, checkin: 0, checkout: 0, processing: 0, delayed: 0 };
  records.forEach((record) => {
    if (record.checkIn.reportedAt) {
      const date = new Date(record.checkIn.reportedAt);
      const point = byDay.get(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
      if (point) point.checkIns += 1;
    }
    if (record.checkOut.reportedAt) {
      const date = new Date(record.checkOut.reportedAt);
      const point = byDay.get(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
      if (point) point.checkOuts += 1;
    }
    counts[getDashboardStatus(record)] += 1;
  });
  return { trend, statusSlices: dashboardStatuses.map((status) => ({ status, value: counts[status] })) };
}

export function OverviewPage({ userRole = "admin" }: { userRole?: "admin" | "care_manager"; embedded?: boolean }) {
  const navigate = useNavigate();
  const [drilldown, setDrilldown] = useState<{ title: string; records: AttendanceRecord[] } | null>(null);
  const summaryQuery = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary, refetchInterval: 15_000 });
  const attendanceQuery = useQuery({ queryKey: ["attendance", "recent"], queryFn: () => fetchAttendance({ limit: 500 }), refetchInterval: 15_000 });
  const queryClient = useQueryClient();
  const careManagerAlerts = useQuery({ queryKey: ["care-manager-notifications"], queryFn: fetchCareManagerNotifications, enabled: userRole === "care_manager", refetchInterval: 30_000 });
  const markAlertRead = useMutation({ mutationFn: markCareManagerNotificationRead, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["care-manager-notifications"] }) });
  const summary: OperationsSummary | undefined = summaryQuery.data;
  const records = attendanceQuery.data || [];
  const charts = useMemo(() => buildDashboardCharts(records), [records]);
  const dateKey = (value: string) => {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const openRecords = (title: string, predicate: (record: AttendanceRecord) => boolean) => setDrilldown({ title, records: records.filter(predicate) });
  const todayKey = dateKey(new Date().toISOString());
  const statusLabel = (status: DashboardStatus) => status === "checkin" ? "Check-in" : status === "checkout" ? "Check-out" : status[0].toUpperCase() + status.slice(1);
  const filterStatus = (status: DashboardStatus) => openRecords(`${statusLabel(status)} sessions`, (record) => getDashboardStatus(record) === status);

  const metrics = [
    { label: "Scheduled today", value: metricValue(summary?.scheduledToday), detail: "Assignments scheduled for today", icon: <GroupRoundedIcon />, onClick: () => openRecords("Scheduled today", (record) => dateKey(record.scheduledStartAt) === todayKey) },
    { label: "Verified check-ins / check-outs", value: summary ? `${metricValue(summary.checkInsConfirmed)} / ${metricValue(summary.checkOutsConfirmed)}` : "—", detail: "Confirmed arrivals / duty completion", icon: <HowToRegRoundedIcon />, tint: "#e5f5ee", accent: "#178264", onClick: () => openRecords("Verified attendance", (record) => record.checkIn.status === "confirmed" || record.checkOut.status === "confirmed") },
    { label: "Pending check-ins", value: metricValue(summary?.checkInsPending), detail: "Awaiting attendance confirmation", icon: <PendingActionsRoundedIcon />, tint: "#fff3df", accent: "#b8751a", onClick: () => filterStatus("pending") },
    { label: "Exceptions", value: metricValue(summary?.exceptions), detail: "No-answer or review required", icon: <CrisisAlertRoundedIcon />, tint: "#fff0ed", accent: "#c44747", onClick: () => filterStatus("delayed") },
  ];

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="WORKFORCE INTELLIGENCE / ATTENDANCE OPERATIONS" title="Attendance dashboard" description="Live check-in and check-out activity for scheduled workforce attendance."
      actions={<><Chip label={new Date().toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })} variant="outlined" /><Button component={RouterLink} to="/attendance" variant="contained" endIcon={<ArrowForwardRoundedIcon />}>Open attendance</Button></>} />
    {userRole === "care_manager" && <SectionCard title="Care manager alerts" subtitle="Attendance calls that reached the unanswered-call limit need follow-up.">
      {careManagerAlerts.isError && <Alert severity="error">Could not load care manager alerts.</Alert>}
      {careManagerAlerts.data?.length === 0 && <Alert severity="success">No new care manager alerts.</Alert>}
      <Stack spacing={1}>{careManagerAlerts.data?.map((alert) => <Box key={alert.id} sx={{ p: 1.5, border: "1px solid", borderColor: alert.readAt ? "divider" : "warning.light", borderRadius: 2 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} justifyContent="space-between" alignItems={{ sm: "center" }}>
          <Box><Typography variant="body2" fontWeight={700}>{alert.title}</Typography><Typography variant="body2" color="text.secondary">{alert.message}</Typography><Typography variant="caption" color="text.secondary">{new Date(alert.createdAt).toLocaleString()}</Typography></Box>
          {!alert.readAt && <Button size="small" onClick={() => markAlertRead.mutate(alert.id)} disabled={markAlertRead.isPending}>Mark reviewed</Button>}
        </Stack>
      </Box>)}</Stack>
    </SectionCard>}
    {(summaryQuery.isError || attendanceQuery.isError) && <Alert severity="error">Could not load live attendance data. Check backend availability and authenticated organization access.</Alert>}
    <Grid container spacing={1.75}>
      {metrics.map((metric) => <Grid key={metric.label} size={{ xs: 12, sm: 6, md: 3 }}><MetricCard {...metric} /></Grid>)}
    </Grid>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, xl: 7 }}><SectionCard title="Check-in and check-out trend" subtitle="Last seven days. Select a day to view its attendance records.">
        <AttendanceTrendChart points={charts.trend} onSelectDay={(key) => openRecords(`Attendance on ${key}`, (record) => [record.checkIn.reportedAt, record.checkOut.reportedAt].some((time) => time && dateKey(time) === key))} />
      </SectionCard></Grid>
      <Grid size={{ xs: 12, xl: 5 }}><SectionCard title="Attendance status" subtitle="Current status across recorded attendance sessions.">
        <AttendanceStatusChart slices={charts.statusSlices} onSelectStatus={filterStatus} />
      </SectionCard></Grid>
    </Grid>
    <ReportsPage embedded />
    <Dialog open={Boolean(drilldown)} onClose={() => setDrilldown(null)} fullWidth maxWidth="md">
      <DialogTitle>{drilldown?.title}</DialogTitle>
      <DialogContent dividers>
        {!drilldown?.records.length ? <Typography color="text.secondary" sx={{ py: 2 }}>No sessions match this selection.</Typography> : <Stack divider={<Box sx={{ borderBottom: "1px solid #edf0f4" }} />}>
          {drilldown.records.map((record) => <Stack key={record.sessionId} direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} justifyContent="space-between" sx={{ py: 1.2 }}>
            <Box sx={{ minWidth: 0 }}><Typography variant="body2" fontWeight={700}>{record.employee.name} · {record.assignmentId}</Typography><Typography variant="caption" color="text.secondary">{record.patient.name} · {new Date(record.scheduledStartAt).toLocaleString()}</Typography></Box>
            <Stack direction="row" spacing={1} alignItems="center"><StatusChip status={getDashboardStatus(record)} /><Button size="small" onClick={() => navigate(`/sessions/${encodeURIComponent(record.sessionId)}`)}>View</Button></Stack>
          </Stack>)}
        </Stack>}
      </DialogContent>
      <DialogActions><Button onClick={() => setDrilldown(null)}>Close</Button><Button component={RouterLink} to="/attendance" onClick={() => setDrilldown(null)}>Open attendance</Button></DialogActions>
    </Dialog>
  </Stack>;
}
