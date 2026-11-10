import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import PersonAddAltRoundedIcon from "@mui/icons-material/PersonAddAltRounded";
import ElderlyRoundedIcon from "@mui/icons-material/ElderlyRounded";
import MedicalServicesRoundedIcon from "@mui/icons-material/MedicalServicesRounded";
import ShareLocationRoundedIcon from "@mui/icons-material/ShareLocationRounded";
import { createPatient, fetchPatients, type CreatePatientPayload } from "../api/client";
import { MetricCard, PageHeader, SearchFilterBar, StatusChip } from "../components/OperationsUI";

export function PatientRecordsPage() {
  const [search, setSearch] = useState("");
  const [hub, setHub] = useState("all");
  const [category, setCategory] = useState("all");
  const [language, setLanguage] = useState("all");
  const [status, setStatus] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [newPatient, setNewPatient] = useState<CreatePatientPayload>({ id: "", name: "", phoneNumber: "", address: "", language: "en", careCategory: "", hub: "" });
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["patients"], queryFn: () => fetchPatients({ limit: 500 }), refetchInterval: 30_000 });
  const createMutation = useMutation({
    mutationFn: createPatient,
    onSuccess: async () => {
      setAddOpen(false);
      setNewPatient({ id: "", name: "", phoneNumber: "", address: "", language: "en", careCategory: "", hub: "" });
      await queryClient.invalidateQueries({ queryKey: ["patients"] });
    },
  });
  const records = query.data || [];
  const filtered = records.filter((row) => (!search || `${row.id} ${row.name} ${row.assignedStaff} ${row.address}`.toLowerCase().includes(search.toLowerCase()))
    && (hub === "all" || row.hub === hub) && (category === "all" || row.careCategory === category)
    && (language === "all" || row.language.toLowerCase().includes(language)) && (status === "all" || row.status === status));
  const active = records.filter((row) => row.status === "active").length;
  const categories = [...new Set(records.map((row) => row.careCategory).filter((value) => value !== "Not specified"))];
  const hubs = [...new Set(records.map((row) => row.hub).filter((value) => value !== "Not specified"))];
  const activeFilters = Number(hub !== "all") + Number(category !== "all") + Number(language !== "all") + Number(status !== "all");

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="HOME HEALTH / ASSIGNMENT DIRECTORY" title="Patient records" description="Manage saved patient profiles, addresses, and assignment details." actions={<><Button variant="outlined" startIcon={<DownloadRoundedIcon />} disabled>Export</Button><Button variant="contained" startIcon={<PersonAddAltRoundedIcon />} onClick={() => setAddOpen(true)}>Add patient</Button></>} />
    {query.isError && <Alert severity="error">Could not load patient assignment records from the backend.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Patient records" value={query.isLoading ? "—" : String(records.length)} detail="Saved and assigned patients" icon={<ElderlyRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Active assignment" value={query.isLoading ? "—" : String(active)} detail="Sessions currently active" icon={<MedicalServicesRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Care categories" value={query.isLoading ? "—" : String(categories.length)} detail="Categories supplied in assignments" icon={<MedicalServicesRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="GPS perimeter" value="Not connected" detail="Location verification is unavailable" icon={<ShareLocationRoundedIcon />} tint="#edf1f8" accent="#69778d" /></Grid>
    </Grid>
    <Card>
      <SearchFilterBar
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search patient, ID, or employee"
        activeFilters={activeFilters}
        resultCount={filtered.length}
        resultLabel="records"
        onClearFilters={() => { setHub("all"); setCategory("all"); setLanguage("all"); setStatus("all"); }}
        filters={<>
          <FormControl size="small" fullWidth><InputLabel>Hub</InputLabel><Select label="Hub" value={hub} onChange={(event) => setHub(event.target.value)}><MenuItem value="all">All hubs</MenuItem>{hubs.map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Care category</InputLabel><Select label="Care category" value={category} onChange={(event) => setCategory(event.target.value)}><MenuItem value="all">All categories</MenuItem>{categories.map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Language</InputLabel><Select label="Language" value={language} onChange={(event) => setLanguage(event.target.value)}><MenuItem value="all">All languages</MenuItem>{["ta", "en", "ml", "te"].map((value) => <MenuItem key={value} value={value}>{value.toUpperCase()}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" fullWidth><InputLabel>Session state</InputLabel><Select label="Session state" value={status} onChange={(event) => setStatus(event.target.value)}><MenuItem value="all">All states</MenuItem>{["active", "unassigned", "completed", "exception", "cancelled"].map((value) => <MenuItem key={value} value={value} sx={{ textTransform: "capitalize" }}>{value}</MenuItem>)}</Select></FormControl>
        </>}
      />
      {query.isLoading && <LinearProgress />}
      <TableContainer><Table size="small" aria-label="Patient assignment directory" sx={{ minWidth: 1100 }}><TableHead><TableRow>{["Patient & ID", "Patient address", "Hub", "Care category", "Assigned employee", "Language", "Location check", "Session status"].map((item) => <TableCell key={item} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{item}</TableCell>)}</TableRow></TableHead><TableBody>{filtered.map((row) => <TableRow key={`${row.id}:${row.assignedStaff}`} hover><TableCell><Typography variant="body2" fontWeight={700}>{row.name}</Typography><Typography variant="caption" color="text.secondary">{row.id}</Typography></TableCell><TableCell sx={{ minWidth: 240, maxWidth: 360, whiteSpace: "normal" }}>{row.address || "Not provided"}</TableCell><TableCell>{row.hub}</TableCell><TableCell>{row.careCategory}</TableCell><TableCell><Typography variant="body2">{row.assignedStaff}</Typography><Typography variant="caption" color="text.secondary">{row.employeeId || "Employee ID unavailable"}</Typography></TableCell><TableCell>{row.language.toUpperCase()}</TableCell><TableCell><StatusChip status={row.locationVerification} /></TableCell><TableCell><StatusChip status={row.status} /></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {query.isSuccess && filtered.length === 0 && <Typography align="center" color="text.secondary" sx={{ py: 5 }}>No patient assignments are available for these filters.</Typography>}
    </Card>
    <Dialog open={addOpen} onClose={() => { if (!createMutation.isPending) setAddOpen(false); }} fullWidth maxWidth="sm">
      <DialogTitle>Add patient</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {createMutation.isError && <Alert severity="error">{createMutation.error instanceof Error ? createMutation.error.message : "Could not save patient record."}</Alert>}
          <Grid container spacing={1.5}>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required label="Patient ID" value={newPatient.id} onChange={(event) => setNewPatient((current) => ({ ...current, id: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required label="Full name" value={newPatient.name} onChange={(event) => setNewPatient((current) => ({ ...current, name: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth type="tel" label="Phone number (optional)" placeholder="+919876543210" helperText="If provided, use E.164 format." value={newPatient.phoneNumber || ""} onChange={(event) => setNewPatient((current) => ({ ...current, phoneNumber: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><FormControl fullWidth size="small"><InputLabel>Preferred language</InputLabel><Select label="Preferred language" value={newPatient.language} onChange={(event) => setNewPatient((current) => ({ ...current, language: event.target.value }))}><MenuItem value="en">English</MenuItem><MenuItem value="ta">Tamil</MenuItem><MenuItem value="ml">Malayalam</MenuItem><MenuItem value="te">Telugu</MenuItem></Select></FormControl></Grid>
            <Grid size={12}><TextField fullWidth required multiline minRows={2} label="Patient address" value={newPatient.address} onChange={(event) => setNewPatient((current) => ({ ...current, address: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Care category (optional)" value={newPatient.careCategory || ""} onChange={(event) => setNewPatient((current) => ({ ...current, careCategory: event.target.value }))} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Hub (optional)" value={newPatient.hub || ""} onChange={(event) => setNewPatient((current) => ({ ...current, hub: event.target.value }))} /></Grid>
          </Grid>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setAddOpen(false)} disabled={createMutation.isPending}>Cancel</Button><Button variant="contained" onClick={() => createMutation.mutate({ ...newPatient, id: newPatient.id.trim(), name: newPatient.name.trim(), phoneNumber: newPatient.phoneNumber?.trim(), address: newPatient.address.trim(), careCategory: newPatient.careCategory?.trim(), hub: newPatient.hub?.trim() })} disabled={createMutation.isPending || !newPatient.id.trim() || !newPatient.name.trim() || !newPatient.address.trim()}>Save patient</Button></DialogActions>
    </Dialog>
  </Stack>;
}
