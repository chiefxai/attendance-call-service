import { useState } from "react";
import { OperationsTable } from "../components/OperationsUI";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Chip, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TablePagination, TableRow, TextField, Typography } from "@mui/material";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import { fetchAttendance, fetchAttendanceCount, type AttendanceRecord } from "../api/client";
import { formatAppDateTime, APP_TIME_ZONE } from "../utils/dateTime";

function downloadCsv(rows: AttendanceRecord[]) {
  const columns = ["Assignment", "Patient", "Caregiver", "Schedule start UTC", "Schedule end UTC", "Actual check-in", "Actual check-out", "Check-in status", "Check-out status", "Backend delivery status"];
  const content = [columns, ...rows.map((row) => [row.assignmentId,row.patient.name,row.employee.name,row.scheduledStartAt,row.scheduledEndAt,row.checkIn.reportedAt || "",row.checkOut.reportedAt || "",row.checkIn.status,row.checkOut.status,row.backendDeliveryStatus])]
    .map((values) => values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "athulya-attendance-report.csv"; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ReportsPage() {
  const queryClient = useQueryClient();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const query = useQuery({ queryKey: ["attendance", "report", fromDate, toDate, page, rowsPerPage], queryFn: () => fetchAttendance({ fromDate: fromDate || undefined, toDate: toDate || undefined, limit: rowsPerPage, offset: page * rowsPerPage }), refetchInterval: 30_000 });
  const countQuery = useQuery({ queryKey: ["attendance", "report-count", fromDate, toDate], queryFn: () => fetchAttendanceCount({ fromDate: fromDate || undefined, toDate: toDate || undefined }), refetchInterval: 30_000 });
  const rows = query.data || [];
  const totalRows = countQuery.data ?? rows.length;
  const exportReport = async () => {
    const exportRows = await queryClient.fetchQuery({
      queryKey: ["attendance", "report-export", fromDate, toDate],
      queryFn: () => fetchAttendance({ fromDate: fromDate || undefined, toDate: toDate || undefined, limit: 500 }),
      staleTime: 30_000,
    });
    downloadCsv(exportRows);
  };
  return <Card sx={{ p: 2 }}>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
        <TextField type="date" label="From date" InputLabelProps={{ shrink: true }} value={fromDate} onChange={(event) => { setFromDate(event.target.value); setPage(0); }} size="small" />
        <TextField type="date" label="To date" InputLabelProps={{ shrink: true }} value={toDate} onChange={(event) => { setToDate(event.target.value); setPage(0); }} size="small" />
        <Chip label={`${totalRows.toLocaleString()} records`} variant="outlined" />
      </Stack>
      <Button variant="contained" startIcon={<FileDownloadRoundedIcon />} disabled={!totalRows} onClick={() => void exportReport()}>Export CSV</Button>
    </Stack>
    <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>Times shown in {APP_TIME_ZONE}. CSV timestamps are UTC.</Typography>
    {query.isLoading && <LinearProgress sx={{ mt: 2 }} />}
    {query.isError && <Typography color="error" sx={{ mt: 2 }}>Unable to load attendance records.</Typography>}
    <OperationsTable sx={{ mt: 2 }}><Table size="small"><TableHead><TableRow>{["Patient", "Caregiver", "Scheduled interval", "Actual check-in", "Actual check-out", "Status", "Athulya export"].map((label) => <TableCell key={label} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{label}</TableCell>)}</TableRow></TableHead><TableBody>
      {rows.map((row) => <TableRow key={row.sessionId} hover><TableCell><Typography fontWeight={650}>{row.patient.name}</Typography><Typography variant="caption" color="text.secondary">{row.patient.id || "ID unavailable"}</Typography></TableCell><TableCell><Typography fontWeight={650}>{row.employee.name}</Typography><Typography variant="caption" color="text.secondary">{row.employee.companyName || "ATHULYA"}</Typography></TableCell><TableCell>{formatAppDateTime(row.scheduledStartAt)}<Typography variant="caption" display="block" color="text.secondary">to {formatAppDateTime(row.scheduledEndAt)}</Typography></TableCell><TableCell>{formatAppDateTime(row.checkIn.reportedAt)}</TableCell><TableCell>{formatAppDateTime(row.checkOut.reportedAt)}</TableCell><TableCell>{row.checkIn.status} / {row.checkOut.status}</TableCell><TableCell>Awaiting API specification</TableCell></TableRow>)}
      {!query.isLoading && rows.length === 0 && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5 }}>No attendance sessions match this date range.</TableCell></TableRow>}
    </TableBody></Table></OperationsTable>
    <TablePagination component="div" count={totalRows} page={page} onPageChange={(_, nextPage) => setPage(nextPage)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Sessions per page" />
  </Card>;
}
