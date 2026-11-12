import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Chip, Grid, LinearProgress, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import VerifiedUserRoundedIcon from "@mui/icons-material/VerifiedUserRounded";
import SmartToyRoundedIcon from "@mui/icons-material/SmartToyRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import { fetchAttendanceLedger, type AttendanceRecord } from "../api/client";
import { MetricCard, PageHeader, StatusChip } from "../components/OperationsUI";

const dateTime = (value: string | null) => value ? new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—";
function exportLedger(rows: AttendanceRecord[]) {
  const header = ["Session ID", "Assignment", "Staff", "Patient", "Shift start", "Shift end", "Check-in", "Check-out", "Delivery state"];
  const csv = [header, ...rows.map((row) => [row.sessionId, row.assignmentId, row.employee.name, row.patient.name, row.scheduledStartAt, row.scheduledEndAt, row.checkIn.reportedAt || "", row.checkOut.reportedAt || "", row.backendDeliveryStatus])]
    .map((values) => values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "attendance-ledger.csv"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ApprovedLedgerPage() {
  const query = useQuery({ queryKey: ["attendance-ledger"], queryFn: () => fetchAttendanceLedger({ limit: 500 }), refetchInterval: 30_000 });
  const entries = query.data || [];
  const delivered = entries.filter((row) => row.backendDeliveryStatus === "delivered").length;
  const pending = entries.filter((row) => row.backendDeliveryStatus !== "delivered").length;

  return <Stack spacing={2.5}>
    <Alert severity="info" icon={<SyncRoundedIcon />}>Completed sessions are read from PostgreSQL. Delivery goes through the host-provided backend adapter using the session ID as an idempotency key.</Alert>
    <PageHeader eyebrow="ATTENDANCE / COMPLETED SESSIONS" title="Approved attendance ledger" description="Review sessions with confirmed employee check-in and check-out, along with backend delivery status." actions={<><Button variant="outlined" disabled>Trigger real-time sync</Button><Button variant="contained" disabled={!entries.length} onClick={() => exportLedger(entries)}>Export CSV</Button></>} />
    {query.isError && <Alert severity="error">Could not load completed attendance sessions.</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Confirmed sessions" value={query.isLoading ? "—" : String(entries.length)} detail="Both attendance stages confirmed" icon={<VerifiedUserRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Attendance captured" value={query.isLoading ? "—" : String(entries.length)} detail="Check-in and check-out times present" icon={<SmartToyRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Backend delivered" value={query.isLoading ? "—" : String(delivered)} detail="Host adapter acknowledged delivery" icon={<BoltRoundedIcon />} tint="#e9efff" accent="#1557c0" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard label="Delivery pending" value={query.isLoading ? "—" : String(pending)} detail="Pending or failed adapter response" icon={<SyncRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
    </Grid>
    <Card sx={{ p: { xs: 2, sm: 2.75 } }}>
      <Typography variant="h6">Session delivery flow</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4, mb: 2 }}>This is the service's actual completion and delivery sequence.</Typography>
      <Grid container spacing={1.5}>{[{ n: "01", title: "Check-in confirmed", text: "Employee and assigned patient are verified; reported arrival time is stored." }, { n: "02", title: "Check-out confirmed", text: "Duty completion and reported departure time are stored." }, { n: "03", title: "Deliver to host", text: "The backend adapter sends one session payload using an idempotency key." }].map((step) => <Grid key={step.n} size={{ xs: 12, md: 4 }}><Card variant="outlined" sx={{ p: 1.75, boxShadow: "none", borderColor: "#e6ebf2", height: "100%" }}><Chip size="small" label={step.n} color="primary" variant="outlined" /><Typography variant="body2" fontWeight={700} sx={{ mt: 1.2 }}>{step.title}</Typography><Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .6, lineHeight: 1.55 }}>{step.text}</Typography></Card></Grid>)}</Grid>
    </Card>
    <Card>
      {query.isLoading && <LinearProgress />}
      <TableContainer><Table size="small" aria-label="Approved attendance ledger"><TableHead><TableRow>{["Session / assignment", "Employee", "Patient", "Scheduled shift", "Check-in", "Check-out", "Backend delivery"].map((label) => <TableCell key={label} sx={{ bgcolor: "#f7f9fc", fontWeight: 750, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{entries.map((row) => <TableRow key={row.sessionId} hover><TableCell><Typography variant="body2" fontWeight={700}>{row.sessionId.slice(0, 8)}</Typography><Typography variant="caption" color="text.secondary">{row.assignmentId}</Typography></TableCell><TableCell>{row.employee.name}</TableCell><TableCell>{row.patient.name}</TableCell><TableCell>{dateTime(row.scheduledStartAt)}<Typography variant="caption" display="block" color="text.secondary">to {dateTime(row.scheduledEndAt)}</Typography></TableCell><TableCell>{dateTime(row.checkIn.reportedAt)}</TableCell><TableCell>{dateTime(row.checkOut.reportedAt)}</TableCell><TableCell><StatusChip status={row.backendDeliveryStatus} /></TableCell></TableRow>)}</TableBody></Table></TableContainer>
      {query.isSuccess && entries.length === 0 && <Box sx={{ py: 5, textAlign: "center" }}><Typography fontWeight={700}>No completed attendance sessions yet</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>A session appears here after both check-in and check-out are confirmed.</Typography></Box>}
    </Card>
  </Stack>;
}
