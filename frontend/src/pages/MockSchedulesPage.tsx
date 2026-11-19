import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, IconButton, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import { createMockAthulyaSchedule, deleteMockAthulyaSchedule, fetchAthulyaSyncRuns, fetchMockAthulyaSchedules, startAthulyaSync, updateMockAthulyaSchedule, type MockAthulyaSchedule } from "../api/client";
import { MetricCard, PageHeader } from "../components/OperationsUI";

function todayIndia(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(value);
}

function defaultScheduleTimes() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  const nowMinutes = hour * 60 + minute;
  const crossesMidnight = nowMinutes + 5 >= 1440;
  // The mock API stores one shared schedule date for both times. Roll to
  // tomorrow near midnight so the default window stays valid and in the future.
  const start = new Date(Date.UTC(2000, 0, 1, 0, crossesMidnight ? 1 : nowMinutes + 1));
  const end = new Date(Date.UTC(2000, 0, 1, 0, crossesMidnight ? 5 : nowMinutes + 5));
  const format = (value: Date) => `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}:00`;
  const scheduleDate = todayIndia(now);
  const [year, month, day] = scheduleDate.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + (crossesMidnight ? 1 : 0))).toISOString().slice(0, 10);
  return { schedule_date: nextDate, start_time: format(start), end_time: format(end) };
}

const emptySchedule = (): Partial<MockAthulyaSchedule> => ({
  ...defaultScheduleTimes(),
  client_name: "Mock Patient", patient_id: "MOCK-PATIENT-001", patient_uhid: "MOCK-UHID-001",
  patient_address: "1 Test Street, Chennai, Tamil Nadu, India",
  care_manager_id: "MOCK-CM-001", care_manager_name: "Mock Care Manager", care_manager_phone: "+919999900001",
  service_name: "Mock Home Care Visit", branch: "Mock Chennai Branch",
  schedule_status: "Scheduled", caregiver_schedule_status: "Assigned",
  caregiver_ids: "MOCK-CAREGIVER-001", caregiver_names: "Mock Caregiver",
  caregiver_phones: "+916384670687", vendor_company: "ATHULYA",
});

const fields: Array<{ key: keyof MockAthulyaSchedule; label: string; type?: string }> = [
  { key: "schedule_date", label: "Schedule date", type: "date" },
  { key: "start_time", label: "Start time", type: "time" },
  { key: "end_time", label: "End time", type: "time" },
  { key: "client_name", label: "Patient / client name" },
  { key: "patient_id", label: "Patient ID" },
  { key: "patient_uhid", label: "Patient UHID" },
  { key: "patient_address", label: "Patient address" },
  { key: "care_manager_id", label: "Care Manager ID" },
  { key: "care_manager_name", label: "Care Manager name" },
  { key: "care_manager_phone", label: "Care Manager phone" },
  { key: "service_name", label: "Service name" },
  { key: "branch", label: "Branch" },
  { key: "caregiver_ids", label: "Caregiver ID" },
  { key: "caregiver_names", label: "Caregiver name" },
  { key: "caregiver_phones", label: "Caregiver phone" },
  { key: "caregiver_schedule_status", label: "Caregiver assignment status" },
  { key: "vendor_company", label: "Vendor company" },
];

function normalizeIndianMobile(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  const mobile = digits.length === 10 ? digits : digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : "";
  return /^[6-9]\d{9}$/.test(mobile) ? `+91${mobile}` : null;
}

function normalizeMobileList(value: string): string | null {
  const entries = value.split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) return "";
  const normalized = entries.map(normalizeIndianMobile);
  return normalized.some((entry) => !entry) ? null : normalized.join(", ");
}

export function MockSchedulesPage() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(todayIndia());
  const [editing, setEditing] = useState<Partial<MockAthulyaSchedule> | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<Partial<MockAthulyaSchedule>>(emptySchedule());
  const [error, setError] = useState("");
  const phoneErrors = {
    care_manager_phone: form.care_manager_phone && !normalizeIndianMobile(form.care_manager_phone) ? "Enter a valid 10-digit Indian mobile number, optionally prefixed with 91 or +91." : "",
    caregiver_phones: form.caregiver_phones && normalizeMobileList(form.caregiver_phones) === null ? "Enter valid Indian mobile numbers separated by commas." : "",
  };
  const normalizedCareManagerPhone = form.care_manager_phone ? normalizeIndianMobile(form.care_manager_phone) : "";
  const normalizedCaregiverPhones = normalizeMobileList(form.caregiver_phones || "");
  const phoneInvalid = Boolean(phoneErrors.care_manager_phone || phoneErrors.caregiver_phones);
  const timeError = (() => {
    const date = String(form.schedule_date || "");
    const start = String(form.start_time || "").slice(0, 5);
    const end = String(form.end_time || "").slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return "Enter a valid date, start time, and end time.";
    if (start >= end) return "Start time must be earlier than end time.";
    const scheduledStart = new Date(`${date}T${start}:00+05:30`);
    if (scheduledStart.getTime() <= Date.now()) return "Schedule start must be in the future. Choose a future date or time.";
    return "";
  })();
  const schedules = useQuery({ queryKey: ["mock-athulya-schedules"], queryFn: fetchMockAthulyaSchedules, refetchInterval: 5000 });
  const runs = useQuery({ queryKey: ["athulya-sync-runs"], queryFn: fetchAthulyaSyncRuns, refetchInterval: 2500 });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mock-athulya-schedules"] }),
      queryClient.invalidateQueries({ queryKey: ["athulya-sync-runs"] }),
    ]);
  };
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { ...form, care_manager_phone: normalizedCareManagerPhone || "", caregiver_phones: normalizedCaregiverPhones || "", schedule_status: form.schedule_status || "Scheduled" };
      return editing?.schedule_id
        ? updateMockAthulyaSchedule(editing.schedule_id, payload)
        : createMockAthulyaSchedule(payload);
    },
    onSuccess: async () => { setEditing(null); setDialogOpen(false); await refresh(); },
    onError: (e: any) => setError(e?.response?.data?.message || e?.response?.data?.error || e.message || "Unable to save schedule"),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteMockAthulyaSchedule,
    onSuccess: refresh,
    onError: (e: any) => setError(e?.response?.data?.message || e.message || "Unable to delete schedule"),
  });
  const syncMutation = useMutation({
    mutationFn: () => startAthulyaSync({ scheduleDate: date }),
    onSuccess: refresh,
    onError: (e: any) => setError(e?.response?.data?.error || e.message || "Unable to start sync"),
  });
  const rows = schedules.data?.data || [];
  const latestRun = runs.data?.[0];
  const running = runs.data?.some((run) => run.status === "running") || false;
  const metrics = useMemo(() => ({
    total: rows.length,
    assigned: rows.filter((row) => row.caregiver_ids).length,
    completed: rows.filter((row) => row.schedule_status.toLowerCase() === "completed").length,
  }), [rows]);

  const openCreate = () => { setEditing(null); setForm(emptySchedule()); setDialogOpen(true); setError(""); };
  const openEdit = (row: MockAthulyaSchedule) => { setEditing(row); setForm({ ...row }); setDialogOpen(true); setError(""); };
  const setField = (key: keyof MockAthulyaSchedule, value: string) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <Stack spacing={3}>
      <PageHeader title="Mock Athulya schedules" />
      <Alert severity="info">
        Mock schedules are isolated test data. New schedules default to <b>Scheduled</b> so you can test call scheduling. Use <b>Completed</b> when you want to import the schedule without placing outbound calls.
      </Alert>
      {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 4 }}><MetricCard label="Mock schedules" value={String(metrics.total)} icon={<AddRoundedIcon />} /></Grid>
        <Grid size={{ xs: 12, sm: 4 }}><MetricCard label="With caregiver" value={String(metrics.assigned)} icon={<EditRoundedIcon />} /></Grid>
        <Grid size={{ xs: 12, sm: 4 }}><MetricCard label="Completed / safe" value={String(metrics.completed)} icon={<SyncRoundedIcon />} /></Grid>
      </Grid>
      <Card variant="outlined">
        <CardContent>
          <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="space-between" spacing={2}>
            <Box><Typography variant="h6" fontWeight={750}>Schedule fixtures</Typography><Typography variant="body2" color="text.secondary">Create, edit or remove the records returned by the mock Athulya API.</Typography></Box>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" startIcon={<RefreshRoundedIcon />} onClick={() => void refresh()}>Refresh</Button>
              <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openCreate}>Add schedule</Button>
            </Stack>
          </Stack>
          <TableContainer sx={{ mt: 2 }}>
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>Date / time</TableCell><TableCell>Patient</TableCell><TableCell>Caregiver</TableCell><TableCell>Phone</TableCell><TableCell>Status</TableCell><TableCell align="right">Actions</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {rows.map((row) => <TableRow key={row.schedule_id} hover>
                  <TableCell><Typography fontWeight={650}>{row.schedule_date}</Typography><Typography variant="caption" color="text.secondary">{row.start_time} – {row.end_time}</Typography></TableCell>
                  <TableCell><Typography fontWeight={650}>{row.client_name}</Typography><Typography variant="caption" color="text.secondary">{row.patient_id}</Typography></TableCell>
                  <TableCell><Typography>{row.caregiver_names || "—"}</Typography><Typography variant="caption" color="text.secondary">{row.caregiver_ids || "No caregiver"}</Typography></TableCell>
                  <TableCell>{row.caregiver_phones || "—"}</TableCell>
                  <TableCell><Chip size="small" label={row.schedule_status} color={row.schedule_status.toLowerCase() === "completed" ? "success" : "warning"} /></TableCell>
                  <TableCell align="right">
                    <IconButton size="small" aria-label="Edit schedule" onClick={() => openEdit(row)}><EditRoundedIcon fontSize="small" /></IconButton>
                    <IconButton size="small" aria-label="Delete schedule" color="error" onClick={() => { if (window.confirm(`Delete ${row.schedule_id}?`)) deleteMutation.mutate(row.schedule_id); }}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton>
                  </TableCell>
                </TableRow>)}
                {!rows.length && <TableRow><TableCell colSpan={6}><Typography color="text.secondary" textAlign="center" py={3}>{schedules.isLoading ? "Loading mock schedules…" : "No mock schedules yet. Add one to get started."}</Typography></TableCell></TableRow>}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" fontWeight={750}>Run Athulya sync</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Choose the schedule date. The worker fetches the matching mock records and upserts them into attendance.</Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
            <TextField label="Schedule date" type="date" size="small" value={date} onChange={(e) => setDate(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ minWidth: 190 }} />
            <Button variant="contained" startIcon={<SyncRoundedIcon />} disabled={syncMutation.isPending || running || !date} onClick={() => { setError(""); syncMutation.mutate(); }}>
              {running ? "Sync in progress…" : syncMutation.isPending ? "Starting…" : "Sync this date"}
            </Button>
            {running && <Chip color="info" label="Worker processing" />}
          </Stack>
          {latestRun && <Box sx={{ mt: 2, p: 2, borderRadius: 2, bgcolor: "action.hover" }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
              <Typography fontWeight={700}>Latest sync · {latestRun.status}</Typography>
              <Chip size="small" color={latestRun.status === "succeeded" ? "success" : latestRun.status === "failed" ? "error" : "info"} label={latestRun.status} />
            </Stack>
            <Grid container spacing={2} sx={{ mt: 0.5 }}>
              <Grid size={{ xs: 6, sm: 3 }}><Typography variant="caption" color="text.secondary">Received</Typography><Typography variant="h6">{latestRun.recordsReceived}</Typography></Grid>
              <Grid size={{ xs: 6, sm: 3 }}><Typography variant="caption" color="text.secondary">Saved / updated</Typography><Typography variant="h6">{latestRun.recordsUpserted}</Typography></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Started</Typography><Typography variant="body2">{new Date(latestRun.startedAt).toLocaleString()}</Typography></Grid>
            </Grid>
            {latestRun.errorMessage && <Alert severity="error" sx={{ mt: 1 }}>{latestRun.errorMessage}</Alert>}
          </Box>}
        </CardContent>
      </Card>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" fontWeight={750}>Sync activity</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Automatically refreshes every few seconds while you work.</Typography>
          <Table size="small">
            <TableHead><TableRow><TableCell>Started</TableCell><TableCell>Date</TableCell><TableCell>Source</TableCell><TableCell>Status</TableCell><TableCell>Received</TableCell><TableCell>Saved / updated</TableCell><TableCell>Error</TableCell></TableRow></TableHead>
            <TableBody>
              {(runs.data || []).slice(0, 8).map((run) => <TableRow key={run.id}>
                <TableCell>{new Date(run.startedAt).toLocaleString()}</TableCell><TableCell>{run.fromDate || "—"}</TableCell><TableCell>{run.syncSource || "—"}</TableCell>
                <TableCell><Chip size="small" label={run.status} color={run.status === "succeeded" ? "success" : run.status === "failed" ? "error" : "info"} /></TableCell>
                <TableCell>{run.recordsReceived}</TableCell><TableCell>{run.recordsUpserted}</TableCell><TableCell sx={{ maxWidth: 240, whiteSpace: "normal" }}>{run.errorMessage || "—"}</TableCell>
              </TableRow>)}
              {!runs.data?.length && <TableRow><TableCell colSpan={7}><Typography color="text.secondary" textAlign="center" py={2}>No sync activity yet.</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{editing ? "Edit mock schedule" : "Add mock schedule"}</DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ pt: 1 }}>
            {fields.map((field) => <Grid size={{ xs: 12, sm: 6 }} key={field.key}>
              <TextField fullWidth size="small" type={field.type || "text"} label={field.label} value={String(form[field.key] ?? "")}
                onChange={(e) => setField(field.key, e.target.value)} InputLabelProps={field.type === "date" || field.type === "time" ? { shrink: true } : undefined}
                error={field.key === "start_time" || field.key === "end_time" || field.key === "schedule_date" ? Boolean(timeError) : field.key === "care_manager_phone" ? Boolean(phoneErrors.care_manager_phone) : field.key === "caregiver_phones" ? Boolean(phoneErrors.caregiver_phones) : false}
                inputProps={field.type === "date" && !editing ? { min: todayIndia() } : undefined}
                helperText={field.key === "start_time" || field.key === "end_time" || field.key === "schedule_date" ? timeError : field.key === "care_manager_phone" ? phoneErrors.care_manager_phone || "Saved in +91 format." : field.key === "caregiver_phones" ? phoneErrors.caregiver_phones || "For multiple caregivers, separate numbers with commas." : undefined} />
            </Grid>)}
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField select fullWidth size="small" label="Schedule status" value={String(form.schedule_status || "Scheduled")} onChange={(e) => setField("schedule_status", e.target.value)}>
                {["Completed", "Scheduled", "Assigned", "Cancelled"].map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}
              </TextField>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={saveMutation.isPending || phoneInvalid || Boolean(timeError) || !form.client_name || !form.patient_id || !form.schedule_date} onClick={() => saveMutation.mutate()}>{saveMutation.isPending ? "Saving…" : "Save schedule"}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export default MockSchedulesPage;
