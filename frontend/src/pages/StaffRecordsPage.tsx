import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import PersonAddAltRoundedIcon from "@mui/icons-material/PersonAddAltRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import MedicalServicesRoundedIcon from "@mui/icons-material/MedicalServicesRounded";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import PhoneIphoneRoundedIcon from "@mui/icons-material/PhoneIphoneRounded";
import { fetchStaff, type StaffRecord } from "../api/client";
import { MetricCard, PageHeader, SearchFilterBar, StatusChip } from "../components/OperationsUI";

export function StaffRecordsPage() {
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<StaffRecord | null>(null);
  const query = useQuery({ queryKey: ["staff"], queryFn: () => fetchStaff({ limit: 500 }), refetchInterval: 30_000 });
  const records = query.data || [];
  const filtered = records.filter((row) => (!search || `${row.name} ${row.id} ${row.patientName} ${row.address}`.toLowerCase().includes(search.toLowerCase()))
    && (language === "all" || row.language.toLowerCase() === language)
    && (status === "all" || row.dutyStatus === status));
  const languages = [...new Set(records.map((row) => row.language.toLowerCase()))];
  const active = records.filter((row) => row.dutyStatus === "on duty").length;
  const contacts = records.filter((row) => row.phoneMasked).length;
  const activeFilters = Number(language !== "all") + Number(status !== "all");

  return <Stack spacing={2.5}>
    <PageHeader eyebrow="WORKFORCE / ATTENDANCE ASSIGNMENTS" title="Staff records" description="Staff entries are derived from saved attendance assignments. Contact values are masked by the API." actions={<><Button variant="outlined" startIcon={<DownloadRoundedIcon />} disabled={!records.length}>Export</Button><Button variant="outlined" startIcon={<PersonAddAltRoundedIcon />} disabled>Add caregiver</Button></>} />
    {query.isError && <Alert severity="error">Could not load staff records from the backend.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Employees in assignments" value={query.isLoading ? "—" : String(records.length)} detail="Unique employee IDs" icon={<GroupRoundedIcon />} /></Grid>
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
          <FormControl size="small" fullWidth><InputLabel>Session state</InputLabel><Select label="Session state" value={status} onChange={(event) => setStatus(event.target.value)}><MenuItem value="all">All states</MenuItem>{["on duty", "exception", "completed", "cancelled"].map((value) => <MenuItem key={value} value={value} sx={{ textTransform: "capitalize" }}>{value}</MenuItem>)}</Select></FormControl>
        </>}
      />
      {query.isLoading && <LinearProgress />}
      <TableContainer><Table size="small" aria-label="Staff directory" sx={{ minWidth: 1050 }}><TableHead><TableRow>{["Staff identity", "Contact", "Staff address", "Calling language", "Current patient", "Assignment", "Session state", "Profile"].map((item) => <TableCell key={item} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{item}</TableCell>)}</TableRow></TableHead><TableBody>{filtered.map((row) => <TableRow key={`${row.id}:${row.assignmentId}`} hover><TableCell><Typography variant="body2" fontWeight={700}>{row.name}</Typography><Typography variant="caption" color="text.secondary">{row.id}</Typography></TableCell><TableCell>{row.phoneMasked || "Not supplied"}</TableCell><TableCell sx={{ minWidth: 220, maxWidth: 320, whiteSpace: "normal" }}>{row.address || "Not provided"}</TableCell><TableCell>{row.language.toUpperCase()}</TableCell><TableCell>{row.patientName}</TableCell><TableCell>{row.assignmentId}</TableCell><TableCell><StatusChip status={row.dutyStatus} /></TableCell><TableCell><Button size="small" onClick={() => setSelected(row)}>View</Button></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {query.isSuccess && filtered.length === 0 && <Typography color="text.secondary" align="center" sx={{ py: 5 }}>No employee assignments match these filters.</Typography>}
    </Card>
    <Dialog open={Boolean(selected)} onClose={() => setSelected(null)} fullWidth maxWidth="sm">{selected && <><DialogTitle>Employee assignment · {selected.id}</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ pt: 1 }}><Typography variant="h6">{selected.name}</Typography><Typography variant="body2">Calling language: {selected.language.toUpperCase()}</Typography><Typography variant="body2" color="text.secondary">Registered employee phone: {selected.phoneMasked || "Not available"}</Typography><Typography variant="body2" color="text.secondary">Staff address: {selected.address || "Not provided"}</Typography><Typography variant="body2" color="text.secondary">Current patient: {selected.patientName}</Typography><Typography variant="body2" color="text.secondary">Assignment: {selected.assignmentId}</Typography><Alert severity="info">Voice biometrics and carrier whitelist checks are not connected in this service.</Alert></Stack></DialogContent><DialogActions><Button onClick={() => setSelected(null)}>Close profile</Button></DialogActions></>}</Dialog>
  </Stack>;
}
