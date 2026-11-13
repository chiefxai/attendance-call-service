import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, FormControl, FormControlLabel, Grid, InputLabel, MenuItem, Select, Stack, Switch, Tab, Tabs, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import SettingsPhoneRoundedIcon from "@mui/icons-material/SettingsPhoneRounded";
import { AxiosError } from "axios";
import { fetchAthulyaAttendanceSubmissions, fetchAthulyaIntegration, fetchAthulyaSchedules, fetchAthulyaSyncRuns, fetchCallingSettings, resetCallingSettings, saveAthulyaIntegration, saveCallingSettings, startAthulyaSync, testAthulyaIntegration, type CallingSettings, type AthulyaIntegrationSettings } from "../api/client";
import { ApiAccessPage } from "./ApiAccessPage";
import { PageHeader } from "../components/OperationsUI";

type CallingForm = Omit<CallingSettings, "source">;
type SyncScope = "all" | "branch" | "care_manager";
type IntegrationForm = Pick<AthulyaIntegrationSettings, "integrationName" | "apiBaseUrl" | "enabled" | "autoSyncEnabled" | "autoSyncScope" | "autoSyncScopeId"> & { apiKey: string };
const emptySettings: CallingForm = {
  defaultFromNumber: "",
  allowInboundCalls: true,
  allowNonPatientInboundCalls: false,
  requireHumanVerificationForStaffBooking: false,
  unansweredCallEscalation: "platform_notification",
  retry: { maxConsecutiveNoAnswer: 3, initialMinutes: 5, multiplier: 1.2, maxMinutes: 30 },
};
const settingError = (error: unknown) => error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";
const dateInTimeZone = (timeZone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export function SettingsPage() {
  const [tab, setTab] = useState<"calling" | "api" | "athulya">("calling");
  const [form, setForm] = useState<CallingForm>(emptySettings);
  const [integrationForm, setIntegrationForm] = useState<IntegrationForm>({ integrationName: "Athulya Platform", apiBaseUrl: "https://homecare.athulyaliving.net/api", enabled: false, autoSyncEnabled: false, autoSyncScope: "all", autoSyncScopeId: "", apiKey: "" });
  const [syncFilters, setSyncFilters] = useState({ scheduleDate: "", scope: "all" as SyncScope, scopeId: "" });
  const [submissionFilters, setSubmissionFilters] = useState({ eventType: "all", status: "all", fromDate: "", toDate: "", caregiverId: "", patientId: "" });
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["calling-settings"], queryFn: fetchCallingSettings, retry: false });
  const integration = useQuery({ queryKey: ["athulya-integration"], queryFn: fetchAthulyaIntegration, enabled: tab === "athulya", retry: false });
  const syncRuns = useQuery({ queryKey: ["athulya-sync-runs"], queryFn: fetchAthulyaSyncRuns, enabled: tab === "athulya", refetchInterval: 5000, retry: false });
  const attendanceSubmissions = useQuery({ queryKey: ["athulya-attendance-submissions", submissionFilters], queryFn: () => fetchAthulyaAttendanceSubmissions({ ...submissionFilters, eventType: submissionFilters.eventType === "all" ? undefined : submissionFilters.eventType, status: submissionFilters.status === "all" ? undefined : submissionFilters.status, fromDate: submissionFilters.fromDate || undefined, toDate: submissionFilters.toDate || undefined, caregiverId: submissionFilters.caregiverId || undefined, patientId: submissionFilters.patientId || undefined }), enabled: tab === "athulya", refetchInterval: 5000, retry: false });
  const schedules = useQuery({ queryKey: ["athulya-schedules", syncFilters.scheduleDate], queryFn: () => fetchAthulyaSchedules({ fromDate: syncFilters.scheduleDate || undefined, toDate: syncFilters.scheduleDate || undefined }), enabled: tab === "athulya", retry: false });
  useEffect(() => {
    if (!settings.data) return;
    setForm({ defaultFromNumber: settings.data.defaultFromNumber, allowInboundCalls: settings.data.allowInboundCalls, allowNonPatientInboundCalls: settings.data.allowNonPatientInboundCalls, requireHumanVerificationForStaffBooking: settings.data.requireHumanVerificationForStaffBooking, unansweredCallEscalation: settings.data.unansweredCallEscalation, retry: settings.data.retry });
  }, [settings.data]);
  useEffect(() => {
    if (integration.data) setIntegrationForm({ integrationName: integration.data.integrationName, apiBaseUrl: integration.data.apiBaseUrl, enabled: integration.data.enabled, autoSyncEnabled: integration.data.autoSyncEnabled, autoSyncScope: integration.data.autoSyncScope, autoSyncScopeId: integration.data.autoSyncScopeId, apiKey: "" });
  }, [integration.data]);
  useEffect(() => {
    const timeZone = integration.data?.autoSyncTimeZone;
    if (!timeZone) return;
    setSyncFilters((current) => current.scheduleDate ? current : { ...current, scheduleDate: dateInTimeZone(timeZone) });
  }, [integration.data?.autoSyncTimeZone]);

  const save = useMutation({
    mutationFn: saveCallingSettings,
    onSuccess: (data) => queryClient.setQueryData(["calling-settings"], data),
  });
  const reset = useMutation({
    mutationFn: resetCallingSettings,
    onSuccess: (data) => queryClient.setQueryData(["calling-settings"], data),
  });
  const saveIntegration = useMutation({ mutationFn: saveAthulyaIntegration, onSuccess: (data) => { queryClient.setQueryData(["athulya-integration"], data); setIntegrationForm((current) => ({ ...current, apiKey: "" })); } });
  const testIntegration = useMutation({ mutationFn: testAthulyaIntegration });
  const syncIntegration = useMutation({ mutationFn: startAthulyaSync, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["athulya-sync-runs"] }); } });
  const updateRetry = (key: keyof CallingForm["retry"], value: string) => {
    const number = Number(value);
    setForm((current) => ({ ...current, retry: { ...current.retry, [key]: Number.isFinite(number) ? number : 0 } }));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(form);
  };

  return <Stack spacing={2.5}>
    <PageHeader title="Settings" />
    <Tabs value={tab} onChange={(_event, value: "calling" | "api" | "athulya") => setTab(value)} variant="scrollable" allowScrollButtonsMobile sx={{ borderBottom: 1, borderColor: "divider" }}>
      <Tab value="calling" label="Calling settings" icon={<SettingsPhoneRoundedIcon />} iconPosition="start" />
      <Tab value="api" label="API configuration" />
      <Tab value="athulya" label="Athulya integration" />
    </Tabs>
    {tab === "calling" ? <Stack spacing={2.5}>
      <Alert severity="info">
        Environment values in .env are the defaults. Saving here stores workspace overrides in PostgreSQL. Reset removes the overrides and returns to the environment defaults. Retry changes apply as calls finish; retries already queued keep their current scheduled time.
      </Alert>
      {settings.isLoading && <Box sx={{ display: "flex", justifyContent: "center", py: 5 }}><CircularProgress /></Box>}
      {settings.isError && <Alert severity="error">Could not load calling settings: {settingError(settings.error)}. Confirm this browser is connected with a valid service API key.</Alert>}
      {settings.data && <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack component="form" onSubmit={submit} spacing={2.5}>
          <Box><Typography variant="h6">Outbound caller ID</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>Used when an assignment does not provide its own fromNumber.</Typography></Box>
          <TextField
            fullWidth label="Default Vobiz phone number" placeholder="+918071580130" value={form.defaultFromNumber}
            onChange={(event) => setForm((current) => ({ ...current, defaultFromNumber: event.target.value }))}
            helperText={settings.data.source.defaultFromNumber === "settings" ? "Workspace setting override · E.164 format" : "Using .env fallback · saving here overrides it"}
            inputProps={{ inputMode: "tel" }}
          />
          <Box sx={{ p: 2, border: "1px solid", borderColor: "divider", borderRadius: 2 }}>
            <FormControlLabel
              control={<Switch checked={form.allowInboundCalls} onChange={(_, checked) => setForm((current) => ({ ...current, allowInboundCalls: checked }))} />}
              label={<Box><Typography fontWeight={650}>Allow incoming calls</Typography><Typography variant="body2" color="text.secondary">When disabled, reject all inbound calls, including calls from registered patients. Outbound attendance and staff availability calls are unaffected.</Typography></Box>}
              sx={{ alignItems: "flex-start", m: 0, "& .MuiSwitch-root": { mr: 1 } }}
            />
          </Box>
          <Box sx={{ p: 2, border: "1px solid", borderColor: "divider", borderRadius: 2 }}>
            <FormControlLabel
              control={<Switch checked={form.allowNonPatientInboundCalls} disabled={!form.allowInboundCalls} onChange={(_, checked) => setForm((current) => ({ ...current, allowNonPatientInboundCalls: checked }))} />}
              label={<Box><Typography fontWeight={650}>Allow non-patient incoming calls</Typography><Typography variant="body2" color="text.secondary">When enabled, answer calls from numbers that don’t match a registered patient. When disabled, reject them immediately.</Typography></Box>}
              sx={{ alignItems: "flex-start", m: 0, "& .MuiSwitch-root": { mr: 1 } }}
            />
          </Box>
          <Box sx={{ p: 2, border: "1px solid", borderColor: "divider", borderRadius: 2 }}>
            <FormControlLabel
              control={<Switch checked={form.requireHumanVerificationForStaffBooking} onChange={(_, checked) => setForm((current) => ({ ...current, requireHumanVerificationForStaffBooking: checked }))} />}
              label={<Box><Typography fontWeight={650}>Require human verification for staff booking</Typography><Typography variant="body2" color="text.secondary">When enabled, the system shows suggested staff for a person to review and assign. When disabled, the booking agent calls suggested staff in order and schedules attendance after the first clear acceptance. Cases with no available staff or unclear confirmation still need human review.</Typography></Box>}
              sx={{ alignItems: "flex-start", m: 0, "& .MuiSwitch-root": { mr: 1 } }}
            />
          </Box>
          <Box><Typography variant="h6">No-answer retry policy</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>The retry delay grows exponentially and stops at the configured attempt limit. {settings.data.source.retry === "settings" ? "Workspace override is active." : "Values currently come from .env."}</Typography></Box>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}><FormControl fullWidth size="small"><InputLabel id="unanswered-escalation-label">After unanswered calls</InputLabel><Select labelId="unanswered-escalation-label" label="After unanswered calls" value={form.unansweredCallEscalation} onChange={(event) => setForm((current) => ({ ...current, unansweredCallEscalation: event.target.value as CallingForm["unansweredCallEscalation"] }))}><MenuItem value="platform_notification">Notify care manager in this app</MenuItem><MenuItem value="call_care_manager">Call the care manager</MenuItem></Select></FormControl></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><Typography variant="body2" color="text.secondary" sx={{ pt: { sm: 1 } }}>The assigned care manager is matched from the patient’s Athulya schedule. The default is an in-app notification.</Typography></Grid>
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
    </Stack> : tab === "api" ? <ApiAccessPage section="settings" /> : <Stack spacing={2.5}>
      <Alert severity="info">Athulya credentials stay encrypted on the server. Every sync imports one selected service date only. Automatic sync runs at 12:00 AM and 12:00 PM for the configured scope. Confirmed check-in and check-out events are posted separately. Use the local mock platform in development to validate schedule fetching and attendance POSTs safely.</Alert>
      {integration.isLoading && <CircularProgress size={24} />}
      {integration.isError && <Alert severity="error">Could not load Athulya settings: {settingError(integration.error)}</Alert>}
      {integration.data && <Card><CardContent><Stack component="form" spacing={2} onSubmit={(event) => { event.preventDefault(); saveIntegration.mutate(integrationForm); }}>
        <Typography variant="h6">Athulya Platform connection</Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}><Chip color={integration.data.enabled ? "success" : "default"} label={integration.data.enabled ? "Integration enabled" : "Integration disabled"} /><Typography variant="body2" color="text.secondary">Last successful schedule sync: {integration.data.lastSuccessfulScheduleSync ? new Date(integration.data.lastSuccessfulScheduleSync).toLocaleString() : "Never"}</Typography><Typography variant="body2" color="text.secondary">Last successful attendance submission: {integration.data.lastSuccessfulAttendanceSubmission ? new Date(integration.data.lastSuccessfulAttendanceSubmission).toLocaleString() : "No successful submission yet"}</Typography></Stack>
        <TextField label="Integration name" value={integrationForm.integrationName} onChange={(event) => setIntegrationForm({ ...integrationForm, integrationName: event.target.value })} />
        <TextField label="API Base URL" value={integrationForm.apiBaseUrl} onChange={(event) => setIntegrationForm({ ...integrationForm, apiBaseUrl: event.target.value })} helperText="Use the Athulya HTTPS host, or the local mock URL when mock testing is enabled. The schedule endpoint is appended automatically." />
        <TextField label="API key" type="password" value={integrationForm.apiKey} onChange={(event) => setIntegrationForm({ ...integrationForm, apiKey: event.target.value })} placeholder={integration.data.keyConfigured ? integration.data.apiKeyMasked : "Enter Athulya API key"} helperText={integration.data.keyConfigured ? "A key is saved. Leave blank to keep it, or enter a new key to rotate it." : "Not configured"} />
        <FormControlLabel control={<Switch checked={integrationForm.enabled} onChange={(_, enabled) => setIntegrationForm({ ...integrationForm, enabled, autoSyncEnabled: enabled && integrationForm.autoSyncEnabled })} />} label="Enable schedule integration" />
        <Typography fontWeight={650}>Automatic sync scope</Typography>
        <Grid container spacing={1.5}>
          <Grid size={{ xs: 12, sm: 6 }}><FormControl fullWidth><InputLabel>Sync schedules for</InputLabel><Select label="Sync schedules for" value={integrationForm.autoSyncScope} onChange={(event) => setIntegrationForm({ ...integrationForm, autoSyncScope: event.target.value as SyncScope, autoSyncScopeId: "" })}><MenuItem value="all">Everyone · all branches and care managers</MenuItem><MenuItem value="branch">One branch only</MenuItem><MenuItem value="care_manager">One care manager only</MenuItem></Select></FormControl></Grid>
          {integrationForm.autoSyncScope !== "all" && <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label={integrationForm.autoSyncScope === "branch" ? "Branch ID" : "Care Manager ID"} value={integrationForm.autoSyncScopeId} onChange={(event) => setIntegrationForm({ ...integrationForm, autoSyncScopeId: event.target.value })} helperText="Only matching schedules will be requested; others are excluded." /></Grid>}
        </Grid>
        <FormControlLabel control={<Switch checked={integrationForm.autoSyncEnabled} disabled={!integrationForm.enabled || (integrationForm.autoSyncScope !== "all" && !integrationForm.autoSyncScopeId.trim())} onChange={(_, autoSyncEnabled) => setIntegrationForm({ ...integrationForm, autoSyncEnabled })} />} label={<Box><Typography fontWeight={650}>Enable automatic sync</Typography><Typography variant="body2" color="text.secondary">Runs at 12:00 AM and 12:00 PM ({integration.data.autoSyncTimeZone}) for the selected scope. Manual sync remains available while the integration is enabled.</Typography></Box>} />
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <Button type="submit" variant="contained" disabled={saveIntegration.isPending}>{saveIntegration.isPending ? "Saving…" : "Save configuration"}</Button>
          <Button variant="outlined" onClick={() => testIntegration.mutate({ apiBaseUrl: integrationForm.apiBaseUrl, apiKey: integrationForm.apiKey || undefined })} disabled={testIntegration.isPending || (!integration.data.keyConfigured && !integrationForm.apiKey)}>{testIntegration.isPending ? "Testing…" : "Test connection"}</Button>
        </Stack>
        {saveIntegration.isError && <Alert severity="error">{settingError(saveIntegration.error)}</Alert>}
        {saveIntegration.isSuccess && <Alert severity="success">Athulya settings saved.</Alert>}
        {testIntegration.isError && <Alert severity="error">Connection test failed: {settingError(testIntegration.error)}</Alert>}
        {testIntegration.isSuccess && <Alert severity="success">Connected. Athulya returned {testIntegration.data.recordsReceived} schedule record(s) for {testIntegration.data.scheduleDate}.</Alert>}
      </Stack></CardContent></Card>}
      <Card><CardContent><Stack spacing={2}>
        <Typography variant="h6">Synchronise schedules</Typography>
        <Typography variant="body2" color="text.secondary">Each sync imports schedules for one selected service date only. That date covers midnight to the following midnight in {integration.data?.autoSyncTimeZone || "Asia/Kolkata"}.</Typography>
        <Grid container spacing={1.5}>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}><TextField fullWidth required type="date" label="Schedule date" InputLabelProps={{ shrink: true }} value={syncFilters.scheduleDate} onChange={(e) => setSyncFilters({ ...syncFilters, scheduleDate: e.target.value })} /></Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}><FormControl fullWidth><InputLabel>Manual sync scope</InputLabel><Select label="Manual sync scope" value={syncFilters.scope} onChange={(event) => setSyncFilters({ ...syncFilters, scope: event.target.value as SyncScope, scopeId: "" })}><MenuItem value="all">Everyone · all branches and care managers</MenuItem><MenuItem value="branch">One branch only</MenuItem><MenuItem value="care_manager">One care manager only</MenuItem></Select></FormControl></Grid>
          {syncFilters.scope !== "all" && <Grid size={{ xs: 12, sm: 6, md: 4 }}><TextField fullWidth label={syncFilters.scope === "branch" ? "Branch ID" : "Care Manager ID"} value={syncFilters.scopeId} onChange={(e) => setSyncFilters({ ...syncFilters, scopeId: e.target.value })} helperText="Only this selection is included" /></Grid>}
        </Grid>
        <Button variant="contained" disabled={!integration.data?.enabled || !syncFilters.scheduleDate || syncIntegration.isPending || (syncFilters.scope !== "all" && !syncFilters.scopeId.trim())} onClick={() => syncIntegration.mutate({ scheduleDate: syncFilters.scheduleDate, careManagerId: syncFilters.scope === "care_manager" ? syncFilters.scopeId.trim() : undefined, branchId: syncFilters.scope === "branch" ? syncFilters.scopeId.trim() : undefined })}>{syncIntegration.isPending ? "Starting…" : "Sync schedules now"}</Button>
        {syncIntegration.isError && <Alert severity="error">Could not start sync: {settingError(syncIntegration.error)}</Alert>}
        {syncIntegration.isSuccess && <Alert severity="success">Schedule sync started. The activity log refreshes automatically.</Alert>}
        {syncRuns.isError && <Alert severity="error">Could not load sync history: {settingError(syncRuns.error)}</Alert>}
        <TableContainer><Table size="small"><TableHead><TableRow><TableCell>Started</TableCell><TableCell>Type</TableCell><TableCell>Scope</TableCell><TableCell>Schedule date</TableCell><TableCell>Status</TableCell><TableCell>Received</TableCell><TableCell>Saved</TableCell><TableCell>Error</TableCell></TableRow></TableHead><TableBody>
          {syncRuns.data?.map((run) => <TableRow key={run.id}><TableCell>{new Date(run.startedAt).toLocaleString()}</TableCell><TableCell>{run.syncSource === "automatic" ? "Automatic" : "Manual"}</TableCell><TableCell>{run.syncScope === "branch" ? `Branch ${run.syncScopeId}` : run.syncScope === "care_manager" ? `Care Manager ${run.syncScopeId}` : "Everyone"}</TableCell><TableCell>{run.fromDate && run.fromDate === run.toDate ? run.fromDate : `${run.fromDate || "—"} – ${run.toDate || "—"}`}</TableCell><TableCell>{run.status}</TableCell><TableCell>{run.recordsReceived}</TableCell><TableCell>{run.recordsUpserted}</TableCell><TableCell>{run.errorMessage || "—"}</TableCell></TableRow>)}
          {syncRuns.data?.length === 0 && <TableRow><TableCell colSpan={8} align="center">No sync history yet.</TableCell></TableRow>}
        </TableBody></Table></TableContainer>
      </Stack></CardContent></Card>
      <Card><CardContent><Stack spacing={1.5}><Typography variant="h6">Attendance submission status</Typography><Typography variant="body2" color="text.secondary">Confirmed check-in and check-out events for imported schedules are sent to Athulya separately. Failed requests retry automatically; unmatched schedules remain available in local history.</Typography>
        <Grid container spacing={1.25}>
          <Grid size={{ xs: 12, sm: 6, md: 2 }}><FormControl fullWidth size="small"><InputLabel>Event</InputLabel><Select label="Event" value={submissionFilters.eventType} onChange={(e) => setSubmissionFilters({ ...submissionFilters, eventType: e.target.value })}><MenuItem value="all">All events</MenuItem><MenuItem value="check_in">Check-in</MenuItem><MenuItem value="check_out">Check-out</MenuItem></Select></FormControl></Grid>
          <Grid size={{ xs: 12, sm: 6, md: 3 }}><FormControl fullWidth size="small"><InputLabel>Status</InputLabel><Select label="Status" value={submissionFilters.status} onChange={(e) => setSubmissionFilters({ ...submissionFilters, status: e.target.value })}><MenuItem value="all">All statuses</MenuItem><MenuItem value="pending">Pending</MenuItem><MenuItem value="processing">Processing</MenuItem><MenuItem value="retry_scheduled">Retry scheduled</MenuItem><MenuItem value="failed">Failed</MenuItem><MenuItem value="synced">Synced</MenuItem><MenuItem value="awaiting_api_specification">Legacy awaiting status</MenuItem></Select></FormControl></Grid>
          <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth type="date" label="From" InputLabelProps={{ shrink: true }} value={submissionFilters.fromDate} onChange={(e) => setSubmissionFilters({ ...submissionFilters, fromDate: e.target.value })} /></Grid>
          <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth type="date" label="To" InputLabelProps={{ shrink: true }} value={submissionFilters.toDate} onChange={(e) => setSubmissionFilters({ ...submissionFilters, toDate: e.target.value })} /></Grid>
          <Grid size={{ xs: 12, sm: 6, md: 3 }}><TextField fullWidth label="Caregiver ID" value={submissionFilters.caregiverId} onChange={(e) => setSubmissionFilters({ ...submissionFilters, caregiverId: e.target.value })} /></Grid>
          <Grid size={{ xs: 12, sm: 6, md: 3 }}><TextField fullWidth label="Patient ID" value={submissionFilters.patientId} onChange={(e) => setSubmissionFilters({ ...submissionFilters, patientId: e.target.value })} /></Grid>
        </Grid>
        {attendanceSubmissions.isError && <Alert severity="error">Could not load attendance event history: {settingError(attendanceSubmissions.error)}</Alert>}<TableContainer><Table size="small"><TableHead><TableRow><TableCell>Event time</TableCell><TableCell>Event</TableCell><TableCell>Patient</TableCell><TableCell>Caregiver</TableCell><TableCell>Schedule</TableCell><TableCell>Status</TableCell><TableCell>Attempts</TableCell></TableRow></TableHead><TableBody>{attendanceSubmissions.data?.map((event) => <TableRow key={event.id}><TableCell>{new Date(event.eventAt).toLocaleString()}</TableCell><TableCell>{event.eventType === "check_in" ? "Check-in" : "Check-out"}</TableCell><TableCell>{event.patientName || "—"}</TableCell><TableCell>{event.caregiverName || "—"}</TableCell><TableCell>{event.scheduleId || "—"}</TableCell><TableCell>{event.status === "awaiting_api_specification" ? "Awaiting API specification" : event.status}</TableCell><TableCell>{event.retryCount}</TableCell></TableRow>)}{attendanceSubmissions.data?.length === 0 && <TableRow><TableCell colSpan={7} align="center">No linked attendance events yet.</TableCell></TableRow>}</TableBody></Table></TableContainer></Stack></CardContent></Card>
      <Card><CardContent><Stack spacing={1.5}><Typography variant="h6">Imported schedules</Typography>{schedules.isError && <Alert severity="error">Could not load imported schedules: {settingError(schedules.error)}</Alert>}<TableContainer><Table size="small"><TableHead><TableRow><TableCell>Date</TableCell><TableCell>Patient</TableCell><TableCell>Patient ID / UHID</TableCell><TableCell>Caregivers</TableCell><TableCell>Time</TableCell><TableCell>Branch</TableCell><TableCell>Status</TableCell></TableRow></TableHead><TableBody>{schedules.data?.map((schedule) => <TableRow key={schedule.id}><TableCell>{schedule.date || "—"}</TableCell><TableCell>{schedule.patient.name || "—"}</TableCell><TableCell>{schedule.patient.id || "—"} / {schedule.patient.uhid || "—"}</TableCell><TableCell>{schedule.caregivers.map((person) => person.name || person.phone).join(", ") || "—"}</TableCell><TableCell>{schedule.startTime || "—"} – {schedule.endTime || "—"}</TableCell><TableCell>{schedule.branch || "—"}</TableCell><TableCell>{schedule.status || "—"}</TableCell></TableRow>)}{schedules.data?.length === 0 && <TableRow><TableCell colSpan={7} align="center">No imported schedules in this range.</TableCell></TableRow>}</TableBody></Table></TableContainer></Stack></CardContent></Card>
    </Stack>}
  </Stack>;
}
