import { Alert, Box, Button, Card, Chip, Grid, LinearProgress, Stack, Typography } from "@mui/material";
import VerifiedUserRoundedIcon from "@mui/icons-material/VerifiedUserRounded";
import FactCheckRoundedIcon from "@mui/icons-material/FactCheckRounded";
import SyncAltRoundedIcon from "@mui/icons-material/SyncAltRounded";
import TimerRoundedIcon from "@mui/icons-material/TimerRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import { useQuery } from "@tanstack/react-query";
import { fetchOperationsSummary } from "../api/client";
import { MetricCard, PageHeader, SectionCard, StatusChip } from "../components/OperationsUI";

const protocol = [
  { name: "Assignment and staff match", detail: "Session is tied to the assigned employee and registered phone number.", state: "available", threshold: "Assignment data" },
  { name: "Employee verification", detail: "Agent confirms employee identity using the assignment context.", state: "available", threshold: "Agent confirmation" },
  { name: "Client name confirmation", detail: "Employee confirms the assigned patient before attendance is accepted.", state: "available", threshold: "Exact confirmation" },
  { name: "Shift schedule alignment", detail: "Check-in and check-out calls are scheduled from the assignment shift.", state: "available", threshold: "Scheduled window" },
  { name: "Arrival / departure time", detail: "Transcript extraction captures the reported time; unclear values route to review.", state: "available", threshold: "Reported time required" },
  { name: "Call transcript and outcome", detail: "Post-call worker transcribes the recording and evaluates the attendance intent.", state: "available", threshold: "Recorded call" },
  { name: "GPS or geofence", detail: "No GPS validation is connected yet; never treat location as verified in this version.", state: "integration required", threshold: "Future integration" },
];

export function VerificationEnginePage() {
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary, refetchInterval: 15_000 });
  const total = summary.data?.scheduledToday || 0;
  const pipeline = [
    { label: "Assignments scheduled", value: total, color: "#1557c0" },
    { label: "Check-ins confirmed", value: summary.data?.checkInsConfirmed || 0, color: "#178264" },
    { label: "Calls in progress / queued", value: (summary.data?.activeCalls || 0) + (summary.data?.callsWaiting || 0), color: "#c07b24" },
    { label: "Needs operations review", value: summary.data?.exceptions || 0, color: "#c44747" },
  ];
  return <Stack spacing={2.5}>
    <PageHeader eyebrow="ATTENDANCE / DECISION PIPELINE" title="AI attendance verification engine" description="The attendance workflow combines assignment details with the employee's spoken check-in and check-out report." actions={<Button variant="outlined" startIcon={<ReplayRoundedIcon />} disabled>Run batch re-evaluation</Button>} />
    {summary.isError && <Alert severity="error">Could not load verification counts from the backend.</Alert>}
    <Alert severity="warning">Current version does not perform voice biometrics, SIM / CLI matching, GPS geofencing, or EHR auto-commit. These checks require their respective integrations.</Alert>
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Scheduled today" value={summary.data?.scheduledToday.toLocaleString() ?? "—"} detail="Assignments in today's shift window" icon={<FactCheckRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Check-ins confirmed" value={summary.data?.checkInsConfirmed.toLocaleString() ?? "—"} detail="Attendance extraction accepted" icon={<VerifiedUserRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Calls active or queued" value={summary.data ? String(summary.data.activeCalls + summary.data.callsWaiting) : "—"} detail="Call scheduler and queue" icon={<TimerRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Operations review" value={summary.data?.exceptions.toLocaleString() ?? "—"} detail="No-answer or review status" icon={<RuleRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
    </Grid>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 7 }}><SectionCard title="Seven-point verification protocol" subtitle="Attendance is confirmed only when the required employee, client, stage, and time details pass.">
        <Stack spacing={0}>{protocol.map((item, index) => <Stack key={item.name} direction="row" spacing={1.5} alignItems="flex-start" sx={{ py: 1.5, borderTop: index ? "1px solid #edf0f4" : "none" }}>
          <Box sx={{ width: 29, height: 29, borderRadius: "50%", flexShrink: 0, bgcolor: item.state === "available" ? "#e5f5ee" : "#fff3df", color: item.state === "available" ? "#178264" : "#b8751a", display: "grid", placeItems: "center", fontWeight: 750, fontSize: 12 }}>{String(index + 1).padStart(2, "0")}</Box>
          <Box sx={{ flex: 1 }}><Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap"><Typography variant="body2" fontWeight={700}>{item.name}</Typography><StatusChip status={item.state} /></Stack><Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .4 }}>{item.detail}</Typography></Box>
          <Typography variant="caption" color="text.secondary" sx={{ textAlign: "right", minWidth: 120 }}>{item.threshold}</Typography>
        </Stack>)}</Stack>
      </SectionCard></Grid>
      <Grid size={{ xs: 12, lg: 5 }}><Stack spacing={2}>
        <SectionCard title="Decision pipeline" subtitle="Current assignment and call processing counts.">
          <Stack spacing={2}>{summary.isLoading && <LinearProgress />}{pipeline.map((item) => <Box key={item.label}><Stack direction="row" justifyContent="space-between" sx={{ mb: .65 }}><Typography variant="body2">{item.label}</Typography><Typography variant="body2" fontWeight={750}>{item.value}</Typography></Stack><LinearProgress variant="determinate" value={total ? Math.min(100, item.value / total * 100) : 0} sx={{ height: 8, borderRadius: 5, bgcolor: "#edf0f5", "& .MuiLinearProgress-bar": { bgcolor: item.color, borderRadius: 5 } }} /></Box>)}</Stack>
          <Box sx={{ mt: 2.5, p: 1.5, borderRadius: 2.5, bgcolor: "#f6f8fc" }}><Typography variant="caption" color="text.secondary">Decision rule</Typography><Typography variant="body2" fontWeight={650} sx={{ mt: .35 }}>Unclear identity, client, stage, or reported time routes to operations review.</Typography></Box>
        </SectionCard>
        <Card><Box sx={{ p: 2.5 }}><Stack direction="row" spacing={1.5} alignItems="flex-start"><SyncAltRoundedIcon color="primary" /><Box><Typography fontWeight={700}>Backend delivery</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>After check-in and check-out are confirmed, the service sends the attendance result to the configured host backend.</Typography><Chip size="small" label="API adapter required" variant="outlined" sx={{ mt: 1.5 }} /></Box></Stack></Box></Card>
      </Stack></Grid>
    </Grid>
  </Stack>;
}
