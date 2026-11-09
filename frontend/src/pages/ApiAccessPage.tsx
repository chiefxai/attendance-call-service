import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, CircularProgress, Grid, IconButton, Paper, Stack, TextField, Typography } from "@mui/material";
import KeyRoundedIcon from "@mui/icons-material/KeyRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import { AxiosError } from "axios";
import { createServiceApiKey, fetchServiceApiKeys, revokeServiceApiKey, type ServiceApiKey } from "../api/client";
import { PageHeader, SectionCard } from "../components/OperationsUI";

const example = [
  "curl -X POST https://calls.elvoryx.in/api/call-service/assignments \\",
  "  -H \"Authorization: Bearer <YOUR_API_KEY>\" \\",
  "  -H \"Content-Type: application/json\" \\",
  "  -d '{",
  '    "assignmentId": "SHIFT-2026-001",',
  '    "agentId": "<ACTIVE_AGENT_UUID>",',
  '    "language": "ta",',
  '    "scheduledStartAt": "2026-11-10T08:00:00+05:30",',
  '    "scheduledEndAt": "2026-11-10T20:00:00+05:30",',
  '    "employee": { "id": "STAFF-1001", "name": "Employee name", "phoneNumber": "+919876543210" },',
  '    "patient": { "id": "PATIENT-2001", "name": "Patient name", "address": "Client service address" }',
  "  }'",
].join("\n");
const date = (value: string) => new Date(value).toLocaleString();

function errorText(error: unknown) {
  return error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";
}

export function ApiAccessPage() {
  const [adminToken, setAdminToken] = useState("");
  const [label, setLabel] = useState("Athulya platform integration");
  const [revealedKey, setRevealedKey] = useState("");
  const [appKey, setAppKey] = useState(() => window.sessionStorage.getItem("attendance_api_key") || "");
  const keys = useQuery({
    queryKey: ["service-api-keys", Boolean(adminToken)],
    queryFn: () => fetchServiceApiKeys(adminToken),
    enabled: false,
    retry: false,
  });
  const createMutation = useMutation({
    mutationFn: (values: { label: string; token: string }) => createServiceApiKey(values.label, values.token),
    onSuccess: async (created) => {
      setRevealedKey(created.apiKey);
      window.sessionStorage.setItem("attendance_api_key", created.apiKey);
      setAppKey(created.apiKey);
      await keys.refetch();
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeServiceApiKey(id, adminToken),
    onSuccess: () => keys.refetch(),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adminToken.trim() || !label.trim()) return;
    createMutation.mutate({ label: label.trim(), token: adminToken.trim() });
  };
  const applyAppKey = () => {
    if (appKey.trim()) window.sessionStorage.setItem("attendance_api_key", appKey.trim());
  };
  const clearAppKey = () => {
    window.sessionStorage.removeItem("attendance_api_key");
    setAppKey("");
  };
  const copy = (value: string) => navigator.clipboard?.writeText(value);

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="PLATFORM INTEGRATION" title="API keys & docs" description="Create a scoped service key, connect this browser, and send duty assignments directly from your platform." />
    <Alert severity="info">The integration API schedules both check-in and check-out calls. Set API_KEY_ADMIN_TOKEN in the VM .env (generate one with openssl rand -hex 32) and restart the backend. Keys are shown once, stored as hashes on the service, and can be revoked here. Keep the admin secret and API keys server-side in your platform.</Alert>

    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 5 }}>
        <SectionCard title="API key management" subtitle="Enter the admin secret configured as API_KEY_ADMIN_TOKEN on the service VM.">
          <Stack component="form" onSubmit={submit} spacing={1.5}>
            <TextField fullWidth size="small" type="password" label="API key admin secret" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} autoComplete="off" />
            <TextField fullWidth size="small" label="Key label" value={label} onChange={(event) => setLabel(event.target.value)} />
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}><Button type="button" variant="outlined" onClick={() => keys.refetch()} disabled={!adminToken.trim() || keys.isFetching}>Load keys</Button><Button type="submit" variant="contained" startIcon={createMutation.isPending ? <CircularProgress size={16} color="inherit" /> : <KeyRoundedIcon />} disabled={!adminToken.trim() || !label.trim() || createMutation.isPending}>Create API key</Button></Stack>
            {createMutation.isError && <Alert severity="error">{errorText(createMutation.error)}</Alert>}
            {keys.isError && <Alert severity="error">Could not load key list: {errorText(keys.error)}</Alert>}
          </Stack>
          {revealedKey && <Alert severity="success" sx={{ mt: 2 }} action={<IconButton aria-label="Copy API key" onClick={() => copy(revealedKey)}><ContentCopyRoundedIcon /></IconButton>}>
            <Typography variant="body2" fontWeight={700}>New key (shown once)</Typography>
            <Box component="code" sx={{ display: "block", mt: .7, overflowWrap: "anywhere" }}>{revealedKey}</Box>
            <Button size="small" sx={{ mt: 1 }} onClick={() => setRevealedKey("")}>Hide key</Button>
          </Alert>}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" fontWeight={750}>Connect this browser</Typography>
            <Typography variant="caption" color="text.secondary">The key is kept in this tab session and sent as a Bearer token.</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
              <TextField fullWidth size="small" type="password" label="Service API key" value={appKey} onChange={(event) => setAppKey(event.target.value)} />
              <Button variant="outlined" onClick={applyAppKey} disabled={!appKey.trim()}>Connect</Button>
              <Button color="inherit" onClick={clearAppKey}>Clear</Button>
            </Stack>
            {window.sessionStorage.getItem("attendance_api_key") && <Chip size="small" color="success" icon={<CheckCircleRoundedIcon />} label="Browser connected" sx={{ mt: 1 }} />}
          </Box>
        </SectionCard>
      </Grid>

      <Grid size={{ xs: 12, lg: 7 }}>
        <SectionCard title="Issued keys" subtitle="Only labels, prefixes, and use timestamps are retained after key creation.">
          {keys.data?.length ? <Stack spacing={1}>{keys.data.map((key: ServiceApiKey) => <Card key={key.id} variant="outlined" sx={{ p: 1.5, boxShadow: "none" }}>
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <KeyRoundedIcon color="action" />
              <Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="body2" fontWeight={700}>{key.label}</Typography><Typography variant="caption" color="text.secondary">{key.prefix}… · created {date(key.createdAt)} · {key.lastUsedAt ? "last used " + date(key.lastUsedAt) : "not used yet"}</Typography></Box>
              {key.revokedAt ? <Chip size="small" label="Revoked" /> : <Button color="error" size="small" startIcon={<DeleteOutlineRoundedIcon />} onClick={() => revokeMutation.mutate(key.id)} disabled={revokeMutation.isPending}>Revoke</Button>}
            </Stack>
          </Card>)}</Stack> : <Typography variant="body2" color="text.secondary">{adminToken ? "No API keys have been created yet." : "Enter the admin secret to load keys."}</Typography>}
        </SectionCard>
      </Grid>
    </Grid>

    <SectionCard title="Create an assignment from your platform" subtitle="POST an assignment payload. A 202 response returns the durable session ID; the service schedules both stages and retries asynchronously.">
      <Stack spacing={1.5}>
        <Typography variant="body2">Endpoint: <Box component="code">POST /api/call-service/assignments</Box></Typography>
        <Typography variant="body2">Headers: <Box component="code">Authorization: Bearer &lt;API_KEY&gt;</Box> and <Box component="code">Content-Type: application/json</Box>.</Typography>
        <Typography variant="body2">Agent setup: <Box component="code">GET /api/call-service/agents</Box> lists agents and IDs; create one in Call Center or use <Box component="code">POST /api/call-service/agents</Box>.</Typography>
        <Paper variant="outlined" sx={{ position: "relative", p: 1.5, bgcolor: "#f7f9fc", overflow: "auto" }}>
          <IconButton size="small" aria-label="Copy API example" onClick={() => copy(example)} sx={{ position: "absolute", right: 8, top: 8, zIndex: 1 }}><ContentCopyRoundedIcon fontSize="small" /></IconButton>
          <Box component="pre" sx={{ m: 0, pr: 5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{example}</Box>
        </Paper>
        <Typography variant="body2">Accepted response: <Box component="code">202</Box> with <Box component="code">sessionId</Box>, status, and queued check-in/check-out stages. Staff and patient records are created from the assignment details.</Typography>
        <Typography variant="caption" color="text.secondary">Use the active agent UUID from the Agents endpoint. Times must include a timezone. Replace example IDs and phone numbers with your platform data. Store API keys in your backend secret manager and never put them in mobile or browser code.</Typography>
      </Stack>
    </SectionCard>
  </Stack>;
}
