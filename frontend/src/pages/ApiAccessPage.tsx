import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, CircularProgress, Grid, IconButton, Paper, Stack, TextField, Typography } from "@mui/material";
import KeyRoundedIcon from "@mui/icons-material/KeyRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
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
const sessionArtifactsExample = [
  "curl -X GET https://calls.elvoryx.in/api/call-service/assignments/<SESSION_ID>/artifacts \\",
  "  -H \"Authorization: Bearer <YOUR_API_KEY>\"",
].join("\n");
const recordingExample = [
  "curl -L https://calls.elvoryx.in/api/call-service/assignments/<SESSION_ID>/recordings/<ATTEMPT_ID> \\",
  "  -H \"Authorization: Bearer <YOUR_API_KEY>\" \\",
  "  --output call-recording.wav",
].join("\n");
const completionPayloadExample = [
  "{",
  '  "session": { "id": "<SESSION_ID>", "assignmentId": "SHIFT-2026-001", "sessionStatus": "completed", "checkInStatus": "confirmed", "checkOutStatus": "confirmed" },',
  '  "callAttempts": [{ "id": "<ATTEMPT_ID>", "stage": "check_in", "status": "completed", "durationSeconds": 42 }],',
  '  "transcripts": [{ "callAttemptId": "<ATTEMPT_ID>", "language": "ta", "text": "...", "extraction": { "employeeIntent": "arrived" } }]',
  "}",
].join("\n");
const callbackEnvironment = [
  "ATTENDANCE_BACKEND_URL=https://platform.example.com/api/attendance/call-completed",
  "ATTENDANCE_BACKEND_TOKEN=replace-with-platform-bearer-token",
  "ATTENDANCE_BACKEND_TIMEOUT_MS=15000",
].join("\n");
const date = (value: string) => new Date(value).toLocaleString();

function errorText(error: unknown) {
  return error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";
}

export function ApiAccessPage({ section = "docs" }: { section?: "settings" | "docs" }) {
  const [label, setLabel] = useState("Athulya platform integration");
  const [revealedKey, setRevealedKey] = useState("");
  const keys = useQuery({
    queryKey: ["service-api-keys"],
    queryFn: () => fetchServiceApiKeys(),
    enabled: section === "settings",
    retry: false,
  });
  const createMutation = useMutation({
    mutationFn: (keyLabel: string) => createServiceApiKey(keyLabel),
    onSuccess: async (created) => {
      setRevealedKey(created.apiKey);
      await keys.refetch();
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeServiceApiKey(id),
    onSuccess: () => keys.refetch(),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!label.trim()) return;
    createMutation.mutate(label.trim());
  };
  const copy = (value: string) => navigator.clipboard?.writeText(value);

  return <Stack spacing={2.5}>
    {section === "docs" && <PageHeader eyebrow="PLATFORM INTEGRATION" title="API documentation" description="Integrate assignment scheduling, session results, recordings, transcripts, and completion callbacks." />}
    {section === "settings" && <PageHeader eyebrow="SERVICE API" title="API configuration" description="Manage service API keys for your platform integrations." />}
    {section === "settings" && <>
    <Alert severity="info">Web access uses your signed-in account. To add or disable accounts, an administrator runs the server-side account provisioning command. Service API keys below are for your platform backend; they are shown only once and should never be stored in browser code.</Alert>

    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 5 }}>
        <SectionCard title="Create a service API key" subtitle="Use a generated key from your platform server to call the integration API.">
          <Stack component="form" onSubmit={submit} spacing={1.5}>
            <TextField fullWidth size="small" label="Key label" value={label} onChange={(event) => setLabel(event.target.value)} />
            <Button type="submit" variant="contained" startIcon={createMutation.isPending ? <CircularProgress size={16} color="inherit" /> : <KeyRoundedIcon />} disabled={!label.trim() || createMutation.isPending}>Create API key</Button>
            {createMutation.isError && <Alert severity="error">{errorText(createMutation.error)}</Alert>}
          </Stack>
          {revealedKey && <Alert severity="success" sx={{ mt: 2 }} action={<IconButton aria-label="Copy API key" onClick={() => copy(revealedKey)}><ContentCopyRoundedIcon /></IconButton>}>
            <Typography variant="body2" fontWeight={700}>New key (shown once)</Typography>
            <Box component="code" sx={{ display: "block", mt: .7, overflowWrap: "anywhere" }}>{revealedKey}</Box>
            <Button size="small" sx={{ mt: 1 }} onClick={() => setRevealedKey("")}>Hide key</Button>
          </Alert>}
        </SectionCard>
      </Grid>

      <Grid size={{ xs: 12, lg: 7 }}>
        <SectionCard title="Issued keys" subtitle="Only labels, prefixes, and use timestamps are retained after key creation.">
          {keys.isLoading ? <CircularProgress size={22} /> : keys.data?.length ? <Stack spacing={1}>{keys.data.map((key: ServiceApiKey) => <Card key={key.id} variant="outlined" sx={{ p: 1.5, boxShadow: "none" }}>
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <KeyRoundedIcon color="action" />
              <Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="body2" fontWeight={700}>{key.label}</Typography><Typography variant="caption" color="text.secondary">{key.prefix}… · created {date(key.createdAt)} · {key.lastUsedAt ? "last used " + date(key.lastUsedAt) : "not used yet"}</Typography></Box>
              {key.revokedAt ? <Chip size="small" label="Revoked" /> : <Button color="error" size="small" startIcon={<DeleteOutlineRoundedIcon />} onClick={() => revokeMutation.mutate(key.id)} disabled={revokeMutation.isPending}>Revoke</Button>}
            </Stack>
          </Card>)}</Stack> : <Typography variant="body2" color="text.secondary">{keys.isError ? "Could not load API keys: " + errorText(keys.error) : "No API keys have been created yet."}</Typography>}
        </SectionCard>
      </Grid>
    </Grid>
    </>}

    {section === "docs" && <>
    <SectionCard title="Save staff and patient profiles" subtitle="Create directory records before scheduling assignments. Newly saved people appear in the New assignment dropdowns.">
      <Stack spacing={1.5}>
        <Typography variant="body2">Both endpoints require <Box component="code">Authorization: Bearer &lt;API_KEY&gt;</Box> and <Box component="code">Content-Type: application/json</Box>.</Typography>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, lg: 6 }}>
            <Typography variant="subtitle2" fontWeight={700}>Save staff</Typography>
            <Typography variant="body2" sx={{ mt: .5 }}>Endpoint: <Box component="code">POST /api/call-service/staff</Box></Typography>
            <Paper variant="outlined" sx={{ mt: 1, p: 1.5, bgcolor: "#f7f9fc", overflow: "auto" }}><Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}>{'{ "id": "STAFF-1001", "name": "Employee name", "phoneNumber": "+919876543210", "address": "Employee address", "language": "ta" }'}</Box></Paper>
          </Grid>
          <Grid size={{ xs: 12, lg: 6 }}>
            <Typography variant="subtitle2" fontWeight={700}>Save patient</Typography>
            <Typography variant="body2" sx={{ mt: .5 }}>Endpoint: <Box component="code">POST /api/call-service/patients</Box></Typography>
            <Paper variant="outlined" sx={{ mt: 1, p: 1.5, bgcolor: "#f7f9fc", overflow: "auto" }}><Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}>{'{ "id": "PATIENT-2001", "name": "Patient name", "phoneNumber": "+919876543210", "address": "Client service address", "language": "en", "careCategory": "Home care", "hub": "Chennai" }'}</Box></Paper>
          </Grid>
        </Grid>
        <Typography variant="caption" color="text.secondary">Staff IDs and patient IDs must be unique within the organization. Indian phone numbers may be entered as 10 digits (9876543210), with the country code 91 (919876543210), or +91 (+919876543210); the service validates and normalizes them to +91 followed by 10 digits. Patient phone number is optional. Supported languages are English, Tamil, Malayalam, and Telugu.</Typography>
      </Stack>
    </SectionCard>

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

    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 6 }}>
        <SectionCard title="Retrieve a session transcript and logs" subtitle="Use the session ID returned when creating an assignment. The response includes both attendance stages, call attempts, transcripts, extracted outcomes, and audit events.">
          <Stack spacing={1.5}>
            <Typography variant="body2">Endpoint: <Box component="code">GET /api/call-service/assignments/&#123;SESSION_ID&#125;/artifacts</Box></Typography>
            <Typography variant="body2">Authentication: <Box component="code">Authorization: Bearer &lt;API_KEY&gt;</Box>. The service API key must belong to the session organization.</Typography>
            <Paper variant="outlined" sx={{ position: "relative", p: 1.5, bgcolor: "#f7f9fc", overflow: "auto" }}>
              <IconButton size="small" aria-label="Copy session artifacts example" onClick={() => copy(sessionArtifactsExample)} sx={{ position: "absolute", right: 8, top: 8, zIndex: 1 }}><ContentCopyRoundedIcon fontSize="small" /></IconButton>
              <Box component="pre" sx={{ m: 0, pr: 5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{sessionArtifactsExample}</Box>
            </Paper>
            <Typography variant="caption" color="text.secondary">The response contains <Box component="code">session</Box>, <Box component="code">callAttempts</Box>, <Box component="code">transcripts</Box>, and <Box component="code">logs</Box>. Recording URLs are returned only for recordings already stored in private MinIO.</Typography>
          </Stack>
        </SectionCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <SectionCard title="Download a call recording" subtitle="Recordings are streamed from private storage through the authenticated service API.">
          <Stack spacing={1.5}>
            <Typography variant="body2">Endpoint: <Box component="code">GET /api/call-service/assignments/&#123;SESSION_ID&#125;/recordings/&#123;ATTEMPT_ID&#125;</Box></Typography>
            <Typography variant="body2">Authentication: <Box component="code">Authorization: Bearer &lt;API_KEY&gt;</Box>. The attempt must belong to the requested session.</Typography>
            <Paper variant="outlined" sx={{ position: "relative", p: 1.5, bgcolor: "#f7f9fc", overflow: "auto" }}>
              <IconButton size="small" aria-label="Copy recording download example" onClick={() => copy(recordingExample)} sx={{ position: "absolute", right: 8, top: 8, zIndex: 1 }}><ContentCopyRoundedIcon fontSize="small" /></IconButton>
              <Box component="pre" sx={{ m: 0, pr: 5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{recordingExample}</Box>
            </Paper>
            <Typography variant="caption" color="text.secondary">Use the recording URL from the artifacts response. A 404 means the recording is not available yet or the attempt does not belong to that session.</Typography>
          </Stack>
        </SectionCard>
      </Grid>
    </Grid>

    <SectionCard title="Send completed attendance to your platform" subtitle="Configure your platform's receiving POST endpoint in the service VM environment.">
      <Stack spacing={1.5}>
        <Typography variant="body2">On completion, the service sends a POST when both check-in and check-out are confirmed. The request contains the session, call attempts, and transcripts.</Typography>
        <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "#f7f9fc", overflow: "auto" }}>
          <Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{callbackEnvironment}</Box>
        </Paper>
        <Typography variant="body2">The request uses <Box component="code">Content-Type: application/json</Box>, <Box component="code">Authorization: Bearer &lt;ATTENDANCE_BACKEND_TOKEN&gt;</Box>, and an <Box component="code">Idempotency-Key</Box> of <Box component="code">attendance-session:&lt;SESSION_ID&gt;</Box>. The token header is omitted if no token is configured; set it in production.</Typography>
        <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "#f7f9fc", overflow: "auto" }}>
          <Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{completionPayloadExample}</Box>
        </Paper>
        <Typography variant="body2">If the receiver returns a non-2xx response or times out, the durable worker retries the POST. Check delivery using <Box component="code">GET /api/call-service/assignments/&#123;SESSION_ID&#125;/status</Box> and its <Box component="code">backendDeliveryStatus</Box> field.</Typography>
        <Typography variant="caption" color="text.secondary">The receiver should persist the idempotency key and return a 2xx response for duplicate requests without applying attendance twice. Recordings are retrieved separately using the session artifacts and recording endpoints above.</Typography>
      </Stack>
    </SectionCard>
    </>}
  </Stack>;
}
