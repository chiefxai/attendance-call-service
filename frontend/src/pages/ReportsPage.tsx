import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, Grid, LinearProgress, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import GroupRoundedIcon from "@mui/icons-material/GroupRounded";
import HowToRegRoundedIcon from "@mui/icons-material/HowToRegRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import CrisisAlertRoundedIcon from "@mui/icons-material/CrisisAlertRounded";
import { fetchAttendance, fetchOperationsSummary, type AttendanceRecord } from "../api/client";
import { MetricCard, PageHeader } from "../components/OperationsUI";

function downloadCsv(rows: AttendanceRecord[]) {
  const columns = ["Assignment", "Patient", "Caregiver", "Schedule start UTC", "Schedule end UTC", "Actual check-in", "Actual check-out", "Check-in status", "Check-out status", "Backend delivery status"];
  const content = [columns, ...rows.map((row) => [row.assignmentId,row.patient.name,row.employee.name,row.scheduledStartAt,row.scheduledEndAt,row.checkIn.reportedAt || "",row.checkOut.reportedAt || "",row.checkIn.status,row.checkOut.status,row.backendDeliveryStatus])]
    .map((values) => values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "athulya-attendance-report.csv"; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ReportsPage({ embedded = false }: { embedded?: boolean }) {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const summary = useQuery({ queryKey: ["operations-summary"], queryFn: fetchOperationsSummary });
  const query = useQuery({ queryKey: ["attendance", "report"], queryFn: () => fetchAttendance({ limit: 500 }), refetchInterval: 30_000 });
  const rows = useMemo(() => (query.data || []).filter((row) => {
    const date = row.scheduledStartAt.slice(0, 10);
    return (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
  }), [query.data, fromDate, toDate]);
  const sessionsComplete = rows.filter((row) => row.checkIn.status === "confirmed" && row.checkOut.status === "confirmed").length;
  const errors = query.error instanceof Error ? query.error.message : "Unable to load reports";
  return <Stack spacing={2.5}>
    {!embedded && <PageHeader title="Reports" actions={<Button variant="contained" startIcon={<FileDownloadRoundedIcon />} disabled={!rows.length} onClick={() => downloadCsv(rows)}>Export CSV</Button>} />}
    {embedded && <Stack direction="row" justifyContent="flex-end"><Button variant="contained" startIcon={<FileDownloadRoundedIcon />} disabled={!rows.length} onClick={() => downloadCsv(rows)}>Export CSV</Button></Stack>}
    {(query.isError || summary.isError) && <Alert severity="error">{errors}</Alert>}
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 12, sm: 6, md: 3 }}><MetricCard label="Schedules" value={rows.length.toLocaleString()} detail="In the selected date range" icon={<GroupRoundedIcon />} /></Grid>
      <Grid size={{ xs: 12, sm: 6, md: 3 }}><MetricCard label="Both stages verified" value={sessionsComplete.toLocaleString()} detail="Confirmed check-in and check-out" icon={<HowToRegRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 12, sm: 6, md: 3 }}><MetricCard label="Pending today" value={summary.data?.checkInsPending.toLocaleString() ?? "—"} detail="Check-in awaiting confirmation" icon={<PendingActionsRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 12, sm: 6, md: 3 }}><MetricCard label="Exceptions" value={summary.data?.exceptions.toLocaleString() ?? "—"} detail="Needs operations follow-up" icon={<CrisisAlertRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
    </Grid>
    <Card sx={{ p: 2 }}><Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems="center"><TextField type="date" label="From date" InputLabelProps={{ shrink: true }} value={fromDate} onChange={(event) => setFromDate(event.target.value)} /><TextField type="date" label="To date" InputLabelProps={{ shrink: true }} value={toDate} onChange={(event) => setToDate(event.target.value)} /><Chip label={`${rows.length} records`} variant="outlined" /></Stack>
      <Alert severity="info" sx={{ mt: 2 }}>Athulya check-in/check-out export is awaiting the official API specification. These reports show the locally verified attendance records.</Alert>
      {query.isLoading && <LinearProgress sx={{ mt: 2 }} />}
      <TableContainer sx={{ mt: 2 }}><Table size="small"><TableHead><TableRow>{["Patient", "Caregiver", "Scheduled interval", "Actual check-in", "Actual check-out", "Status", "Athulya export"].map((label) => <TableCell key={label} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead><TableBody>
        {rows.map((row) => <TableRow key={row.sessionId} hover><TableCell><Typography fontWeight={650}>{row.patient.name}</Typography><Typography variant="caption" color="text.secondary">{row.patient.id || "ID unavailable"}</Typography></TableCell><TableCell><Typography fontWeight={650}>{row.employee.name}</Typography><Typography variant="caption" color="text.secondary">{row.employee.companyName || "ATHULYA"}</Typography></TableCell><TableCell>{new Date(row.scheduledStartAt).toLocaleString()}<Typography variant="caption" display="block" color="text.secondary">to {new Date(row.scheduledEndAt).toLocaleString()}</Typography></TableCell><TableCell>{row.checkIn.reportedAt ? new Date(row.checkIn.reportedAt).toLocaleString() : "—"}</TableCell><TableCell>{row.checkOut.reportedAt ? new Date(row.checkOut.reportedAt).toLocaleString() : "—"}</TableCell><TableCell>{row.checkIn.status} / {row.checkOut.status}</TableCell><TableCell>Awaiting API specification</TableCell></TableRow>)}
        {rows.length === 0 && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5 }}>No attendance sessions match this date range.</TableCell></TableRow>}
      </TableBody></Table></TableContainer>
    </Card>
  </Stack>;
}
