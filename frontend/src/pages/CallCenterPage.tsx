import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Card, Chip, Grid, LinearProgress, Stack, Typography } from "@mui/material";
import CallRoundedIcon from "@mui/icons-material/CallRounded";
import HeadsetMicRoundedIcon from "@mui/icons-material/HeadsetMicRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import PhoneMissedRoundedIcon from "@mui/icons-material/PhoneMissedRounded";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import { fetchCallCenterData, fetchOperationsSummary } from "../api/client";
import { MetricCard, PageHeader, SectionCard, StatusChip } from "../components/OperationsUI";

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function CallCenterPage() {
  const calls = useQuery({ queryKey: ["call-center"], queryFn: fetchCallCenterData, refetchInterval: 5_000 });
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary, refetchInterval: 5_000 });

  const activeCalls = calls.data?.activeCalls || [];
  const retryQueue = calls.data?.retryQueue || [];

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="CHIEFVOICE OUTBOUND" title="Attendance calls" description="Monitor employee attendance calls placed through ChiefVoice." />
    {(calls.isError || summary.isError) && <Alert severity="error">Could not load the call center feed. Check backend connectivity and workspace access.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Calls today" value={summary.data?.callsToday.toLocaleString() ?? "—"} detail="Outbound call attempts" icon={<CallRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Active calls" value={summary.data?.activeCalls.toLocaleString() ?? "—"} detail={`Concurrency cap ${summary.data?.maxConcurrentCalls ?? "—"}`} icon={<HeadsetMicRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Completed calls" value={summary.data?.completedCalls.toLocaleString() ?? "—"} detail="Terminal provider status" icon={<CheckCircleRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Calls waiting" value={summary.data?.callsWaiting.toLocaleString() ?? "—"} detail="Durable retry and schedule queue" icon={<PhoneMissedRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
    </Grid>
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 7 }}><SectionCard title="Active outbound calls" subtitle="Live provider attempts currently ringing or connected." action={<Chip size="small" label={`${activeCalls.length} active`} color={activeCalls.length ? "success" : "default"} variant="outlined" />}>
        {calls.isLoading && <LinearProgress />}
        {calls.isSuccess && activeCalls.length === 0 && <Alert severity="info">No active calls right now. Scheduled and retry calls will appear here while the provider reports them active.</Alert>}
        <Stack spacing={1.25}>{activeCalls.map((call) => <Card key={call.attemptId} variant="outlined" sx={{ p: 1.5, boxShadow: "none", borderColor: "#e8edf3" }}><Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
          <Box sx={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: 2.5, bgcolor: "#edf3ff", color: "primary.main" }}><CallRoundedIcon fontSize="small" /></Box>
          <Box sx={{ flex: 1 }}><Typography variant="body2" fontWeight={700}>{call.callTargetRole === "care_manager" ? "Care manager escalation" : `${call.employee.name} · ${call.employee.id || "ID unavailable"}`}</Typography><Typography variant="caption" color="text.secondary">{call.patient.name} · {call.assignmentId}</Typography></Box>
          <Stack direction="row" spacing={.8} alignItems="center"><Chip size="small" label={call.stage.replaceAll("_", " ")} variant="outlined" /><Chip size="small" icon={<TranslateRoundedIcon />} label={call.language.toUpperCase()} /></Stack>
          <Stack alignItems={{ sm: "flex-end" }}><StatusChip status={call.status} /><Typography variant="caption" color="text.secondary" sx={{ mt: .5 }}>{call.callTargetRole === "care_manager" ? "Manager" : "Caregiver"} attempt {call.attemptNumber} · {formatTime(call.startedAt)}</Typography></Stack>
        </Stack></Card>)}</Stack>
      </SectionCard></Grid>
      <Grid size={{ xs: 12, lg: 5 }}><SectionCard title="ChiefVoice integration" subtitle="Live and post-call behavior is configured in reusable ChiefVoice templates.">
        <Alert severity="info">This service sends attendance calls through ChiefVoice. Configure the conversation and result templates in ChiefVoice; per-call caregiver, patient, and schedule context is supplied automatically by the backend.</Alert>
      </SectionCard></Grid>
    </Grid>
    <SectionCard title="Scheduled retry queue" subtitle="Durable PostgreSQL jobs awaiting their next attempt.">
      {calls.isSuccess && retryQueue.length === 0 && <Typography variant="body2" color="text.secondary">No outbound call jobs are waiting.</Typography>}
      <Stack spacing={1}>{retryQueue.slice(0, 10).map((item) => <Stack key={item.jobId} direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={.5} sx={{ py: 1, borderTop: "1px solid #edf0f4" }}><Typography variant="body2" fontWeight={650}>{item.callTargetRole === "care_manager" ? "Care manager escalation" : item.employee.name} · {item.patient.name}</Typography><Typography variant="caption" color="text.secondary">{item.stage.replaceAll("_", " ")} · {item.callTargetRole === "care_manager" ? "manager" : "caregiver"} attempt {item.attemptNumber} · scheduled {formatTime(item.runAt)}</Typography></Stack>)}</Stack>
    </SectionCard>
  </Stack>;
}

