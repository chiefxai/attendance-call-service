import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, FormControl, FormControlLabel, Grid, InputLabel, MenuItem, Select, Stack, Switch, Tabs, Tab, TextField, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import { AxiosError } from "axios";
import { fetchAthulyaIntegration, fetchCallingSettings, fetchMockPlatformServerSettings, resetCallingSettings, saveAthulyaIntegration, saveCallingSettings, setMockPlatformServerEnabled, testAthulyaIntegration, type CallingSettings, type AthulyaIntegrationSettings } from "../api/client";
import { ApiAccessPage } from "./ApiAccessPage";
import { PageHeader } from "../components/OperationsUI";
import { formatAppDateTime } from "../utils/dateTime";

type CallingForm = Omit<CallingSettings, "source" | "webhookSecretConfigured" | "webhookSecretEnvironmentConfigured" | "webhookSecretSource">
  & { chiefvoiceWebhookSecret: string; clearChiefVoiceWebhookSecret: boolean };
type SyncScope = "all" | "branch" | "care_manager";
type IntegrationForm = Pick<AthulyaIntegrationSettings, "integrationName" | "apiBaseUrl" | "enabled" | "autoSyncEnabled" | "autoSyncScope" | "autoSyncScopeId"> & { apiKey: string };
const emptySettings: CallingForm = {
  defaultFromNumber: "",
  unansweredCallEscalation: "call_care_manager",
  lateScheduleGraceMinutes: 2,
  retry: { maxConsecutiveNoAnswer: 3, initialMinutes: 3, multiplier: 1.2, maxMinutes: 30 },
  chiefvoiceWebhookSecret: "",
  clearChiefVoiceWebhookSecret: false,
};
const settingError = (error: unknown) => error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";
export function SettingsPage({ section }: { section: "calling" | "api" | "athulya" }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<CallingForm>(emptySettings);
  const [integrationForm, setIntegrationForm] = useState<IntegrationForm>({ integrationName: "Athulya Platform", apiBaseUrl: "https://homecare.athulyaliving.net/api", enabled: false, autoSyncEnabled: false, autoSyncScope: "all", autoSyncScopeId: "", apiKey: "" });
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["calling-settings"], queryFn: fetchCallingSettings, retry: false });
  const integration = useQuery({ queryKey: ["athulya-integration"], queryFn: fetchAthulyaIntegration, enabled: section === "athulya", retry: false });
  const mockPlatform = useQuery({ queryKey: ["mock-platform-server"], queryFn: fetchMockPlatformServerSettings, enabled: section === "api" || section === "athulya", retry: false });

  useEffect(() => {
    if (!settings.data) return;
    setForm({ defaultFromNumber: settings.data.defaultFromNumber, unansweredCallEscalation: settings.data.unansweredCallEscalation, lateScheduleGraceMinutes: settings.data.lateScheduleGraceMinutes, retry: settings.data.retry, chiefvoiceWebhookSecret: "", clearChiefVoiceWebhookSecret: false });
  }, [settings.data]);
  useEffect(() => {
    if (integration.data) setIntegrationForm({ integrationName: integration.data.integrationName, apiBaseUrl: integration.data.apiBaseUrl, enabled: integration.data.enabled, autoSyncEnabled: integration.data.autoSyncEnabled, autoSyncScope: integration.data.autoSyncScope, autoSyncScopeId: integration.data.autoSyncScopeId, apiKey: "" });
  }, [integration.data]);


  const save = useMutation({
    mutationFn: saveCallingSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(["calling-settings"], data);
      setForm((current) => ({ ...current, chiefvoiceWebhookSecret: "", clearChiefVoiceWebhookSecret: false }));
    },
  });
  const reset = useMutation({
    mutationFn: resetCallingSettings,
    onSuccess: (data) => queryClient.setQueryData(["calling-settings"], data),
  });
  const saveIntegration = useMutation({ mutationFn: saveAthulyaIntegration, onSuccess: (data) => { queryClient.setQueryData(["athulya-integration"], data); setIntegrationForm((current) => ({ ...current, apiKey: "" })); } });
  const updateMockPlatform = useMutation({ mutationFn: setMockPlatformServerEnabled, onSuccess: (data) => queryClient.setQueryData(["mock-platform-server"], data) });
  const testIntegration = useMutation({ mutationFn: testAthulyaIntegration });
  const updateRetry = (key: keyof CallingForm["retry"], value: string) => {
    const number = Number(value);
    setForm((current) => ({ ...current, retry: { ...current.retry, [key]: Number.isFinite(number) ? number : 0 } }));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(form);
  };

  return <Stack spacing={2.5}>
    <PageHeader title="Settings"
      actions={<Tabs value={section} onChange={(_, value: "calling" | "api" | "athulya") => navigate(`/settings/${value}`)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile aria-label="Settings sections" sx={{ minHeight: 42, "& .MuiTab-root": { minHeight: 42, px: { xs: 1.25, sm: 2 }, fontSize: 13, fontWeight: 650, textTransform: "none" } }}>
        <Tab value="calling" label="Calling settings" />
        <Tab value="api" label="API configuration" />
        <Tab value="athulya" label="Athulya integration" />
      </Tabs>} />
    {section === "calling" ? <Stack spacing={2.5}>
      <Alert severity="info">
        Environment values in .env are the defaults. Saving here stores workspace overrides in PostgreSQL. Reset removes the overrides and returns to the environment defaults. Retry changes apply as calls finish; retries already queued keep their current scheduled time.
      </Alert>
      {settings.isLoading && <Box sx={{ display: "flex", justifyContent: "center", py: 5 }}><CircularProgress /></Box>}
      {settings.isError && <Alert severity="error">Could not load calling settings: {settingError(settings.error)}. Confirm this browser is connected with a valid service API key.</Alert>}
      {settings.data && <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack component="form" onSubmit={submit} spacing={2.5}>
          <Box><Typography variant="h6">Outbound caller ID</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>Used when an assignment does not provide its own fromNumber.</Typography></Box>
          <TextField
            fullWidth label="Default ChiefVoice caller ID" placeholder="+918071580130" value={form.defaultFromNumber}
            onChange={(event) => setForm((current) => ({ ...current, defaultFromNumber: event.target.value }))}
            helperText={settings.data.source.defaultFromNumber === "settings" ? "Workspace setting override · E.164 format" : "Using .env fallback · saving here overrides it"}
            inputProps={{ inputMode: "tel" }}
          />
          <Box><Typography variant="h6">ChiefVoice webhook signing secret</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>Used to verify incoming ChiefVoice callbacks. Workspace overrides are encrypted in the database and never displayed after saving.</Typography></Box>
          <TextField
            fullWidth type="password" label="Webhook signing secret" autoComplete="new-password"
            value={form.chiefvoiceWebhookSecret}
            onChange={(event) => setForm((current) => ({ ...current, chiefvoiceWebhookSecret: event.target.value, clearChiefVoiceWebhookSecret: false }))}
            placeholder={settings.data.webhookSecretSource === "settings" ? "Workspace override saved" : settings.data.webhookSecretSource === "environment" ? "Using .env secret" : "Enter a signing secret"}
            helperText={form.clearChiefVoiceWebhookSecret
              ? settings.data.webhookSecretEnvironmentConfigured
                ? "Saving will remove the workspace override and use the .env secret."
                : "No .env fallback is configured; saving will leave webhook verification without a secret."
              : settings.data.webhookSecretSource === "settings"
                ? "Workspace override active. Leave blank to keep it, or enter a new value to replace it."
                : settings.data.webhookSecretSource === "environment"
                  ? "Using .env fallback. Enter a value to override it for this workspace."
                  : "No secret is configured. Enter the signing secret or configure CHIEFVOICE_WEBHOOK_SECRET in .env."}
          />
          {settings.data.webhookSecretSource === "settings" && <Button
            variant="text" sx={{ alignSelf: "flex-start" }}
            onClick={() => setForm((current) => ({ ...current, chiefvoiceWebhookSecret: "", clearChiefVoiceWebhookSecret: !current.clearChiefVoiceWebhookSecret }))}
          >{form.clearChiefVoiceWebhookSecret ? "Keep workspace override" : "Use .env fallback"}</Button>}
          <TextField
            fullWidth type="number" label="Late schedule call window (minutes)" value={form.lateScheduleGraceMinutes}
            onChange={(event) => setForm((current) => ({ ...current, lateScheduleGraceMinutes: Number(event.target.value) }))}
            inputProps={{ min: 0, max: 30, step: 1 }}
            helperText={`${settings.data.source.lateScheduleGraceMinutes === "settings" ? "Workspace setting override" : "Using .env fallback"}. If sync runs after a scheduled time by this amount or less, the call starts immediately. Default is 2 minutes; 0 disables late calls.`}
          />
          <Box><Typography variant="h6">No-answer retry policy</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>The retry delay grows exponentially and stops at the configured attempt limit. {settings.data.source.retry === "settings" ? "Workspace override is active." : "Values currently come from .env."}</Typography></Box>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}><FormControl fullWidth size="small"><InputLabel id="unanswered-escalation-label">After unanswered calls</InputLabel><Select labelId="unanswered-escalation-label" label="After unanswered calls" value={form.unansweredCallEscalation} onChange={(event) => setForm((current) => ({ ...current, unansweredCallEscalation: event.target.value as CallingForm["unansweredCallEscalation"] }))}><MenuItem value="platform_notification">Notify care manager in this app</MenuItem><MenuItem value="call_care_manager">Call the care manager</MenuItem></Select></FormControl></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><Typography variant="body2" color="text.secondary" sx={{ pt: { sm: 1 } }}>After three unanswered calls, the assigned care manager is called by default. You can switch to an in-app notification.</Typography></Grid>
          </Grid>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth type="number" label="Maximum consecutive unanswered calls" value={form.retry.maxConsecutiveNoAnswer} onChange={(event) => updateRetry("maxConsecutiveNoAnswer", event.target.value)} inputProps={{ min: 1, max: 20, step: 1 }} helperText="Allowed range: 1–20 calls" /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth type="number" label="First retry delay (minutes)" value={form.retry.initialMinutes} onChange={(event) => updateRetry("initialMinutes", event.target.value)} inputProps={{ min: 1, max: 1440, step: 1 }} helperText="Allowed range: 1–1440 minutes" /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth type="number" label="Exponential backoff multiplier" value={form.retry.multiplier} onChange={(event) => updateRetry("multiplier", event.target.value)} inputProps={{ min: 1, max: 5, step: 0.1 }} helperText="For example, 1.2 increases each delay by 20%" /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth type="number" label="Maximum retry interval (minutes)" value={form.retry.maxMinutes} onChange={(event) => updateRetry("maxMinutes", event.target.value)} inputProps={{ min: form.retry.initialMinutes, max: 1440, step: 1 }} helperText="Must be at least the first retry delay" /></Grid>
          </Grid>
          {save.isError && <Alert severity="error">{settingError(save.error)}</Alert>}
          {save.isSuccess && <Alert severity="success">Calling settings saved.</Alert>}
          {reset.isError && <Alert severity="error">{settingError(reset.error)}</Alert>}
          {reset.isSuccess && <Alert severity="success">Workspace overrides cleared; environment defaults are active.</Alert>}
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} justifyContent="flex-end">
            <Button variant="outlined" startIcon={reset.isPending ? <CircularProgress size={16} /> : <RestartAltRoundedIcon />} disabled={reset.isPending || save.isPending} onClick={() => reset.mutate()}>Reset to .env defaults</Button>
            <Button type="submit" variant="contained" startIcon={save.isPending ? <CircularProgress size={16} color="inherit" /> : <SaveRoundedIcon />} disabled={save.isPending || reset.isPending}>Save calling settings</Button>
          </Stack>
        </Stack>
      </CardContent></Card>}
    </Stack> : section === "api" ? <Stack spacing={2.5}>
      <ApiAccessPage section="settings" />
      <Card><CardContent><Stack spacing={2}>
        <Typography variant="h6">Test platform server</Typography>
        <Typography variant="body2" color="text.secondary">When enabled, schedule imports and attendance submissions use the mock Athulya server. When disabled, they use the live Athulya URL and credentials saved below. Mock submissions clear when the mock service restarts.</Typography>
        {mockPlatform.isError && <Alert severity="error">Could not load test server settings: {settingError(mockPlatform.error)}</Alert>}
        {updateMockPlatform.isError && <Alert severity="error">Could not update the test server: {settingError(updateMockPlatform.error)}</Alert>}
        {!mockPlatform.data?.configured && <Alert severity="warning">Configure a long random ATHULYA_MOCK_API_KEY in the VM .env file, then redeploy before enabling this server.</Alert>}
        <Alert severity={mockPlatform.data?.enabled ? "warning" : "success"}>{mockPlatform.data?.enabled ? "Active route: Mock Athulya server. Schedule sync and attendance posts will not reach Athulya." : "Active route: Live Athulya API. Schedule sync and confirmed attendance posts use the saved Athulya configuration."}</Alert>
        <FormControlLabel
          label={mockPlatform.data?.enabled ? "Enabled" : "Disabled"}
          control={<Switch checked={mockPlatform.data?.enabled ?? false} disabled={!mockPlatform.data?.configured || mockPlatform.isLoading || updateMockPlatform.isPending}
            onChange={(_, enabled) => updateMockPlatform.mutate(enabled)} inputProps={{ "aria-label": "Enable test platform server" }} />}
        />
        {mockPlatform.data?.enabled && <>
          <Typography variant="subtitle2">Test API base URL</Typography>
          <Typography variant="body2" sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{window.location.origin}/api/call-service/test-platform</Typography>
          <Typography variant="body2" sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>GET /caremanager/clients · POST /check-in-out · GET /submissions</Typography>
          <Typography variant="caption" color="text.secondary">Send ATHULYA_MOCK_API_KEY in the x-api-key header. The app routes schedule syncs and attendance posts to the mock automatically while this switch is enabled.</Typography>
        </>}
      </Stack></CardContent></Card>
    </Stack> : <Stack spacing={2.5}>
      <Alert severity="info">Athulya credentials stay encrypted on the server. Every sync imports one selected service date only. Automatic sync runs at 12:00 AM and 12:00 PM for the configured scope. Confirmed check-in and check-out events are posted separately. {mockPlatform.data?.enabled ? "Test mode is active: both operations use the mock server; saved live credentials are preserved." : "Live mode is active: both operations use the saved Athulya URL and key."}</Alert>
      {integration.isLoading && <CircularProgress size={24} />}
      {integration.isError && <Alert severity="error">Could not load Athulya settings: {settingError(integration.error)}</Alert>}
      {integration.data && <Card><CardContent><Stack component="form" spacing={2} onSubmit={(event) => { event.preventDefault(); saveIntegration.mutate(integrationForm); }}>
        <Typography variant="h6">Athulya Platform connection</Typography>
        <Chip color={mockPlatform.data?.enabled ? "warning" : "success"} label={mockPlatform.data?.enabled ? "Using mock server" : "Using live Athulya API"} />
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}><Chip color={integration.data.enabled ? "success" : "default"} label={integration.data.enabled ? "Integration enabled" : "Integration disabled"} /><Typography variant="body2" color="text.secondary">Last successful schedule sync: {integration.data.lastSuccessfulScheduleSync ? formatAppDateTime(integration.data.lastSuccessfulScheduleSync) : "Never"}</Typography><Typography variant="body2" color="text.secondary">Last successful attendance submission: {integration.data.lastSuccessfulAttendanceSubmission ? formatAppDateTime(integration.data.lastSuccessfulAttendanceSubmission) : "No successful submission yet"}</Typography></Stack>
        <TextField label="Integration name" value={integrationForm.integrationName} onChange={(event) => setIntegrationForm({ ...integrationForm, integrationName: event.target.value })} />
        <TextField label="API Base URL" value={integrationForm.apiBaseUrl} onChange={(event) => setIntegrationForm({ ...integrationForm, apiBaseUrl: event.target.value })} helperText="Saved live URL; ignored while mock testing is enabled. The schedule endpoint is appended automatically." />
        <TextField label="API key" type="password" value={integrationForm.apiKey} onChange={(event) => setIntegrationForm({ ...integrationForm, apiKey: event.target.value })} placeholder={integration.data.keyConfigured ? integration.data.apiKeyMasked : "Enter Athulya API key"} helperText={integration.data.keyConfigured ? "A key is saved. Leave blank to keep it, or enter a new key to rotate it." : "Not configured"} />
        <FormControlLabel control={<Switch checked={integrationForm.enabled} onChange={(_, enabled) => setIntegrationForm({ ...integrationForm, enabled, autoSyncEnabled: enabled && integrationForm.autoSyncEnabled })} />} label="Enable schedule integration" />
        <Typography fontWeight={650}>Automatic sync scope</Typography>
        <Grid container spacing={1.5}>
          <Grid size={{ xs: 12, sm: 6 }}><FormControl fullWidth><InputLabel>Sync schedules for</InputLabel><Select label="Sync schedules for" value={integrationForm.autoSyncScope} onChange={(event) => setIntegrationForm({ ...integrationForm, autoSyncScope: event.target.value as SyncScope, autoSyncScopeId: "" })}><MenuItem value="all">Everyone · all branches and care managers</MenuItem><MenuItem value="branch">One branch only</MenuItem><MenuItem value="care_manager">One care manager only</MenuItem></Select></FormControl></Grid>
          {integrationForm.autoSyncScope !== "all" && <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label={integrationForm.autoSyncScope === "branch" ? "Branch ID" : "Care Manager ID"} value={integrationForm.autoSyncScopeId} onChange={(event) => setIntegrationForm({ ...integrationForm, autoSyncScopeId: event.target.value })} helperText="Only matching schedules will be requested; others are excluded." /></Grid>}
        </Grid>
        <FormControlLabel control={<Switch checked={integrationForm.autoSyncEnabled} disabled={(!integrationForm.enabled && !mockPlatform.data?.enabled) || (integrationForm.autoSyncScope !== "all" && !integrationForm.autoSyncScopeId.trim())} onChange={(_, autoSyncEnabled) => setIntegrationForm({ ...integrationForm, autoSyncEnabled })} />} label={<Box><Typography fontWeight={650}>Enable automatic sync</Typography><Typography variant="body2" color="text.secondary">Runs at 12:00 AM and 12:00 PM ({integration.data.autoSyncTimeZone}) for the selected scope. Manual sync is available while either live or mock mode is enabled.</Typography></Box>} />
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <Button type="submit" variant="contained" disabled={saveIntegration.isPending}>{saveIntegration.isPending ? "Saving…" : "Save configuration"}</Button>
          <Button variant="outlined" onClick={() => testIntegration.mutate({ apiBaseUrl: integrationForm.apiBaseUrl, apiKey: integrationForm.apiKey || undefined })} disabled={testIntegration.isPending || (!mockPlatform.data?.enabled && !integration.data.keyConfigured && !integrationForm.apiKey)}>{testIntegration.isPending ? "Testing…" : "Test connection"}</Button>
        </Stack>
        {saveIntegration.isError && <Alert severity="error">{settingError(saveIntegration.error)}</Alert>}
        {saveIntegration.isSuccess && <Alert severity="success">Athulya settings saved.</Alert>}
        {testIntegration.isError && <Alert severity="error">Connection test failed: {settingError(testIntegration.error)}</Alert>}
        {testIntegration.isSuccess && <Alert severity="success">Connected. Athulya returned {testIntegration.data.recordsReceived} schedule record(s) for {testIntegration.data.scheduleDate}.</Alert>}
      </Stack></CardContent></Card>}
    </Stack>}
  </Stack>;
}
