import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, Chip, Grid, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import CallRoundedIcon from "@mui/icons-material/CallRounded";
import HeadsetMicRoundedIcon from "@mui/icons-material/HeadsetMicRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import PhoneMissedRoundedIcon from "@mui/icons-material/PhoneMissedRounded";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import { fetchCallCenterData, fetchCallPrompts, fetchOperationsSummary, saveCallPrompts } from "../api/client";
import { MetricCard, PageHeader, SectionCard, StatusChip } from "../components/OperationsUI";

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function CallCenterPage({ canEditPrompts = false }: { canEditPrompts?: boolean }) {
  const queryClient = useQueryClient();
  const calls = useQuery({ queryKey: ["call-center"], queryFn: fetchCallCenterData, refetchInterval: 5_000 });
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary, refetchInterval: 5_000 });
  const prompts = useQuery({ queryKey: ["call-prompts"], queryFn: fetchCallPrompts, retry: false, enabled: canEditPrompts });
  const [drafts, setDrafts] = useState<Record<string, { live: string; post: string }>>({});
  useEffect(() => {
    if (prompts.data) setDrafts(Object.fromEntries(prompts.data.scenarios.map(({ id, live, post }) => [id, { live, post }])));
  }, [prompts.data]);
  const savePrompts = useMutation({
    mutationFn: saveCallPrompts,
    onSuccess: (result) => { queryClient.setQueryData(["call-prompts"], result); setDrafts(Object.fromEntries(result.scenarios.map(({ id, live, post }) => [id, { live, post }]))); },
  });
  const promptsDirty = Boolean(prompts.data?.scenarios.some(({ id, live, post }) => drafts[id]?.live !== live || drafts[id]?.post !== post));
  const defaultsDiffer = Boolean(prompts.data?.scenarios.some(({ id }) => drafts[id]?.live !== prompts.data?.defaults?.[id]?.live || drafts[id]?.post !== prompts.data?.defaults?.[id]?.post));

  const activeCalls = calls.data?.activeCalls || [];
  const retryQueue = calls.data?.retryQueue || [];

  return <Stack spacing={2.5}>
    <PageHeader title="Attendance calls" />
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
    </Grid>
    {canEditPrompts && <SectionCard title="Call prompts" subtitle="Review and update the live-call and result-extraction guidance for each attendance scenario.">
      <Stack spacing={1.5}>
        <Alert severity="info">Prompts are saved for this organization and sent as <code>app_live_prompt_instructions</code> and <code>app_post_call_prompt_instructions</code>. Add those context variables to the matching reusable ChiefVoice templates once. Keep identity safeguards and the required output schema in those templates; the service validates the resulting attendance data.</Alert>
        {prompts.isLoading && <LinearProgress />}
        {prompts.isError && <Alert severity="error">Could not load call prompts. Check backend connectivity and administrator access.</Alert>}
        {savePrompts.isError && <Alert severity="error">Could not save prompts. Review your changes and try again.</Alert>}
        {savePrompts.isSuccess && <Alert severity="success">Call prompts saved. New calls will use the updated instructions.</Alert>}
        {prompts.data?.scenarios.map(({ id, label }, index) => <Accordion key={id} disableGutters elevation={0} defaultExpanded={index === 0} sx={{ border: "1px solid #e8edf3", borderRadius: "12px !important", "&:before": { display: "none" } }}>
          <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />}><Stack direction="row" spacing={1} alignItems="center"><Typography fontWeight={700}>{label}</Typography><Chip size="small" variant="outlined" label={id.replaceAll("_", " ")} /></Stack></AccordionSummary>
          <AccordionDetails><Grid container spacing={1.5}>
            <Grid size={{ xs: 12, md: 6 }}><TextField fullWidth multiline minRows={5} maxRows={14} label="Live call prompt" value={drafts[id]?.live ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [id]: { ...current[id], live: event.target.value } }))} helperText={`${drafts[id]?.live.length ?? 0}/12,000 · Conversation guidance supplied to the live template`} /></Grid>
            <Grid size={{ xs: 12, md: 6 }}><TextField fullWidth multiline minRows={5} maxRows={14} label="Post-call prompt" value={drafts[id]?.post ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [id]: { ...current[id], post: event.target.value } }))} helperText={`${drafts[id]?.post.length ?? 0}/12,000 · Result extraction guidance supplied to the post-call template`} /></Grid>
          </Grid></AccordionDetails>
        </Accordion>)}
        {prompts.data && <Stack direction="row" justifyContent="flex-end" spacing={1}>
          <Button startIcon={<RestartAltRoundedIcon />} disabled={!defaultsDiffer || savePrompts.isPending} onClick={() => setDrafts(Object.fromEntries(prompts.data!.scenarios.map(({ id }) => [id, prompts.data!.defaults?.[id] ?? drafts[id]])))}>Restore defaults</Button>
          <Button startIcon={<RestartAltRoundedIcon />} disabled={!promptsDirty || savePrompts.isPending} onClick={() => setDrafts(Object.fromEntries(prompts.data!.scenarios.map(({ id, live, post }) => [id, { live, post }]))) }>Discard changes</Button>
          <Button variant="contained" startIcon={<SaveRoundedIcon />} disabled={!promptsDirty || savePrompts.isPending} onClick={() => savePrompts.mutate(drafts)}>{savePrompts.isPending ? "Saving…" : "Save prompts"}</Button>
        </Stack>}
      </Stack>
    </SectionCard>}
    <SectionCard title="Scheduled retry queue" subtitle="Durable PostgreSQL jobs awaiting their next attempt.">
      {calls.isSuccess && retryQueue.length === 0 && <Typography variant="body2" color="text.secondary">No outbound call jobs are waiting.</Typography>}
      <Stack spacing={1}>{retryQueue.slice(0, 10).map((item) => <Stack key={item.jobId} direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={.5} sx={{ py: 1, borderTop: "1px solid #edf0f4" }}><Typography variant="body2" fontWeight={650}>{item.callTargetRole === "care_manager" ? "Care manager escalation" : item.employee.name} · {item.patient.name}</Typography><Typography variant="caption" color="text.secondary">{item.stage.replaceAll("_", " ")} · {item.callTargetRole === "care_manager" ? "manager" : "caregiver"} attempt {item.attemptNumber} · scheduled {formatTime(item.runAt)}</Typography></Stack>)}</Stack>
    </SectionCard>
  </Stack>;
}

