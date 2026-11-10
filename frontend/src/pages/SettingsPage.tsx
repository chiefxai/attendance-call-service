import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, CardContent, CircularProgress, FormControlLabel, Grid, Stack, Switch, Tab, Tabs, TextField, Typography } from "@mui/material";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import SettingsPhoneRoundedIcon from "@mui/icons-material/SettingsPhoneRounded";
import { AxiosError } from "axios";
import { fetchCallingSettings, resetCallingSettings, saveCallingSettings, type CallingSettings } from "../api/client";
import { ApiAccessPage } from "./ApiAccessPage";
import { PageHeader } from "../components/OperationsUI";

type CallingForm = Omit<CallingSettings, "source">;
const emptySettings: CallingForm = {
  defaultFromNumber: "",
  allowNonPatientInboundCalls: false,
  retry: { maxConsecutiveNoAnswer: 5, initialMinutes: 5, multiplier: 1.2, maxMinutes: 30 },
};
const settingError = (error: unknown) => error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";

export function SettingsPage() {
  const [tab, setTab] = useState<"calling" | "api">("calling");
  const [form, setForm] = useState<CallingForm>(emptySettings);
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["calling-settings"], queryFn: fetchCallingSettings, retry: false });
  useEffect(() => {
    if (!settings.data) return;
    setForm({ defaultFromNumber: settings.data.defaultFromNumber, allowNonPatientInboundCalls: settings.data.allowNonPatientInboundCalls, retry: settings.data.retry });
  }, [settings.data]);

  const save = useMutation({
    mutationFn: saveCallingSettings,
    onSuccess: (data) => queryClient.setQueryData(["calling-settings"], data),
  });
  const reset = useMutation({
    mutationFn: resetCallingSettings,
    onSuccess: (data) => queryClient.setQueryData(["calling-settings"], data),
  });
  const updateRetry = (key: keyof CallingForm["retry"], value: string) => {
    const number = Number(value);
    setForm((current) => ({ ...current, retry: { ...current.retry, [key]: Number.isFinite(number) ? number : 0 } }));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(form);
  };

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="WORKSPACE CONFIGURATION" title="Settings" description="Manage the default caller ID, retry behavior, and API access for this workspace." />
    <Tabs value={tab} onChange={(_event, value: "calling" | "api") => setTab(value)} variant="scrollable" allowScrollButtonsMobile sx={{ borderBottom: 1, borderColor: "divider" }}>
      <Tab value="calling" label="Calling settings" icon={<SettingsPhoneRoundedIcon />} iconPosition="start" />
      <Tab value="api" label="API configuration" />
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
              control={<Switch checked={form.allowNonPatientInboundCalls} onChange={(_, checked) => setForm((current) => ({ ...current, allowNonPatientInboundCalls: checked }))} />}
              label={<Box><Typography fontWeight={650}>Allow non-patient incoming calls</Typography><Typography variant="body2" color="text.secondary">When enabled, answer calls from numbers that don’t match a registered patient. When disabled, reject them immediately.</Typography></Box>}
              sx={{ alignItems: "flex-start", m: 0, "& .MuiSwitch-root": { mr: 1 } }}
            />
          </Box>
          <Box><Typography variant="h6">No-answer retry policy</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>The retry delay grows exponentially and stops at the configured attempt limit. {settings.data.source.retry === "settings" ? "Workspace override is active." : "Values currently come from .env."}</Typography></Box>
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
    </Stack> : <ApiAccessPage section="settings" />}
  </Stack>;
}
