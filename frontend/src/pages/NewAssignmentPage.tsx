import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, CardContent, CircularProgress, Grid, MenuItem, Stack, TextField, Typography } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import { AxiosError } from "axios";
import { createAssignment, fetchAgents, type AssignmentPayload } from "../api/client";
import { useNavigate } from "react-router-dom";

interface FormValues {
  assignmentId: string;
  agentId: string;
  fromNumber: string;
  language: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  employeeId: string;
  employeeName: string;
  employeePhone: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  patientAddress: string;
}

function localInputValue(date: Date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

const now = new Date();
const shiftEnd = new Date(now.getTime() + 8 * 60 * 60_000);

const initialValues: FormValues = {
  assignmentId: "", agentId: "", fromNumber: "", language: "ta",
  scheduledStartAt: localInputValue(now), scheduledEndAt: localInputValue(shiftEnd),
  employeeId: "", employeeName: "", employeePhone: "",
  patientId: "", patientName: "", patientPhone: "", patientAddress: "",
};

function FormField({ label, value, onChange, required = false, type = "text", helperText, multiline = false, rows }: {
  label: string; value: string; onChange: (value: string) => void; required?: boolean;
  type?: string; helperText?: string; multiline?: boolean; rows?: number;
}) {
  return <TextField fullWidth size="small" label={label} value={value} required={required} type={type} helperText={helperText} multiline={multiline} rows={rows} onChange={(event) => onChange(event.target.value)} InputLabelProps={type === "datetime-local" ? { shrink: true } : undefined} />;
}

export function NewAssignmentPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(initialValues);
  const agents = useQuery({ queryKey: ["agents"], queryFn: fetchAgents, retry: 0 });
  const mutation = useMutation({
    mutationFn: createAssignment,
    onSuccess: (result) => navigate(`/sessions/${result.sessionId}`),
  });
  const update = (key: keyof FormValues) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: AssignmentPayload = {
      assignmentId: form.assignmentId.trim(), agentId: form.agentId, fromNumber: form.fromNumber.trim(),
      language: form.language, scheduledStartAt: new Date(form.scheduledStartAt).toISOString(),
      scheduledEndAt: new Date(form.scheduledEndAt).toISOString(),
      employee: { id: form.employeeId.trim(), name: form.employeeName.trim(), phoneNumber: form.employeePhone.trim() },
      patient: { id: form.patientId.trim(), name: form.patientName.trim(), phoneNumber: form.patientPhone.trim(), address: form.patientAddress.trim() },
    };
    mutation.mutate(payload);
  };
  const errorMessage = mutation.error instanceof AxiosError
    ? mutation.error.response?.data?.error || mutation.error.message
    : mutation.error?.message;

  return (
    <Stack spacing={3}>
      <Box><Typography variant="overline" color="primary.main" fontWeight={750} letterSpacing=".12em">SCHEDULE OUTBOUND CALLS</Typography><Typography variant="h4" sx={{ mt: .5 }}>New assignment</Typography><Typography color="text.secondary" sx={{ mt: .75 }}>Add the shift and contact details. The AI calls the employee at check-in and check-out times.</Typography></Box>
      {mutation.isError && <Alert severity="error">Assignment could not be scheduled: {errorMessage}</Alert>}
      {agents.isError && <Alert severity="warning">Unable to load agents. Verify the API connection and workspace access.</Alert>}
      <Box component="form" onSubmit={submit}>
        <Stack spacing={2.5}>
          <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6">Shift and calling setup</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4, mb: 2.5 }}>Choose the active voice agent, language, and scheduled shift.</Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, sm: 6 }}><FormField label="Assignment ID" value={form.assignmentId} onChange={update("assignmentId")} required /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><TextField select fullWidth size="small" label="Calling agent" required value={form.agentId} onChange={(event) => update("agentId")(event.target.value)} disabled={agents.isLoading || agents.data?.length === 0}><MenuItem value="" disabled>Select an active agent</MenuItem>{agents.data?.filter((agent) => agent.active).map((agent) => <MenuItem key={agent.id} value={agent.id}>{agent.name}</MenuItem>)}</TextField></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><FormField label="Vobiz caller ID" value={form.fromNumber} onChange={update("fromNumber")} required helperText="The Vobiz number the employee will see." /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><TextField select fullWidth size="small" label="Call language" value={form.language} onChange={(event) => update("language")(event.target.value)}>{[{ value: "ta", label: "Tamil" }, { value: "en", label: "English" }, { value: "ml", label: "Malayalam" }, { value: "te", label: "Telugu" }].map((language) => <MenuItem key={language.value} value={language.value}>{language.label}</MenuItem>)}</TextField></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><FormField label="Scheduled check-in" value={form.scheduledStartAt} onChange={update("scheduledStartAt")} type="datetime-local" required /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><FormField label="Scheduled check-out" value={form.scheduledEndAt} onChange={update("scheduledEndAt")} type="datetime-local" required /></Grid>
            </Grid>
          </CardContent></Card>
          <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6">Employee to call</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4, mb: 2.5 }}>The current outbound workflow only calls the employee.</Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Employee ID" value={form.employeeId} onChange={update("employeeId")} required /></Grid>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Employee name" value={form.employeeName} onChange={update("employeeName")} required /></Grid>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Employee phone" value={form.employeePhone} onChange={update("employeePhone")} required helperText="Include country code." /></Grid>
            </Grid>
          </CardContent></Card>
          <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6">Assigned patient details</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4, mb: 2.5 }}>Used to verify the assignment during the employee call. The patient is not called.</Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Patient ID" value={form.patientId} onChange={update("patientId")} required /></Grid>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Patient name" value={form.patientName} onChange={update("patientName")} required /></Grid>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Patient phone (optional)" value={form.patientPhone} onChange={update("patientPhone")} /></Grid>
              <Grid size={12}><FormField label="Patient address" value={form.patientAddress} onChange={update("patientAddress")} required multiline rows={2} /></Grid>
            </Grid>
          </CardContent></Card>
          <Stack direction="row" justifyContent="flex-end" alignItems="center" spacing={2}>
            <Typography variant="caption" color="text.secondary">Calls are queued for the employee only.</Typography>
            <Button type="submit" variant="contained" endIcon={mutation.isPending ? <CircularProgress size={16} color="inherit" /> : <ArrowForwardRoundedIcon />} disabled={mutation.isPending || agents.isLoading || !agents.data?.some((agent) => agent.id === form.agentId && agent.active)} sx={{ px: 2.5, py: 1.1 }}>{mutation.isPending ? "Scheduling…" : "Create assignment"}</Button>
          </Stack>
        </Stack>
      </Box>
    </Stack>
  );
}
