import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import PersonAddAltRoundedIcon from "@mui/icons-material/PersonAddAltRounded";
import ElderlyRoundedIcon from "@mui/icons-material/ElderlyRounded";
import MedicalServicesRoundedIcon from "@mui/icons-material/MedicalServicesRounded";
import ShareLocationRoundedIcon from "@mui/icons-material/ShareLocationRounded";
import { fetchPatients } from "../api/client";
import { MetricCard, PageHeader, StatusChip } from "../components/OperationsUI";

export function PatientRecordsPage() {
  const [search, setSearch] = useState("");
  const [hub, setHub] = useState("all");
  const [category, setCategory] = useState("all");
  const [language, setLanguage] = useState("all");
  const [status, setStatus] = useState("all");
  const query = useQuery({ queryKey: ["patients"], queryFn: () => fetchPatients({ limit: 500 }), refetchInterval: 30_000 });
  const records = query.data || [];
  const filtered = records.filter((row) => (!search || `${row.id} ${row.name} ${row.assignedStaff}`.toLowerCase().includes(search.toLowerCase()))
    && (hub === "all" || row.hub === hub) && (category === "all" || row.careCategory === category)
    && (language === "all" || row.language.toLowerCase().includes(language)) && (status === "all" || row.status === status));
  const active = records.filter((row) => row.status === "active").length;
  const categories = [...new Set(records.map((row) => row.careCategory).filter((value) => value !== "Not specified"))];
  const hubs = [...new Set(records.map((row) => row.hub).filter((value) => value !== "Not specified"))];

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="HOME HEALTH / ASSIGNMENT DIRECTORY" title="Patient records" description="Patient details are derived from current attendance assignments in this service." actions={<><Button variant="outlined" startIcon={<DownloadRoundedIcon />} disabled>Export</Button><Button variant="outlined" startIcon={<PersonAddAltRoundedIcon />} disabled>Add patient</Button></>} />
    {query.isError && <Alert severity="error">Could not load patient assignment records from the backend.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Patients with assignments" value={query.isLoading ? "—" : String(records.length)} detail="Unique patient IDs in sessions" icon={<ElderlyRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Active assignment" value={query.isLoading ? "—" : String(active)} detail="Sessions currently active" icon={<MedicalServicesRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Care categories" value={query.isLoading ? "—" : String(categories.length)} detail="Categories supplied in assignments" icon={<MedicalServicesRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="GPS perimeter" value="Not connected" detail="Location verification is unavailable" icon={<ShareLocationRoundedIcon />} tint="#edf1f8" accent="#69778d" /></Grid>
    </Grid>
    <Card>
      <Stack direction={{ xs: "column", xl: "row" }} spacing={1.2} sx={{ p: 2, borderBottom: "1px solid #e8edf3" }}>
        <TextField size="small" label="Search patient, ID, or employee" value={search} onChange={(event) => setSearch(event.target.value)} sx={{ flex: 1, minWidth: 220 }} />
        <FormControl size="small" sx={{ minWidth: 150 }}><InputLabel>Hub</InputLabel><Select label="Hub" value={hub} onChange={(event) => setHub(event.target.value)}><MenuItem value="all">All hubs</MenuItem>{hubs.map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}</Select></FormControl>
        <FormControl size="small" sx={{ minWidth: 165 }}><InputLabel>Care category</InputLabel><Select label="Care category" value={category} onChange={(event) => setCategory(event.target.value)}><MenuItem value="all">All categories</MenuItem>{categories.map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}</Select></FormControl>
        <FormControl size="small" sx={{ minWidth: 140 }}><InputLabel>Language</InputLabel><Select label="Language" value={language} onChange={(event) => setLanguage(event.target.value)}><MenuItem value="all">All languages</MenuItem>{["ta", "en", "ml", "te"].map((value) => <MenuItem key={value} value={value}>{value.toUpperCase()}</MenuItem>)}</Select></FormControl>
        <FormControl size="small" sx={{ minWidth: 145 }}><InputLabel>Session state</InputLabel><Select label="Session state" value={status} onChange={(event) => setStatus(event.target.value)}><MenuItem value="all">All states</MenuItem>{["active", "completed", "exception", "cancelled"].map((value) => <MenuItem key={value} value={value} sx={{ textTransform: "capitalize" }}>{value}</MenuItem>)}</Select></FormControl>
        <Chip label={`${filtered.length} records`} variant="outlined" sx={{ alignSelf: { xs: "flex-start", xl: "center" } }} />
      </Stack>
      {query.isLoading && <LinearProgress />}
      <TableContainer><Table size="small" aria-label="Patient assignment directory"><TableHead><TableRow>{["Patient & ID", "Hub", "Care category", "Assigned employee", "Language", "Location check", "Session status"].map((item) => <TableCell key={item} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{item}</TableCell>)}</TableRow></TableHead><TableBody>{filtered.map((row) => <TableRow key={`${row.id}:${row.assignedStaff}`} hover><TableCell><Typography variant="body2" fontWeight={700}>{row.name}</Typography><Typography variant="caption" color="text.secondary">{row.id}</Typography></TableCell><TableCell>{row.hub}</TableCell><TableCell>{row.careCategory}</TableCell><TableCell><Typography variant="body2">{row.assignedStaff}</Typography><Typography variant="caption" color="text.secondary">{row.employeeId || "Employee ID unavailable"}</Typography></TableCell><TableCell>{row.language.toUpperCase()}</TableCell><TableCell><StatusChip status={row.locationVerification} /></TableCell><TableCell><StatusChip status={row.status} /></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {query.isSuccess && filtered.length === 0 && <Typography align="center" color="text.secondary" sx={{ py: 5 }}>No patient assignments are available for these filters.</Typography>}
    </Card>
  </Stack>;
}
