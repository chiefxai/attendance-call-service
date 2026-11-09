import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, CircularProgress, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import CallRoundedIcon from "@mui/icons-material/CallRounded";
import HeadsetMicRoundedIcon from "@mui/icons-material/HeadsetMicRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import PhoneMissedRoundedIcon from "@mui/icons-material/PhoneMissedRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import { AxiosError } from "axios";
import { fetchAgents, fetchCallCenterData, fetchOperationsSummary, updateAgent, type Agent } from "../api/client";
import { MetricCard, PageHeader, SectionCard, StatusChip } from "../components/OperationsUI";

const languageOptions = [{ code: "ta", name: "Tamil" }, { code: "en", name: "English" }, { code: "ml", name: "Malayalam" }, { code: "te", name: "Telugu" }];
const voiceOptions = ["Aoede", "Achird", "Algenib", "Anandhi", "Kavya", "Swarna"];
const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function CallCenterPage() {
  const [agentId, setAgentId] = useState("");
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: fetchAgents });
  const calls = useQuery({ queryKey: ["call-center"], queryFn: fetchCallCenterData, refetchInterval: 5_000 });
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary, refetchInterval: 5_000 });
  const selectedAgent = agents.data?.find((agent) => agent.id === agentId) || agents.data?.[0];
  const mutation = useMutation({
    mutationFn: (value: { agentId: string; update: Pick<Agent, "language" | "voice" | "systemPrompt"> }) => updateAgent(value.agentId, value.update),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });
  const errorMessage = mutation.error instanceof AxiosError ? mutation.error.response?.data?.error || mutation.error.message : mutation.error?.message;
  const saveConfig = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    if (!selectedAgent) return;
    mutation.mutate({ agentId: selectedAgent.id, update: { language: String(values.get("language")), voice: String(values.get("voice")), systemPrompt: String(values.get("systemPrompt")) } });
  };
  const activeCalls = calls.data?.activeCalls || [];
  const retryQueue = calls.data?.retryQueue || [];

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="VOBIZ OUTBOUND / VERTEX LIVE AUDIO" title="AI call center" description="Monitor currently connected employee calls and configure the live voice agent." actions={<Chip label="Outbound only" color="primary" variant="outlined" />} />
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
          <Box sx={{ flex: 1 }}><Typography variant="body2" fontWeight={700}>{call.employee.name} · {call.employee.id || "ID unavailable"}</Typography><Typography variant="caption" color="text.secondary">{call.patient.name} · {call.assignmentId}</Typography></Box>
          <Stack direction="row" spacing={.8} alignItems="center"><Chip size="small" label={call.stage.replaceAll("_", " ")} variant="outlined" /><Chip size="small" icon={<TranslateRoundedIcon />} label={call.language.toUpperCase()} /></Stack>
          <Stack alignItems={{ sm: "flex-end" }}><StatusChip status={call.status} /><Typography variant="caption" color="text.secondary" sx={{ mt: .5 }}>{call.attemptNumber} attempt · {formatTime(call.startedAt)}</Typography></Stack>
        </Stack></Card>)}</Stack>
      </SectionCard></Grid>
      <Grid size={{ xs: 12, lg: 5 }}><SectionCard title="Voice agent configuration" subtitle="Changes save to the selected workspace agent." action={<TuneRoundedIcon color="action" />}>
        {agents.isLoading && <LinearProgress />}
        {agents.isError && <Alert severity="error">Could not load agents: {agents.error.message}</Alert>}
        {agents.isSuccess && agents.data.length === 0 && <Alert severity="info">Create an agent through the backend before configuring its voice.</Alert>}
        {agents.data && agents.data.length > 0 && <Box component="form" onSubmit={saveConfig}><Stack spacing={2}>
          {agents.data.length > 1 && <FormControl size="small" fullWidth><InputLabel>Agent</InputLabel><Select label="Agent" value={selectedAgent?.id || ""} onChange={(event) => setAgentId(event.target.value)}>{agents.data.map((agent) => <MenuItem key={agent.id} value={agent.id}>{agent.name}</MenuItem>)}</Select></FormControl>}
          <Typography variant="body2" fontWeight={700}>{selectedAgent?.name} · {selectedAgent?.active ? "Active" : "Inactive"}</Typography>
          <FormControl size="small" fullWidth><InputLabel>Preferred language</InputLabel><Select name="language" label="Preferred language" defaultValue={selectedAgent?.language || "ta"} key={`${selectedAgent?.id}-language`}>{languageOptions.map((item) => <MenuItem key={item.code} value={item.code}>{item.name}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Vertex voice</InputLabel><Select name="voice" label="Vertex voice" defaultValue={selectedAgent?.voice || "Achird"} key={`${selectedAgent?.id}-voice`}>{voiceOptions.map((voice) => <MenuItem key={voice} value={voice}>{voice}</MenuItem>)}</Select></FormControl>
          <TextField name="systemPrompt" label="Agent instructions" multiline minRows={4} defaultValue={selectedAgent?.systemPrompt || ""} key={`${selectedAgent?.id}-prompt`} helperText="Instructions are sent to the live voice agent." />
          {mutation.isError && <Alert severity="error">Settings were not saved: {errorMessage}</Alert>}{mutation.isSuccess && <Alert severity="success">Agent settings saved.</Alert>}
          <Button type="submit" variant="contained" startIcon={mutation.isPending ? <CircularProgress size={16} color="inherit" /> : <SaveRoundedIcon />} disabled={mutation.isPending || !selectedAgent?.active}>Save agent settings</Button>
        </Stack></Box>}
      </SectionCard></Grid>
    </Grid>
    <SectionCard title="Scheduled retry queue" subtitle="Durable PostgreSQL jobs awaiting their next attempt.">
      {calls.isSuccess && retryQueue.length === 0 && <Typography variant="body2" color="text.secondary">No outbound call jobs are waiting.</Typography>}
      <Stack spacing={1}>{retryQueue.slice(0, 10).map((item) => <Stack key={item.jobId} direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={.5} sx={{ py: 1, borderTop: "1px solid #edf0f4" }}><Typography variant="body2" fontWeight={650}>{item.employee.name} · {item.patient.name}</Typography><Typography variant="caption" color="text.secondary">{item.stage.replaceAll("_", " ")} · attempt {item.attemptNumber} · scheduled {formatTime(item.runAt)}</Typography></Stack>)}</Stack>
    </SectionCard>
  </Stack>;
}
