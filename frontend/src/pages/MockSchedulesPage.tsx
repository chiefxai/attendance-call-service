import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Grid, IconButton, MenuItem, Radio, RadioGroup, Stack, Table, TableBody, TableCell, TableHead, TablePagination, TableRow, TextField, Typography } from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import { createMockAthulyaSchedule, deleteMockAthulyaSchedule, fetchAthulyaSyncRuns, fetchMockAthulyaSchedules, startAthulyaSync, updateMockAthulyaSchedule, type MockAthulyaSchedule } from "../api/client";
import { MetricCard, PageHeader, OperationsTable } from "../components/OperationsUI";
import { formatAppDateTime } from "../utils/dateTime";

function todayIndia(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(value);
}

function defaultScheduleTimes() {
  const start = new Date(Date.now() + 60_000);
  const end = new Date(Date.now() + 5 * 60_000);
  const dateInIndia = (value: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const timeInIndia = (value: Date) => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "00";
    return `${part("hour")}:${part("minute")}:00`;
  };
  const startDate = dateInIndia(start);
  const endDate = dateInIndia(end);
  // The mock API uses one date for both times. If the quick window crosses
  // midnight, move it to the next day's first few minutes.
  if (startDate !== endDate) return { schedule_date: endDate, start_time: "00:01:00", end_time: timeInIndia(end) };
  return { schedule_date: startDate, start_time: timeInIndia(start), end_time: timeInIndia(end) };
}

const emptySchedule = (): Partial<MockAthulyaSchedule> => ({
  ...defaultScheduleTimes(),
  client_name: "Mock Patient", patient_id: "MOCK-PATIENT-001", patient_uhid: "MOCK-UHID-001",
  patient_address: "1 Test Street, Chennai, Tamil Nadu, India",
  care_manager_id: "MOCK-CM-001", care_manager_name: "Mock Care Manager", care_manager_phone: "+919999900001",
  service_name: "Mock Home Care Visit", branch: "Mock Chennai Branch",
  schedule_status: "Scheduled", caregiver_schedule_status: "Assigned",
  caregiver_ids: "MOCK-CAREGIVER-SAM-JOSE", caregiver_names: "Sam Jose",
  caregiver_phones: "+918939479296", vendor_company: "ATHULYA",
});

type CaregiverTemplate = "sam_jose" | "mock" | "manual";
const caregiverTemplates: Record<Exclude<CaregiverTemplate, "manual">, Pick<MockAthulyaSchedule, "caregiver_ids" | "caregiver_names" | "caregiver_phones">> = {
  sam_jose: { caregiver_ids: "MOCK-CAREGIVER-SAM-JOSE", caregiver_names: "Sam Jose", caregiver_phones: "+918939479296" },
  mock: { caregiver_ids: "MOCK-CAREGIVER-001", caregiver_names: "Mock Caregiver", caregiver_phones: "+916384670687" },
};

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
  const [caregiverTemplate, setCaregiverTemplate] = useState<CaregiverTemplate>("sam_jose");
  const [error, setError] = useState("");
  const [quickScheduleCreated, setQuickScheduleCreated] = useState(false);
  const [fixturePage, setFixturePage] = useState(0);
  const [fixtureRowsPerPage, setFixtureRowsPerPage] = useState(10);
  const [syncPage, setSyncPage] = useState(0);
  const [syncRowsPerPage, setSyncRowsPerPage] = useState(5);
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
  const quickScheduleMutation = useMutation({
    mutationFn: () => createMockAthulyaSchedule({ ...emptySchedule(), ...defaultScheduleTimes(), schedule_status: "Scheduled" }),
    onSuccess: async () => { setError(""); setQuickScheduleCreated(true); await refresh(); },
    onError: (e: any) => setError(e?.response?.data?.message || e?.response?.data?.error || e.message || "Unable to create quick test schedule"),
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
  const visibleFixturePage = Math.min(fixturePage, Math.max(0, Math.ceil(rows.length / fixtureRowsPerPage) - 1));
  const fixturePageRows = rows.slice(visibleFixturePage * fixtureRowsPerPage, (visibleFixturePage + 1) * fixtureRowsPerPage);
  const syncRows = runs.data || [];
  const visibleSyncPage = Math.min(syncPage, Math.max(0, Math.ceil(syncRows.length / syncRowsPerPage) - 1));
  const syncPageRows = syncRows.slice(visibleSyncPage * syncRowsPerPage, (visibleSyncPage + 1) * syncRowsPerPage);
  const latestRun = runs.data?.[0];
  const running = runs.data?.some((run) => run.status === "running") || false;
  const metrics = useMemo(() => ({
    total: rows.length,
    assigned: rows.filter((row) => row.caregiver_ids).length,
    completed: rows.filter((row) => row.schedule_status.toLowerCase() === "completed").length,
  }), [rows]);

  const openCreate = () => { setEditing(null); setCaregiverTemplate("sam_jose"); setForm(emptySchedule()); setDialogOpen(true); setError(""); };
  const openEdit = (row: MockAthulyaSchedule) => { setEditing(row); setCaregiverTemplate("manual"); setForm({ ...row }); setDialogOpen(true); setError(""); };
  const setField = (key: keyof MockAthulyaSchedule, value: string) => {
    if (key === "caregiver_ids" || key === "caregiver_names" || key === "caregiver_phones") setCaregiverTemplate("manual");
    setForm((current) => ({ ...current, [key]: value }));
  };
  const chooseCaregiverTemplate = (value: string) => {
    if (value !== "sam_jose" && value !== "mock" && value !== "manual") return;
    setCaregiverTemplate(value);
    if (value === "manual" && caregiverTemplate !== "manual") {
      setForm((current) => ({ ...current, caregiver_ids: "", caregiver_names: "", caregiver_phones: "" }));
    } else if (value !== "manual") {
      setForm((current) => ({ ...current, ...caregiverTemplates[value] }));
    }
  };

  return (
    <Stack spacing={3}>
      <PageHeader eyebrow="DEVELOPMENT / TEST DATA" title="Mock Athulya schedules" description="Manage isolated schedule fixtures and verify integration behavior without changing live data." />
      <Alert severity="info">
        Mock schedules are isolated test data. New schedules default to <b>Scheduled</b> so you can test call scheduling. Use <b>Completed</b> when you want to import the schedule without placing outbound calls.
      </Alert>
      {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
      {quickScheduleCreated && <Alert severity="success" onClose={() => setQuickScheduleCreated(false)}>Sam Jose test schedule created. Check-in is set for about 1 minute from now and check-out for about 5 minutes from now.</Alert>}
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
              <Button variant="outlined" color="secondary" startIcon={<BoltRoundedIcon />} disabled={quickScheduleMutation.isPending} onClick={() => { setError(""); setQuickScheduleCreated(false); quickScheduleMutation.mutate(); }}>{quickScheduleMutation.isPending ? "Scheduling…" : "Quick test schedule"}</Button>
              <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openCreate}>Add schedule</Button>
            </Stack>
          </Stack>
          <OperationsTable sx={{ mt: 2, height: 360, overflow: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead><TableRow>
                <TableCell>Date / time</TableCell><TableCell>Patient</TableCell><TableCell>Caregiver</TableCell><TableCell>Phone</TableCell><TableCell>Status</TableCell><TableCell align="right">Actions</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {fixturePageRows.map((row) => <TableRow key={row.schedule_id} hover>
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
          </OperationsTable>
          <TablePagination
            component="div"
            count={rows.length}
            page={visibleFixturePage}
            onPageChange={(_, nextPage) => setFixturePage(nextPage)}
            rowsPerPage={fixtureRowsPerPage}
            onRowsPerPageChange={(event) => { setFixtureRowsPerPage(Number(event.target.value)); setFixturePage(0); }}
            rowsPerPageOptions={[5, 10, 25]}
            labelRowsPerPage="Schedules per page"
            sx={{ borderTop: "1px solid", borderColor: "divider" }}
          />
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
              <Grid size={{ xs: 12, sm: 6 }}><Typography variant="caption" color="text.secondary">Started</Typography><Typography variant="body2">{formatAppDateTime(latestRun.startedAt)}</Typography></Grid>
            </Grid>
            {latestRun.errorMessage && <Alert severity="error" sx={{ mt: 1 }}>{latestRun.errorMessage}</Alert>}
          </Box>}
        </CardContent>
      </Card>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" fontWeight={750}>Sync activity</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Automatically refreshes every few seconds while you work.</Typography>
          <OperationsTable sx={{ mt: 1.5, height: 360, overflow: "auto" }}><Table size="small" stickyHeader>
            <TableHead><TableRow><TableCell>Started</TableCell><TableCell>Date</TableCell><TableCell>Source</TableCell><TableCell>Status</TableCell><TableCell>Received</TableCell><TableCell>Saved / updated</TableCell><TableCell>Error</TableCell></TableRow></TableHead>
            <TableBody>
              {syncPageRows.map((run) => <TableRow key={run.id}>
                <TableCell>{formatAppDateTime(run.startedAt)}</TableCell><TableCell>{run.fromDate || "—"}</TableCell><TableCell>{run.syncSource || "—"}</TableCell>
                <TableCell><Chip size="small" label={run.status} color={run.status === "succeeded" ? "success" : run.status === "failed" ? "error" : "info"} /></TableCell>
                <TableCell>{run.recordsReceived}</TableCell><TableCell>{run.recordsUpserted}</TableCell><TableCell sx={{ maxWidth: 240, whiteSpace: "normal" }}>{run.errorMessage || "—"}</TableCell>
              </TableRow>)}
              {!runs.data?.length && <TableRow><TableCell colSpan={7}><Typography color="text.secondary" textAlign="center" py={2}>No sync activity yet.</Typography></TableCell></TableRow>}
            </TableBody>
          </Table></OperationsTable>
          <TablePagination
            component="div"
            count={syncRows.length}
            page={visibleSyncPage}
            onPageChange={(_, nextPage) => setSyncPage(nextPage)}
            rowsPerPage={syncRowsPerPage}
            onRowsPerPageChange={(event) => { setSyncRowsPerPage(Number(event.target.value)); setSyncPage(0); }}
            rowsPerPageOptions={[5, 10, 25]}
            labelRowsPerPage="Runs per page"
            sx={{ borderTop: "1px solid", borderColor: "divider" }}
          />
        </CardContent>
      </Card>
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{editing ? "Edit mock schedule" : "Add mock schedule"}</DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ pt: 1 }}>
            {!editing && <Grid size={12}>
              <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Choose a caregiver template</Typography>
              <RadioGroup row value={caregiverTemplate} onChange={(event) => chooseCaregiverTemplate(event.target.value)}>
                <Grid container spacing={1.25} sx={{ width: "100%" }}>
                  <Grid size={{ xs: 12, md: 4 }}><Card variant="outlined" sx={{ p: 1.25, height: "100%", borderColor: caregiverTemplate === "sam_jose" ? "primary.main" : "divider", bgcolor: caregiverTemplate === "sam_jose" ? "action.selected" : "background.paper" }}>
                    <FormControlLabel value="sam_jose" control={<Radio size="small" />} sx={{ m: 0, width: "100%", alignItems: "flex-start" }} label={<Box sx={{ pt: 0.5 }}><Stack direction="row" spacing={0.75} alignItems="center"><Typography variant="body2" fontWeight={700}>Sam Jose</Typography><Chip size="small" color="primary" label="Default" /></Stack><Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>Caregiver · +91 89394 79296</Typography></Box>} />
                  </Card></Grid>
                  <Grid size={{ xs: 12, md: 4 }}><Card variant="outlined" sx={{ p: 1.25, height: "100%", borderColor: caregiverTemplate === "mock" ? "primary.main" : "divider", bgcolor: caregiverTemplate === "mock" ? "action.selected" : "background.paper" }}>
                    <FormControlLabel value="mock" control={<Radio size="small" />} sx={{ m: 0, width: "100%", alignItems: "flex-start" }} label={<Box sx={{ pt: 0.5 }}><Typography variant="body2" fontWeight={700}>Mock Caregiver</Typography><Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>Caregiver · +91 63846 70687</Typography></Box>} />
                  </Card></Grid>
                  <Grid size={{ xs: 12, md: 4 }}><Card variant="outlined" sx={{ p: 1.25, height: "100%", borderColor: caregiverTemplate === "manual" ? "primary.main" : "divider", bgcolor: caregiverTemplate === "manual" ? "action.selected" : "background.paper" }}>
                    <FormControlLabel value="manual" control={<Radio size="small" />} sx={{ m: 0, width: "100%", alignItems: "flex-start" }} label={<Box sx={{ pt: 0.5 }}><Typography variant="body2" fontWeight={700}>Manual entry</Typography><Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>Enter your own caregiver details below.</Typography></Box>} />
                  </Card></Grid>
                </Grid>
              </RadioGroup>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>Template selection fills the caregiver ID, name, and phone. You can change any field before saving.</Typography>
            </Grid>}
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
