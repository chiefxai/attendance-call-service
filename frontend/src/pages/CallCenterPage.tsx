import { useEffect, useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, CircularProgress, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import CallRoundedIcon from "@mui/icons-material/CallRounded";
import HeadsetMicRoundedIcon from "@mui/icons-material/HeadsetMicRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import PhoneMissedRoundedIcon from "@mui/icons-material/PhoneMissedRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import { AxiosError } from "axios";
import { createAgent, createAssignment, fetchAgents, fetchCallCenterData, fetchOperationsSummary, updateAgent, type Agent, type AgentLanguagePrompt, type AssignmentPayload } from "../api/client";
import { MetricCard, PageHeader, SectionCard, StatusChip } from "../components/OperationsUI";

const languageOptions = [{ code: "ta", name: "Tamil" }, { code: "en", name: "English" }, { code: "ml", name: "Malayalam" }, { code: "te", name: "Telugu" }];
const voiceOptions = ["Aoede", "Achird", "Algenib", "Anandhi", "Kavya", "Swarna"];
const defaultLanguagePrompts: Record<string, AgentLanguagePrompt> = {
  ta: { dialect: "Conversational Tamil (neutral Tamil Nadu)", systemPrompt: "Speak in natural spoken Tamil using short, familiar phrases. Avoid overly formal written Tamil." },
  en: { dialect: "Indian English", systemPrompt: "Speak in clear, natural Indian English with short sentences and familiar local phrasing." },
  ml: { dialect: "Conversational Kerala Malayalam", systemPrompt: "Speak in natural spoken Malayalam using familiar Kerala phrasing. Avoid overly formal written language." },
  te: { dialect: "Conversational Telugu (neutral Andhra / Telangana)", systemPrompt: "Speak in natural spoken Telugu using short, familiar phrases and a neutral regional style." },
};
function resolveLanguagePrompts(saved?: Record<string, AgentLanguagePrompt>) {
  return Object.fromEntries(languageOptions.map(({ code }) => [code, {
    ...defaultLanguagePrompts[code],
    ...(saved?.[code] || {}),
  }])) as Record<string, AgentLanguagePrompt>;
}
function makeLanguagePrompt(language: string, dialect: string) {
  const name = languageOptions.find((item) => item.code === language)?.name || "English";
  return `Speak naturally in ${name} using the ${dialect || defaultLanguagePrompts[language]?.dialect || name} dialect. Use locally familiar expressions and colloquial phrasing suited to a respectful attendance call. Keep sentences short and phone-friendly, ask one clear question at a time, and avoid expressions that could confuse or offend.`;
}
const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const localInputValue = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const errorText = (error: unknown) => error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";

export function CallCenterPage() {
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState("");
  const [testForm, setTestForm] = useState({ employeeName: "", employeePhone: "", patientName: "", patientAddress: "", language: "ta", checkoutAt: localInputValue(new Date(Date.now() + 60 * 60_000)) });
  const [testSessionId, setTestSessionId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentLanguage, setAgentLanguage] = useState("ta");
  const [agentVoice, setAgentVoice] = useState("Achird");
  const [agentDialect, setAgentDialect] = useState(defaultLanguagePrompts.ta.dialect);
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: fetchAgents });
  const calls = useQuery({ queryKey: ["call-center"], queryFn: fetchCallCenterData, refetchInterval: 5_000 });
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary, refetchInterval: 5_000 });
  const selectedAgent = agents.data?.find((agent) => agent.id === agentId) || agents.data?.find((agent) => agent.active) || agents.data?.[0];
  useEffect(() => {
    setAgentName(selectedAgent?.name || "");
    setAgentLanguage(selectedAgent?.language || "ta");
    setAgentVoice(selectedAgent?.voice || "Achird");
    const prompts = resolveLanguagePrompts(selectedAgent?.languagePrompts);
    setAgentDialect(prompts[selectedAgent?.language || "ta"]?.dialect || defaultLanguagePrompts.ta.dialect);
  }, [selectedAgent?.id, selectedAgent?.language, selectedAgent?.name, selectedAgent?.voice, selectedAgent?.languagePrompts]);
  const changeAgentLanguage = (language: string) => {
    setAgentLanguage(language);
    const prompts = resolveLanguagePrompts(selectedAgent?.languagePrompts);
    setAgentDialect(prompts[language]?.dialect || defaultLanguagePrompts[language].dialect);
  };
  const promptPreview = makeLanguagePrompt(agentLanguage, agentDialect);
  const mutation = useMutation({
    mutationFn: (value: { agentId: string; update: Pick<Agent, "name" | "language" | "voice" | "systemPrompt" | "languagePrompts"> }) => updateAgent(value.agentId, value.update),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });
  const createAgentMutation = useMutation({
    mutationFn: (value: Pick<Agent, "name" | "language" | "voice" | "systemPrompt" | "languagePrompts">) => createAgent(value),
    onSuccess: async (created) => {
      setAgentId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  const saveAgent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const languagePrompts = {
      ...resolveLanguagePrompts(selectedAgent?.languagePrompts),
      [agentLanguage]: { dialect: agentDialect.trim(), systemPrompt: promptPreview },
    };
    if (selectedAgent) {
      mutation.mutate({
        agentId: selectedAgent.id,
        update: { name: agentName.trim(), language: agentLanguage, voice: agentVoice, systemPrompt: "", languagePrompts },
      });
    } else {
      createAgentMutation.mutate({
        name: agentName.trim(),
        language: agentLanguage,
        voice: agentVoice,
        systemPrompt: "",
        languagePrompts,
      });
    }
  };
  const testMutation = useMutation({
    mutationFn: createAssignment,
    onSuccess: async (result) => {
      setTestSessionId(result.sessionId);
      await queryClient.invalidateQueries({ queryKey: ["attendance"] });
      await queryClient.invalidateQueries({ queryKey: ["operations-summary"] });
    },
  });
  const testError = testMutation.error instanceof AxiosError ? testMutation.error.response?.data?.error || testMutation.error.message : testMutation.error?.message;
  const updateTest = (key: keyof typeof testForm) => (value: string) => setTestForm((current) => ({ ...current, [key]: value }));
  const submitTestCall = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const now = new Date();
    const checkout = new Date(testForm.checkoutAt);
    if (!selectedAgent?.active || !Number.isFinite(checkout.getTime()) || checkout <= now) return;
    const nonce = crypto.randomUUID();
    const payload: AssignmentPayload = {
      assignmentId: "TEST-" + nonce,
      agentId: selectedAgent.id,
      language: testForm.language,
      scheduledStartAt: new Date(Date.now() + 2_000).toISOString(),
      scheduledEndAt: checkout.toISOString(),
      employee: { id: "TEST-STAFF-" + nonce, name: testForm.employeeName.trim(), phoneNumber: testForm.employeePhone.trim() },
      patient: { id: "TEST-PATIENT-" + nonce, name: testForm.patientName.trim(), address: testForm.patientAddress.trim() },
    };
    testMutation.mutate(payload);
  };
  const errorMessage = mutation.error instanceof AxiosError ? mutation.error.response?.data?.error || mutation.error.message : mutation.error?.message;

  const activeCalls = calls.data?.activeCalls || [];
  const retryQueue = calls.data?.retryQueue || [];

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="VOBIZ OUTBOUND / VERTEX LIVE AUDIO" title="AI call center" description="Monitor currently connected employee calls and configure the live voice agent." actions={<Button component={RouterLink} to="/assignments/new" variant="contained" startIcon={<AddRoundedIcon />}>New assignment</Button>} />
    {(calls.isError || summary.isError) && <Alert severity="error">Could not load the call center feed. Check backend connectivity and workspace access.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Calls today" value={summary.data?.callsToday.toLocaleString() ?? "—"} detail="Outbound call attempts" icon={<CallRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Active calls" value={summary.data?.activeCalls.toLocaleString() ?? "—"} detail={`Concurrency cap ${summary.data?.maxConcurrentCalls ?? "—"}`} icon={<HeadsetMicRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Completed calls" value={summary.data?.completedCalls.toLocaleString() ?? "—"} detail="Terminal provider status" icon={<CheckCircleRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Calls waiting" value={summary.data?.callsWaiting.toLocaleString() ?? "—"} detail="Durable retry and schedule queue" icon={<PhoneMissedRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
    </Grid>
    <SectionCard title="Test a live call" subtitle="Start a real check-in call to the employee and schedule the paired check-out call in this same session.">
      <Stack spacing={1.5}>
        <Alert severity="warning">This places a real outbound Vobiz call and may incur telephony charges. Use a number you control. The test assignment remains open until check-out is completed or reaches its retry limit.</Alert>
        {testMutation.isError && <Alert severity="error">Could not start test calls: {testError}</Alert>}
        {testSessionId && <Alert severity="success" action={<Button color="inherit" size="small" onClick={() => navigate("/sessions/" + testSessionId)}>View session</Button>}>Test session created. The check-in call is queued now and the check-out call is set for the selected time.</Alert>}
        <Box component="form" onSubmit={submitTestCall}>
          <Grid container spacing={1.5}>
            <Grid size={{ xs: 12, sm: 6 }}><TextField size="small" fullWidth required label="Employee name" value={testForm.employeeName} onChange={(event) => updateTest("employeeName")(event.target.value)} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField size="small" fullWidth required label="Employee phone (E.164)" placeholder="+919876543210" value={testForm.employeePhone} onChange={(event) => updateTest("employeePhone")(event.target.value)} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField size="small" fullWidth required label="Patient name for verification" value={testForm.patientName} onChange={(event) => updateTest("patientName")(event.target.value)} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField size="small" fullWidth required label="Patient service address" value={testForm.patientAddress} onChange={(event) => updateTest("patientAddress")(event.target.value)} /></Grid>
            <Grid size={{ xs: 12, sm: 4 }}><TextField select size="small" fullWidth label="Call language" value={testForm.language} onChange={(event) => updateTest("language")(event.target.value)}>{languageOptions.map((option) => <MenuItem key={option.code} value={option.code}>{option.name}</MenuItem>)}</TextField></Grid>
            <Grid size={{ xs: 12, sm: 4 }}><TextField type="datetime-local" size="small" fullWidth required label="Check-out call time" value={testForm.checkoutAt} onChange={(event) => updateTest("checkoutAt")(event.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
            <Grid size={{ xs: 12, sm: 4 }}><Button fullWidth type="submit" variant="contained" startIcon={testMutation.isPending ? <CircularProgress size={16} color="inherit" /> : <PlayArrowRoundedIcon />} disabled={testMutation.isPending || !selectedAgent?.active || !testForm.employeeName.trim() || !testForm.employeePhone.trim() || !testForm.patientName.trim() || !testForm.patientAddress.trim() || new Date(testForm.checkoutAt) <= new Date()} sx={{ height: 40 }}>{testMutation.isPending ? "Scheduling…" : "Start test call"}</Button></Grid>
          </Grid>
        </Box>
      </Stack>
    </SectionCard>
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
        {agents.isSuccess && <Box component="form" onSubmit={saveAgent}><Stack spacing={1.5}>
          {selectedAgent && agents.data.length > 1 && <FormControl size="small" fullWidth><InputLabel>Agent</InputLabel><Select label="Agent" value={selectedAgent.id} onChange={(event) => setAgentId(event.target.value)}>{agents.data.map((agent) => <MenuItem key={agent.id} value={agent.id}>{agent.name}</MenuItem>)}</Select></FormControl>}
          {!selectedAgent && <Alert severity="info">Create the first calling agent. Its language, voice, and dialect settings will be used for scheduled and test calls.</Alert>}
          {createAgentMutation.isError && <Alert severity="error">Could not create agent: {errorText(createAgentMutation.error)}</Alert>}
          <TextField label="Agent name" size="small" required value={agentName} onChange={(event) => setAgentName(event.target.value)} />
          <FormControl size="small" fullWidth><InputLabel>Language</InputLabel><Select label="Language" value={agentLanguage} onChange={(event) => changeAgentLanguage(event.target.value)}>{languageOptions.map((item) => <MenuItem key={item.code} value={item.code}>{item.name}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Voice</InputLabel><Select label="Voice" value={agentVoice} onChange={(event) => setAgentVoice(event.target.value)}>{voiceOptions.map((voice) => <MenuItem key={voice} value={voice}>{voice}</MenuItem>)}</Select></FormControl>
          <TextField label="Slang / dialect" size="small" required value={agentDialect} onChange={(event) => setAgentDialect(event.target.value)} helperText="For example: Madurai Tamil, casual Kerala Malayalam, or local Telugu." />
          <TextField label="Generated voice prompt" multiline minRows={3} value={promptPreview} InputProps={{ readOnly: true }} helperText="Updates automatically when you change the language or slang/dialect." />
          {mutation.isError && <Alert severity="error">Settings were not saved: {errorMessage}</Alert>}
          {mutation.isSuccess && <Alert severity="success">Agent settings saved.</Alert>}
          <Button type="submit" variant="contained" startIcon={(mutation.isPending || createAgentMutation.isPending) ? <CircularProgress size={16} color="inherit" /> : <SaveRoundedIcon />} disabled={mutation.isPending || createAgentMutation.isPending || !agentName.trim() || !agentDialect.trim()}>
            {mutation.isPending || createAgentMutation.isPending ? "Saving…" : selectedAgent ? "Save agent settings" : "Create calling agent"}
          </Button>
        </Stack></Box>}
      </SectionCard></Grid>
    </Grid>
    <SectionCard title="Scheduled retry queue" subtitle="Durable PostgreSQL jobs awaiting their next attempt.">
      {calls.isSuccess && retryQueue.length === 0 && <Typography variant="body2" color="text.secondary">No outbound call jobs are waiting.</Typography>}
      <Stack spacing={1}>{retryQueue.slice(0, 10).map((item) => <Stack key={item.jobId} direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={.5} sx={{ py: 1, borderTop: "1px solid #edf0f4" }}><Typography variant="body2" fontWeight={650}>{item.employee.name} · {item.patient.name}</Typography><Typography variant="caption" color="text.secondary">{item.stage.replaceAll("_", " ")} · attempt {item.attemptNumber} · scheduled {formatTime(item.runAt)}</Typography></Stack>)}</Stack>
    </SectionCard>
  </Stack>;
}
