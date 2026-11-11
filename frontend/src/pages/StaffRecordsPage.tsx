import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import PersonAddAltRoundedIcon from "@mui/icons-material/PersonAddAltRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import MedicalServicesRoundedIcon from "@mui/icons-material/MedicalServicesRounded";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import PhoneIphoneRoundedIcon from "@mui/icons-material/PhoneIphoneRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import { AxiosError } from "axios";
import { createStaff, fetchAttendance, fetchStaff, updateStaff, type AttendanceRecord, type CreateStaffPayload, type StaffRecord } from "../api/client";
import { MetricCard, PageHeader, SearchFilterBar, StatusChip } from "../components/OperationsUI";
import { INDIAN_MOBILE_ERROR, normalizeIndianMobile } from "../utils/phone";
import { AddressFields } from "../components/AddressFields";

function errorMessage(error: unknown) { return error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed"; }

function formatDutyDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
}

function formatDutyInterval(start: string | null, end: string | null) {
  if (!start || !end) return "Schedule time unavailable";
  return `${formatDutyDateTime(start)} – ${formatDutyDateTime(end)}`;
}

export function StaffRecordsPage() {
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<StaffRecord | null>(null);
  const [editing, setEditing] = useState<StaffRecord | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newStaff, setNewStaff] = useState<CreateStaffPayload>({ id: "", name: "", companyName: "", phoneNumber: "", address: "", language: "en" });
  const [phoneError, setPhoneError] = useState("");
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["staff"], queryFn: () => fetchStaff({ limit: 500 }), refetchInterval: 30_000 });
  const upcomingTasks = useQuery({
    queryKey: ["staff-upcoming-tasks", selected?.id],
    queryFn: () => fetchAttendance({ limit: 500 }),
    enabled: Boolean(selected),
  });
  const createMutation = useMutation({
    mutationFn: ({ payload, id, update }: { payload: CreateStaffPayload; id: string; update: boolean }) => update ? updateStaff(id, payload) : createStaff(payload),
    onSuccess: async () => {
      setAddOpen(false);
      setEditing(null);
      setNewStaff({ id: "", name: "", companyName: "", phoneNumber: "", address: "", language: "en" });
      setPhoneError("");
      await queryClient.invalidateQueries({ queryKey: ["staff"] });
    },
  });
  const records = query.data || [];
  const filtered = records.filter((row) => (!search || `${row.name} ${row.companyName} ${row.id} ${row.phoneNumber || ""} ${row.patientName} ${row.address}`.toLowerCase().includes(search.toLowerCase()))
    && (language === "all" || row.language.toLowerCase() === language)
    && (status === "all" || row.dutyStatus === status));
  const languages = [...new Set(records.map((row) => row.language.toLowerCase()))];
  const active = records.filter((row) => row.dutyStatus === "on duty").length;
  const upcomingForSelected = (upcomingTasks.data || [])
    .filter((task: AttendanceRecord) => task.employee.id === selected?.id
      && new Date(task.scheduledEndAt).getTime() >= Date.now()
      && !["completed", "cancelled"].includes(task.sessionStatus.toLowerCase()))
    .sort((a, b) => new Date(a.scheduledStartAt).getTime() - new Date(b.scheduledStartAt).getTime());
  const contacts = records.filter((row) => row.phoneMasked).length;
  const saveStaff = () => {
    const phoneNumber = normalizeIndianMobile(newStaff.phoneNumber);
    if (!phoneNumber) { setPhoneError(INDIAN_MOBILE_ERROR); return; }
    setPhoneError("");
    const payload = { ...newStaff, id: newStaff.id.trim(), name: newStaff.name.trim(), companyName: newStaff.companyName?.trim() || "", phoneNumber, address: newStaff.address.trim() };
    createMutation.mutate({ payload, id: payload.id, update: Boolean(editing) });
  };
  const activeFilters = Number(language !== "all") + Number(status !== "all");
  const openAdd = () => {
    setEditing(null);
    setNewStaff({ id: "", name: "", companyName: "", phoneNumber: "", address: "", language: "en" });
    setPhoneError("");
    setAddOpen(true);
  };
  const openEdit = (record: StaffRecord) => {
    setEditing(record);
    setNewStaff({ id: record.id, name: record.name, companyName: record.companyName || "", phoneNumber: record.phoneNumber || "", address: record.address || "", language: record.language || "en" });
    setPhoneError("");
    setAddOpen(true);
  };
  const closeEditDialog = () => {
    if (createMutation.isPending) return;
    setAddOpen(false);
    setEditing(null);
  };

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="WORKFORCE / ATTENDANCE ASSIGNMENTS" title="Staff records" description="Manage saved staff profiles and review their attendance assignments. View registered employee contact details." actions={<><Button variant="outlined" startIcon={<DownloadRoundedIcon />} disabled={!records.length}>Export</Button><Button variant="contained" startIcon={<PersonAddAltRoundedIcon />} onClick={openAdd}>Add staff</Button></>} />
    {query.isError && <Alert severity="error">Could not load staff records from the backend.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Staff records" value={query.isLoading ? "—" : String(records.length)} detail="Saved and assigned employees" icon={<GroupRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Active assignments" value={query.isLoading ? "—" : String(active)} detail="Current active session" icon={<MedicalServicesRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Calling languages" value={query.isLoading ? "—" : String(languages.length)} detail={languages.map((value) => value.toUpperCase()).join(" · ") || "None yet"} icon={<TranslateRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Contacts on record" value={query.isLoading ? "—" : String(contacts)} detail="Registered staff mobile numbers" icon={<PhoneIphoneRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
    </Grid>
    <Card>
      <SearchFilterBar
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search employee ID, name, or patient"
        activeFilters={activeFilters}
        resultCount={filtered.length}
        resultLabel="employees"
        onClearFilters={() => { setLanguage("all"); setStatus("all"); }}
        filters={<>
          <FormControl size="small" fullWidth><InputLabel>Language</InputLabel><Select label="Language" value={language} onChange={(event) => setLanguage(event.target.value)}><MenuItem value="all">All languages</MenuItem>{languages.map((value) => <MenuItem key={value} value={value}>{value.toUpperCase()}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Session state</InputLabel><Select label="Session state" value={status} onChange={(event) => setStatus(event.target.value)}><MenuItem value="all">All states</MenuItem>{["on duty", "unassigned", "exception", "completed", "cancelled"].map((value) => <MenuItem key={value} value={value} sx={{ textTransform: "capitalize" }}>{value}</MenuItem>)}</Select></FormControl>
        </>}
      />
      {query.isLoading && <LinearProgress />}
      <TableContainer><Table size="small" aria-label="Staff directory" sx={{ minWidth: 1150 }}><TableHead><TableRow>{["Staff identity", "Company / vendor", "Mobile number", "Staff address", "Calling language", "Current patient", "Assignment", "Session state", "Profile"].map((item) => <TableCell key={item} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{item}</TableCell>)}</TableRow></TableHead><TableBody>{filtered.map((row) => <TableRow key={`${row.id}:${row.assignmentId}`} hover><TableCell><Typography variant="body2" fontWeight={700}>{row.name}</Typography><Typography variant="caption" color="text.secondary">{row.id}</Typography></TableCell><TableCell>{row.companyName || "Independent"}</TableCell><TableCell>{row.phoneNumber || row.phoneMasked || "Not supplied"}</TableCell><TableCell sx={{ minWidth: 220, maxWidth: 320, whiteSpace: "normal" }}>{row.address || "Not provided"}</TableCell><TableCell>{row.language.toUpperCase()}</TableCell><TableCell>{row.patientName}</TableCell><TableCell>{row.assignmentId}</TableCell><TableCell><StatusChip status={row.dutyStatus} /></TableCell><TableCell><Stack direction="row" spacing={.5}><Button size="small" onClick={() => setSelected(row)}>View</Button><Button size="small" startIcon={<EditRoundedIcon />} onClick={() => openEdit(row)}>Edit</Button></Stack></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {query.isSuccess && filtered.length === 0 && <Typography color="text.secondary" align="center" sx={{ py: 5 }}>No staff records match these filters.</Typography>}
    </Card>
    <Dialog open={addOpen} onClose={closeEditDialog} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? "Edit staff record" : "Add staff"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {createMutation.isError && <Alert severity="error">{errorMessage(createMutation.error)}</Alert>}
          <Grid container spacing={1.5}>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required label="Staff ID" value={newStaff.id} InputProps={editing ? { readOnly: true } : undefined} onChange={(event) => setNewStaff((current) => ({ ...current, id: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required label="Full name" value={newStaff.name} onChange={(event) => setNewStaff((current) => ({ ...current, name: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Company / vendor name" value={newStaff.companyName || ""} onChange={(event) => setNewStaff((current) => ({ ...current, companyName: event.target.value }))} helperText="Optional for independent staff." /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required type="tel" label="Indian mobile number" placeholder="9876543210 or +919876543210" error={Boolean(phoneError)} helperText={phoneError || "Enter 10 digits; 91 or +91 country code is optional."} value={newStaff.phoneNumber} onChange={(event) => { setPhoneError(""); setNewStaff((current) => ({ ...current, phoneNumber: event.target.value })); }} onBlur={() => { const normalized = normalizeIndianMobile(newStaff.phoneNumber); if (!newStaff.phoneNumber.trim()) return; if (!normalized) setPhoneError(INDIAN_MOBILE_ERROR); else { setPhoneError(""); setNewStaff((current) => ({ ...current, phoneNumber: normalized })); } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><FormControl fullWidth size="small"><InputLabel>Calling language</InputLabel><Select label="Calling language" value={newStaff.language} onChange={(event) => setNewStaff((current) => ({ ...current, language: event.target.value }))}><MenuItem value="en">English</MenuItem><MenuItem value="ta">Tamil</MenuItem><MenuItem value="ml">Malayalam</MenuItem><MenuItem value="te">Telugu</MenuItem></Select></FormControl></Grid>
            <Grid size={12}><AddressFields required value={newStaff.address} onChange={(address) => setNewStaff((current) => ({ ...current, address }))} /></Grid>
          </Grid>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={closeEditDialog} disabled={createMutation.isPending}>Cancel</Button><Button variant="contained" onClick={saveStaff} disabled={createMutation.isPending || !newStaff.id.trim() || !newStaff.name.trim() || !newStaff.phoneNumber.trim() || !newStaff.address.trim()}>{editing ? "Update staff" : "Save staff"}</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(selected)} onClose={() => setSelected(null)} fullWidth maxWidth="md" scroll="paper">{selected && <><DialogTitle>Staff profile · {selected.name}</DialogTitle><DialogContent dividers><Stack spacing={2.5} sx={{ pt: 1 }}>
      <Grid container spacing={1.5}>
        <Grid size={{ xs: 12, sm: 6 }}><Typography variant="overline" color="text.secondary">Staff ID</Typography><Typography>{selected.id}</Typography></Grid>
        <Grid size={{ xs: 12, sm: 6 }}><Typography variant="overline" color="text.secondary">Mobile number</Typography><Typography>{selected.phoneNumber || selected.phoneMasked || "Not available"}</Typography></Grid>
        <Grid size={{ xs: 12, sm: 6 }}><Typography variant="overline" color="text.secondary">Company / vendor</Typography><Typography>{selected.companyName || "Independent"}</Typography></Grid>
        <Grid size={12}><Typography variant="overline" color="text.secondary">Address</Typography><Typography>{selected.address || "Not provided"}</Typography></Grid>
        <Grid size={{ xs: 12, sm: 6 }}><Typography variant="overline" color="text.secondary">Calling language</Typography><Typography>{selected.language.toUpperCase()}</Typography></Grid>
        <Grid size={{ xs: 12, sm: 6 }}><Typography variant="overline" color="text.secondary">Current duty status</Typography><Typography sx={{ textTransform: "capitalize" }}>{selected.dutyStatus}</Typography></Grid>
        <Grid size={12}><Typography variant="overline" color="text.secondary">Current/last assigned patient</Typography><Typography>{selected.patientName}{selected.patientId ? ` · ${selected.patientId}` : ""}</Typography></Grid>
        <Grid size={{ xs: 12, sm: 6 }}><Typography variant="overline" color="text.secondary">Current/last duty interval · local time</Typography><Typography>{formatDutyInterval(selected.scheduledStartAt, selected.scheduledEndAt)}</Typography></Grid>
        <Grid size={{ xs: 12, sm: 6 }}><Typography variant="overline" color="text.secondary">Assignment ID</Typography><Typography>{selected.assignmentId}</Typography></Grid>
      </Grid>
      <Stack spacing={1}>
        <Typography variant="h6" fontWeight={700}>Upcoming tasks</Typography>
        {upcomingTasks.isLoading && <LinearProgress />}
        {upcomingTasks.isError && <Alert severity="error">Could not load this staff member’s upcoming tasks.</Alert>}
        {upcomingTasks.isSuccess && upcomingForSelected.length === 0 && <Alert severity="info">No upcoming assigned tasks for this staff member.</Alert>}
        {upcomingForSelected.length > 0 && <TableContainer component={Card} variant="outlined"><Table size="small" aria-label="Upcoming staff tasks"><TableHead><TableRow><TableCell>Patient</TableCell><TableCell>Duty interval · local time</TableCell><TableCell>Check in</TableCell><TableCell>Check out</TableCell><TableCell>Status</TableCell></TableRow></TableHead><TableBody>{upcomingForSelected.map((task) => <TableRow key={task.sessionId}>
          <TableCell><Typography variant="body2" fontWeight={650}>{task.patient.name || "Patient"}</Typography><Typography variant="caption" color="text.secondary">{task.assignmentId}</Typography></TableCell>
          <TableCell>{formatDutyInterval(task.scheduledStartAt, task.scheduledEndAt)}</TableCell>
          <TableCell sx={{ textTransform: "capitalize" }}>{task.checkIn.status.replaceAll("_", " ")}</TableCell>
          <TableCell sx={{ textTransform: "capitalize" }}>{task.checkOut.status.replaceAll("_", " ")}</TableCell>
          <TableCell sx={{ textTransform: "capitalize" }}>{task.sessionStatus.replaceAll("_", " ")}</TableCell>
        </TableRow>)}</TableBody></Table></TableContainer>}
      </Stack>
      <Alert severity="info">Voice biometrics and carrier whitelist checks are not connected in this service.</Alert>
    </Stack></DialogContent><DialogActions><Button onClick={() => setSelected(null)}>Close profile</Button></DialogActions></>}</Dialog>
  </Stack>;
}
