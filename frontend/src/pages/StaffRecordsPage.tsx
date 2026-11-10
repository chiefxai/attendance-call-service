import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import PersonAddAltRoundedIcon from "@mui/icons-material/PersonAddAltRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import MedicalServicesRoundedIcon from "@mui/icons-material/MedicalServicesRounded";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import PhoneIphoneRoundedIcon from "@mui/icons-material/PhoneIphoneRounded";
import { AxiosError } from "axios";
import { createStaff, fetchStaff, type CreateStaffPayload, type StaffRecord } from "../api/client";
import { MetricCard, PageHeader, SearchFilterBar, StatusChip } from "../components/OperationsUI";

function errorMessage(error: unknown) { return error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed"; }\n\nexport function StaffRecordsPage() {
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<StaffRecord | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newStaff, setNewStaff] = useState<CreateStaffPayload>({ id: "", name: "", phoneNumber: "", address: "", language: "en" });
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["staff"], queryFn: () => fetchStaff({ limit: 500 }), refetchInterval: 30_000 });
  const createMutation = useMutation({
    mutationFn: createStaff,
    onSuccess: async () => {
      setAddOpen(false);
      setNewStaff({ id: "", name: "", phoneNumber: "", address: "", language: "en" });
      await queryClient.invalidateQueries({ queryKey: ["staff"] });
    },
  });
  const records = query.data || [];
  const filtered = records.filter((row) => (!search || `${row.name} ${row.id} ${row.patientName} ${row.address}`.toLowerCase().includes(search.toLowerCase()))
    && (language === "all" || row.language.toLowerCase() === language)
    && (status === "all" || row.dutyStatus === status));
  const languages = [...new Set(records.map((row) => row.language.toLowerCase()))];
  const active = records.filter((row) => row.dutyStatus === "on duty").length;
  const contacts = records.filter((row) => row.phoneMasked).length;
  const activeFilters = Number(language !== "all") + Number(status !== "all");

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="WORKFORCE / ATTENDANCE ASSIGNMENTS" title="Staff records" description="Manage saved staff profiles and review their attendance assignments. Contact values are masked in this directory." actions={<><Button variant="outlined" startIcon={<DownloadRoundedIcon />} disabled={!records.length}>Export</Button><Button variant="contained" startIcon={<PersonAddAltRoundedIcon />} onClick={() => setAddOpen(true)}>Add staff</Button></>} />
    {query.isError && <Alert severity="error">Could not load staff records from the backend.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Staff records" value={query.isLoading ? "—" : String(records.length)} detail="Saved and assigned employees" icon={<GroupRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Active assignments" value={query.isLoading ? "—" : String(active)} detail="Current active session" icon={<MedicalServicesRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Calling languages" value={query.isLoading ? "—" : String(languages.length)} detail={languages.map((value) => value.toUpperCase()).join(" · ") || "None yet"} icon={<TranslateRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Contacts on record" value={query.isLoading ? "—" : String(contacts)} detail="Only masked values shown" icon={<PhoneIphoneRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
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
      <TableContainer><Table size="small" aria-label="Staff directory" sx={{ minWidth: 1050 }}><TableHead><TableRow>{["Staff identity", "Contact", "Staff address", "Calling language", "Current patient", "Assignment", "Session state", "Profile"].map((item) => <TableCell key={item} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{item}</TableCell>)}</TableRow></TableHead><TableBody>{filtered.map((row) => <TableRow key={`${row.id}:${row.assignmentId}`} hover><TableCell><Typography variant="body2" fontWeight={700}>{row.name}</Typography><Typography variant="caption" color="text.secondary">{row.id}</Typography></TableCell><TableCell>{row.phoneMasked || "Not supplied"}</TableCell><TableCell sx={{ minWidth: 220, maxWidth: 320, whiteSpace: "normal" }}>{row.address || "Not provided"}</TableCell><TableCell>{row.language.toUpperCase()}</TableCell><TableCell>{row.patientName}</TableCell><TableCell>{row.assignmentId}</TableCell><TableCell><StatusChip status={row.dutyStatus} /></TableCell><TableCell><Button size="small" onClick={() => setSelected(row)}>View</Button></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {query.isSuccess && filtered.length === 0 && <Typography color="text.secondary" align="center" sx={{ py: 5 }}>No employee assignments match these filters.</Typography>}
    </Card>
    <Dialog open={addOpen} onClose={() => { if (!createMutation.isPending) setAddOpen(false); }} fullWidth maxWidth="sm">
      <DialogTitle>Add staff</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {createMutation.isError && <Alert severity="error">{errorMessage(createMutation.error)}</Alert>}
          <Grid container spacing={1.5}>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required label="Staff ID" value={newStaff.id} onChange={(event) => setNewStaff((current) => ({ ...current, id: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required label="Full name" value={newStaff.name} onChange={(event) => setNewStaff((current) => ({ ...current, name: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required type="tel" label="Phone number" placeholder="+919876543210" helperText="Use E.164 format with country code." value={newStaff.phoneNumber} onChange={(event) => setNewStaff((current) => ({ ...current, phoneNumber: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><FormControl fullWidth size="small"><InputLabel>Calling language</InputLabel><Select label="Calling language" value={newStaff.language} onChange={(event) => setNewStaff((current) => ({ ...current, language: event.target.value }))}><MenuItem value="en">English</MenuItem><MenuItem value="ta">Tamil</MenuItem><MenuItem value="ml">Malayalam</MenuItem><MenuItem value="te">Telugu</MenuItem></Select></FormControl></Grid>
            <Grid size={12}><TextField fullWidth required multiline minRows={2} label="Staff address" value={newStaff.address} onChange={(event) => setNewStaff((current) => ({ ...current, address: event.target.value }))} /></Grid>
          </Grid>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setAddOpen(false)} disabled={createMutation.isPending}>Cancel</Button><Button variant="contained" onClick={() => createMutation.mutate({ ...newStaff, id: newStaff.id.trim(), name: newStaff.name.trim(), phoneNumber: newStaff.phoneNumber.trim(), address: newStaff.address.trim() })} disabled={createMutation.isPending || !newStaff.id.trim() || !newStaff.name.trim() || !newStaff.phoneNumber.trim() || !newStaff.address.trim()}>Save staff</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(selected)} onClose={() => setSelected(null)} fullWidth maxWidth="sm">{selected && <><DialogTitle>Employee assignment · {selected.id}</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ pt: 1 }}><Typography variant="h6">{selected.name}</Typography><Typography variant="body2">Calling language: {selected.language.toUpperCase()}</Typography><Typography variant="body2" color="text.secondary">Registered employee phone: {selected.phoneMasked || "Not available"}</Typography><Typography variant="body2" color="text.secondary">Staff address: {selected.address || "Not provided"}</Typography><Typography variant="body2" color="text.secondary">Current patient: {selected.patientName}</Typography><Typography variant="body2" color="text.secondary">Assignment: {selected.assignmentId}</Typography><Alert severity="info">Voice biometrics and carrier whitelist checks are not connected in this service.</Alert></Stack></DialogContent><DialogActions><Button onClick={() => setSelected(null)}>Close profile</Button></DialogActions></>}</Dialog>
  </Stack>;
}
