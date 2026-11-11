import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Grid, MenuItem, Stack, TextField, Typography } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import UploadFileRoundedIcon from "@mui/icons-material/UploadFileRounded";
import { AxiosError } from "axios";
import { createAssignment, fetchAgents, fetchEmployeeScheduleOverlap, fetchPatients, fetchStaff, type AssignmentPayload } from "../api/client";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/OperationsUI";
import { INDIAN_MOBILE_ERROR, normalizeIndianMobile } from "../utils/phone";
import { AddressFields } from "../components/AddressFields";

interface FormValues {
  assignmentId: string;
  agentId: string;
  fromNumber: string;
  language: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  employeeId: string;
  employeeName: string;
  employeeCompanyName: string;
  employeePhone: string;
  employeeAddress: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  patientAddress: string;
}

function localInputValue(date: Date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function formatLocalDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
}

function getBrowserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function toUtcIso(value: string) {
  return new Date(value).toISOString();
}

function callLanguageCode(language: string) {
  const normalized = language.trim().toLowerCase();
  if (normalized.startsWith("ta") || normalized.includes("tamil")) return "ta";
  if (normalized.startsWith("ml") || normalized.includes("malayalam")) return "ml";
  if (normalized.startsWith("te") || normalized.includes("telugu")) return "te";
  return "en";
}

const now = new Date();
const shiftEnd = new Date(now.getTime() + 8 * 60 * 60_000);

const initialValues: FormValues = {
  assignmentId: "", agentId: "", fromNumber: "", language: "ta",
  scheduledStartAt: localInputValue(now), scheduledEndAt: localInputValue(shiftEnd),
  employeeId: "", employeeName: "", employeeCompanyName: "", employeePhone: "", employeeAddress: "",
  patientId: "", patientName: "", patientPhone: "", patientAddress: "",
};

const BULK_HEADERS = ["assignmentId", "agentId", "fromNumber", "language", "scheduledStartAt", "scheduledEndAt", "employeeId", "employeeName", "employeeCompanyName", "employeePhone", "employeeAddress", "patientId", "patientName", "patientPhone", "patientAddress", "timeZone"];
const MAX_BULK_ROWS = 200;
interface BulkAssignmentRow { line: number; payload?: AssignmentPayload; errors: string[]; }
interface BulkAssignmentResult { sessionId?: string; error?: string; }

function parseCsvRows(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if (char === "\n" && !quoted) {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value.trim())) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("The CSV contains an unclosed quoted field.");
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function parseBulkAssignments(csv: string, activeAgentIds: Set<string>): { rows: BulkAssignmentRow[]; error?: string } {
  let sourceRows: string[][];
  try { sourceRows = parseCsvRows(csv); }
  catch (error) { return { rows: [], error: error instanceof Error ? error.message : "Could not read this CSV." }; }
  if (sourceRows.length < 2) return { rows: [], error: "The CSV needs a header row and at least one assignment row." };
  const headers = sourceRows[0].map((value) => value.trim());
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const optionalHeaders = ["fromNumber", "employeeCompanyName", "patientPhone", "timeZone"];
  const missingHeaders = BULK_HEADERS.filter((header) => !optionalHeaders.includes(header) && !indexes.has(header));
  if (missingHeaders.length) return { rows: [], error: "Missing CSV columns: " + missingHeaders.join(", ") };
  const dataRows = sourceRows.slice(1);
  if (dataRows.length > MAX_BULK_ROWS) return { rows: [], error: "Upload no more than " + MAX_BULK_ROWS + " assignments at once." };
  const seenAssignments = new Set<string>();
  const languageMap: Record<string, string> = { ta: "ta", tamil: "ta", en: "en", english: "en", ml: "ml", malayalam: "ml", te: "te", telugu: "te" };
  const rows = dataRows.map((cells, index): BulkAssignmentRow => {
    const get = (field: string) => cells[indexes.get(field) ?? -1]?.trim() || "";
    const line = index + 2;
    const assignmentId = get("assignmentId");
    const agentId = get("agentId");
    const language = languageMap[get("language").toLowerCase()];
    const startValue = get("scheduledStartAt");
    const endValue = get("scheduledEndAt");
    const assignmentTimeZone = get("timeZone") || getBrowserTimeZone();
    const hasTimezone = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    const startAt = Date.parse(startValue);
    const endAt = Date.parse(endValue);
    const errors: string[] = [];
    const employeePhoneInput = get("employeePhone");
    const employeePhone = normalizeIndianMobile(employeePhoneInput);
    const patientPhoneInput = get("patientPhone");
    const patientPhone = patientPhoneInput ? normalizeIndianMobile(patientPhoneInput) : "";
    try { new Intl.DateTimeFormat("en-US", { timeZone: assignmentTimeZone }).format(); }
    catch { errors.push("timeZone must be a valid IANA timezone"); }
    if (!assignmentId) errors.push("assignmentId is required");
    else if (seenAssignments.has(assignmentId)) errors.push("assignmentId is duplicated in this file");
    else seenAssignments.add(assignmentId);
    if (!agentId || !activeAgentIds.has(agentId)) errors.push("agentId must match an active agent");
    if (!language) errors.push("language must be ta, en, ml, or te");
    if (!startValue || !hasTimezone(startValue) || !Number.isFinite(startAt)) errors.push("scheduledStartAt must be ISO 8601 with a timezone");
    if (!endValue || !hasTimezone(endValue) || !Number.isFinite(endAt)) errors.push("scheduledEndAt must be ISO 8601 with a timezone");
    if (Number.isFinite(startAt) && Number.isFinite(endAt) && endAt <= startAt) errors.push("scheduledEndAt must be after scheduledStartAt");
    if (employeePhoneInput && !employeePhone) errors.push("employeePhone must be a valid Indian mobile number (10 digits, optionally prefixed with 91 or +91)");
    if (patientPhoneInput && !patientPhone) errors.push("patientPhone must be a valid Indian mobile number (10 digits, optionally prefixed with 91 or +91)");
    for (const field of ["employeeId", "employeeName", "employeePhone", "employeeAddress", "patientId", "patientName", "patientAddress"]) {
      if (!get(field)) errors.push(field + " is required");
    }
    const payload: AssignmentPayload = {
      assignmentId, agentId, fromNumber: get("fromNumber"), language: language || "en",
      scheduledStartAt: Number.isFinite(startAt) ? new Date(startAt).toISOString() : "",
      scheduledEndAt: Number.isFinite(endAt) ? new Date(endAt).toISOString() : "",
      metadata: { timeZone: assignmentTimeZone },
      employee: { id: get("employeeId"), name: get("employeeName"), companyName: get("employeeCompanyName"), phoneNumber: employeePhone || employeePhoneInput, address: get("employeeAddress") },
      patient: { id: get("patientId"), name: get("patientName"), address: get("patientAddress"), phoneNumber: patientPhone || undefined },
    };
    return { line, payload: errors.length ? undefined : payload, errors };
  });
  return { rows };
}

function downloadBulkTemplate() {
  const csv = BULK_HEADERS.join(",") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = "attendance-assignments-template.csv";
  link.click(); URL.revokeObjectURL(url);
}

function requestError(error: unknown) {
  if (error instanceof AxiosError) return error.response?.data?.error || error.message;
  return error instanceof Error ? error.message : "Request failed";
}

function FormField({ label, value, onChange, required = false, type = "text", helperText, multiline = false, rows, error = false, onBlur, readOnly = false }: {
  label: string; value: string; onChange: (value: string) => void; required?: boolean;
  type?: string; helperText?: string; multiline?: boolean; rows?: number; error?: boolean; onBlur?: () => void; readOnly?: boolean;
}) {
  return <TextField fullWidth size="small" label={label} value={value} required={required} type={type} helperText={helperText} error={error} multiline={multiline} rows={rows} onBlur={onBlur} onChange={(event) => onChange(event.target.value)} InputProps={readOnly ? { readOnly: true } : undefined} InputLabelProps={type === "datetime-local" ? { shrink: true } : undefined} />;
}

export function NewAssignmentPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(initialValues);
  const [phoneError, setPhoneError] = useState("");
  const [patientPhoneError, setPatientPhoneError] = useState("");
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [bulkRows, setBulkRows] = useState<BulkAssignmentRow[]>([]);
  const [bulkFileError, setBulkFileError] = useState("");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResults, setBulkResults] = useState<Record<number, BulkAssignmentResult>>({});
  const [overlapWindow, setOverlapWindow] = useState({ employeeId: "", startAt: "", endAt: "", assignmentId: "" });
  useEffect(() => {
    const timer = window.setTimeout(() => setOverlapWindow({
      employeeId: form.employeeId.trim(),
      startAt: form.scheduledStartAt,
      endAt: form.scheduledEndAt,
      assignmentId: form.assignmentId.trim(),
    }), 400);
    return () => window.clearTimeout(timer);
  }, [form.employeeId, form.scheduledStartAt, form.scheduledEndAt, form.assignmentId]);
  const agents = useQuery({ queryKey: ["agents"], queryFn: fetchAgents, retry: 0 });
  const staff = useQuery({ queryKey: ["staff"], queryFn: () => fetchStaff({ limit: 500 }), retry: 0 });
  const patients = useQuery({ queryKey: ["patients"], queryFn: () => fetchPatients({ limit: 500 }), retry: 0 });
  const overlapStartMs = new Date(overlapWindow.startAt).getTime();
  const overlapEndMs = new Date(overlapWindow.endAt).getTime();
  const overlapEnabled = Boolean(overlapWindow.employeeId)
    && Number.isFinite(overlapStartMs) && Number.isFinite(overlapEndMs) && overlapEndMs > overlapStartMs;
  const employeeOverlap = useQuery({
    queryKey: ["employee-schedule-overlap", overlapWindow],
    queryFn: () => fetchEmployeeScheduleOverlap({
      employeeId: overlapWindow.employeeId,
      startAt: new Date(overlapStartMs).toISOString(),
      endAt: new Date(overlapEndMs).toISOString(),
      assignmentId: overlapWindow.assignmentId || undefined,
    }),
    enabled: overlapEnabled,
    retry: 0,
  });
  const mutation = useMutation({
    mutationFn: createAssignment,
    onSuccess: (result) => navigate(`/sessions/${result.sessionId}`),
  });
  const update = (key: keyof FormValues) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const activeAgentIds = new Set(agents.data?.filter((agent) => agent.active).map((agent) => agent.id) || []);
  const validBulkCount = bulkRows.filter((row) => row.payload && !bulkResults[row.line]?.sessionId).length;
  const completedBulkCount = Object.values(bulkResults).filter((result) => result.sessionId).length;
  const handleBulkFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setBulkRows([]); setBulkResults({}); setBulkFileError("");
    if (file.size > 5 * 1024 * 1024) { setBulkFileError("CSV file must be 5 MB or smaller."); return; }
    try {
      const parsed = parseBulkAssignments(await file.text(), activeAgentIds);
      setBulkRows(parsed.rows); setBulkFileError(parsed.error || "");
    } catch (error) { setBulkFileError(requestError(error)); }
  };
  const submitBulk = async () => {
    if (bulkRunning) return;
    setBulkRunning(true); setBulkFileError("");
    try {
      for (const row of bulkRows) {
        if (!row.payload || bulkResults[row.line]?.sessionId) continue;
        try {
          const result = await createAssignment(row.payload);
          setBulkResults((current) => ({ ...current, [row.line]: { sessionId: result.sessionId } }));
        } catch (error) {
          setBulkResults((current) => ({ ...current, [row.line]: { error: requestError(error) } }));
        }
      }
    } finally { setBulkRunning(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const employeePhone = normalizeIndianMobile(form.employeePhone);
    const patientPhoneInput = form.patientPhone.trim();
    const patientPhone = patientPhoneInput ? normalizeIndianMobile(patientPhoneInput) : "";
    if (!employeePhone) { setPhoneError(INDIAN_MOBILE_ERROR); return; }
    if (patientPhoneInput && !patientPhone) { setPatientPhoneError(INDIAN_MOBILE_ERROR); return; }
    setPhoneError("");
    setPatientPhoneError("");
    const payload: AssignmentPayload = {
      assignmentId: form.assignmentId.trim(), agentId: form.agentId, fromNumber: form.fromNumber.trim(),
      language: form.language, scheduledStartAt: toUtcIso(form.scheduledStartAt),
      scheduledEndAt: toUtcIso(form.scheduledEndAt), metadata: { timeZone: getBrowserTimeZone() },
      employee: { id: form.employeeId.trim(), name: form.employeeName.trim(), companyName: form.employeeCompanyName.trim(), phoneNumber: employeePhone, address: form.employeeAddress.trim() },
      patient: { id: form.patientId.trim(), name: form.patientName.trim(), phoneNumber: patientPhone || undefined, address: form.patientAddress.trim() },
    };
    mutation.mutate(payload);
  };
  const errorMessage = mutation.error instanceof AxiosError
    ? mutation.error.response?.data?.error || mutation.error.message
    : mutation.error?.message;
  const selectStaff = (employeeId: string) => {
    const employee = staff.data?.find((row) => row.id === employeeId);
    if (!employee) return;
    setPhoneError("");
    setForm((current) => ({ ...current, employeeId: employee.id, employeeName: employee.name, employeeCompanyName: employee.companyName || "",
      employeePhone: employee.phoneNumber || "", employeeAddress: employee.address || "",
      language: employee.language ? callLanguageCode(employee.language) : current.language }));
  };
  const selectPatient = (patientId: string) => {
    const patient = patients.data?.find((row) => row.id === patientId);
    if (!patient) return;
    setPatientPhoneError("");
    setForm((current) => ({ ...current, patientId: patient.id, patientName: patient.name,
      patientPhone: patient.phoneNumber || "", patientAddress: patient.address || "" }));
  };

  const selectedEmployee = staff.data?.find((row) => row.id === form.employeeId) || null;
  const selectedPatient = patients.data?.find((row) => row.id === form.patientId) || null;
  const clearStaff = () => {
    setPhoneError("");
    setForm((current) => ({ ...current, employeeId: "", employeeName: "", employeeCompanyName: "", employeePhone: "", employeeAddress: "" }));
  };
  const clearPatient = () => {
    setPatientPhoneError("");
    setForm((current) => ({ ...current, patientId: "", patientName: "", patientPhone: "", patientAddress: "" }));
  };

  return (
    <Stack spacing={3}>
      <PageHeader eyebrow="SCHEDULE OUTBOUND CALLS" title="New assignment" description="Add the shift and contact details. The AI calls the employee at check-in and check-out times." />
      {mutation.isError && <Alert severity="error">Assignment could not be scheduled: {errorMessage}</Alert>}
      {agents.isError && <Alert severity="warning">Unable to load agents. Verify the API connection and workspace access.</Alert>}
      {(staff.isError || patients.isError) && <Alert severity="warning">Saved staff or patient records could not be loaded. You can still enter the details manually.</Alert>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant={mode === "single" ? "contained" : "outlined"} onClick={() => setMode("single")} disabled={mutation.isPending || bulkRunning}>Single assignment</Button>
        <Button variant={mode === "bulk" ? "contained" : "outlined"} onClick={() => setMode("bulk")} disabled={mutation.isPending || bulkRunning}>Bulk CSV upload</Button>
      </Stack>
      {mode === "single" ? (
      <Box component="form" onSubmit={submit}>
        <Stack spacing={2.5}>
          <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6">Shift and calling setup</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4, mb: 2.5 }}>Choose the active voice agent, language, and scheduled shift. Times are entered in {getBrowserTimeZone()} and sent to the API in UTC.</Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, sm: 6 }}><FormField label="Assignment ID" value={form.assignmentId} onChange={update("assignmentId")} required /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><TextField select fullWidth size="small" label="Calling agent" required value={form.agentId} onChange={(event) => update("agentId")(event.target.value)} disabled={agents.isLoading || agents.data?.length === 0}><MenuItem value="" disabled>Select an active agent</MenuItem>{agents.data?.filter((agent) => agent.active).map((agent) => <MenuItem key={agent.id} value={agent.id}>{agent.name}</MenuItem>)}</TextField></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><FormField label="Vobiz caller ID override (optional)" value={form.fromNumber} onChange={update("fromNumber")} helperText="Leave blank to use VOBIZ_FROM_NUMBER from the backend .env file." /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><TextField select fullWidth size="small" label="Call language" value={form.language} onChange={(event) => update("language")(event.target.value)}>{[{ value: "ta", label: "Tamil" }, { value: "en", label: "English" }, { value: "ml", label: "Malayalam" }, { value: "te", label: "Telugu" }].map((language) => <MenuItem key={language.value} value={language.value}>{language.label}</MenuItem>)}</TextField></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><FormField label="Scheduled check-in" value={form.scheduledStartAt} onChange={update("scheduledStartAt")} type="datetime-local" required /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><FormField label="Scheduled check-out" value={form.scheduledEndAt} onChange={update("scheduledEndAt")} type="datetime-local" required /></Grid>
            </Grid>
            {employeeOverlap.data?.overlap && employeeOverlap.data.conflict && <Alert severity="error">
              This employee already has assignment {employeeOverlap.data.conflict.assignmentId} for {employeeOverlap.data.conflict.patientName} from {formatLocalDateTime(employeeOverlap.data.conflict.scheduledStartAt)} to {formatLocalDateTime(employeeOverlap.data.conflict.scheduledEndAt)}. Choose a non-overlapping duty window.
            </Alert>}
          </CardContent></Card>
          <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6">Employee to call</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4, mb: 2.5 }}>The current outbound workflow only calls the employee.</Typography>
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid size={12}><TextField select fullWidth size="small" label="Select saved employee" value={staff.data?.some((row) => row.id === form.employeeId) ? form.employeeId : ""} onChange={(event) => event.target.value === "__new__" ? clearStaff() : selectStaff(event.target.value)} disabled={staff.isLoading} helperText={staff.data?.length ? "Stored name and mobile are locked. New staff details are saved when you create the assignment." : "Enter new employee details; they are saved to Staff records when you create the assignment."}>
                <MenuItem value="" disabled>{staff.isLoading ? "Loading saved employees…" : "Choose an employee"}</MenuItem>
                <MenuItem value="__new__">Enter new employee details</MenuItem>
                {staff.data?.map((employee) => <MenuItem key={employee.id} value={employee.id}>{employee.name}{employee.companyName ? ` · ${employee.companyName}` : ""} · {employee.id}{employee.phoneMasked ? ` · ${employee.phoneMasked}` : ""}</MenuItem>)}
              </TextField></Grid>
            </Grid>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, sm: 3 }}><FormField label="Employee ID" value={form.employeeId} onChange={update("employeeId")} required readOnly={Boolean(selectedEmployee)} /></Grid>
              <Grid size={{ xs: 12, sm: 3 }}><FormField label="Employee name" value={form.employeeName} onChange={update("employeeName")} required readOnly={Boolean(selectedEmployee)} /></Grid>
              <Grid size={{ xs: 12, sm: 3 }}><FormField label="Company / vendor name" value={form.employeeCompanyName} onChange={update("employeeCompanyName")} helperText={selectedEmployee ? "Stored company is locked. Edit it in Staff records if needed." : "Optional for independent staff."} readOnly={Boolean(selectedEmployee)} /></Grid>
              <Grid size={{ xs: 12, sm: 3 }}><FormField label="Employee mobile number" value={form.employeePhone} readOnly={Boolean(selectedEmployee)} helperText={phoneError || (selectedEmployee ? "Stored number is locked. Edit it in Staff records if needed." : "Enter 10 digits; 91 or +91 country code is optional.")} onChange={(value) => { setPhoneError(""); update("employeePhone")(value); }} required error={Boolean(phoneError)}  onBlur={() => { const normalized = normalizeIndianMobile(form.employeePhone); if (!normalized) setPhoneError(INDIAN_MOBILE_ERROR); else { setPhoneError(""); setForm((current) => ({ ...current, employeePhone: normalized })); } }} /></Grid>
              <Grid size={{ xs: 12, sm: 3 }}><AddressFields required value={form.employeeAddress} onChange={update("employeeAddress")} /></Grid>
            </Grid>
          </CardContent></Card>
          <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6">Assigned patient details</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .4, mb: 2.5 }}>Used to verify the assignment during the employee call. The patient is not called.</Typography>
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid size={12}><TextField select fullWidth size="small" label="Select saved patient" value={patients.data?.some((row) => row.id === form.patientId) ? form.patientId : ""} onChange={(event) => event.target.value === "__new__" ? clearPatient() : selectPatient(event.target.value)} disabled={patients.isLoading} helperText={patients.data?.length ? "Stored name and mobile are locked. New patient details are saved when you create the assignment." : "Enter new patient details; they are saved to Patient records when you create the assignment."}>
                <MenuItem value="" disabled>{patients.isLoading ? "Loading saved patients…" : "Choose a patient"}</MenuItem>
                <MenuItem value="__new__">Enter new patient details</MenuItem>
                {patients.data?.map((patient) => <MenuItem key={patient.id} value={patient.id}>{patient.name} · {patient.id}</MenuItem>)}
              </TextField></Grid>
            </Grid>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Patient ID" value={form.patientId} onChange={update("patientId")} required readOnly={Boolean(selectedPatient)} /></Grid>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Patient name" value={form.patientName} onChange={update("patientName")} required readOnly={Boolean(selectedPatient)} /></Grid>
              <Grid size={{ xs: 12, sm: 4 }}><FormField label="Patient mobile number (optional)" value={form.patientPhone} readOnly={Boolean(selectedPatient)} helperText={patientPhoneError || (selectedPatient ? "Stored number is locked. Edit it in Patient records if needed." : "If provided, enter 10 digits; 91 or +91 is optional. The patient is not called.")} onChange={(value) => { setPatientPhoneError(""); update("patientPhone")(value); }} error={Boolean(patientPhoneError)}  onBlur={() => { const input = form.patientPhone.trim(); if (!input) { setPatientPhoneError(""); return; } const normalized = normalizeIndianMobile(input); if (!normalized) setPatientPhoneError(INDIAN_MOBILE_ERROR); else { setPatientPhoneError(""); setForm((current) => ({ ...current, patientPhone: normalized })); } }} /></Grid>
              <Grid size={12}><AddressFields required value={form.patientAddress} onChange={update("patientAddress")} /></Grid>
            </Grid>
          </CardContent></Card>
          <Stack direction="row" justifyContent="flex-end" alignItems="center" spacing={2}>
            <Typography variant="caption" color="text.secondary">Calls are queued for the employee only.</Typography>
            <Button type="submit" variant="contained" endIcon={mutation.isPending ? <CircularProgress size={16} color="inherit" /> : <ArrowForwardRoundedIcon />} disabled={mutation.isPending || employeeOverlap.data?.overlap === true || agents.isLoading || !agents.data?.some((agent) => agent.id === form.agentId && agent.active)} sx={{ px: 2.5, py: 1.1 }}>{mutation.isPending ? "Scheduling…" : "Create assignment"}</Button>
          </Stack>
        </Stack>
      </Box>
      ) : (
        <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={2}>
            <Box><Typography variant="h6">Create multiple sessions</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>Upload a CSV with one assignment per row. Each row creates its own session and queues its check-in and check-out calls.</Typography>
            </Box>
            <Alert severity="info">Use the template columns exactly. Dates must be ISO 8601 with a timezone, such as 2026-11-12T08:00:00+05:30. The optional timeZone column accepts an IANA name such as Asia/Kolkata; blank defaults to your browser timezone.</Alert>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25}>
              <Button variant="outlined" onClick={downloadBulkTemplate} disabled={bulkRunning}>Download CSV template</Button>
              <Button component="label" variant="contained" startIcon={<UploadFileRoundedIcon />} disabled={bulkRunning || agents.isLoading || agents.isError}>
                Choose CSV file <input hidden type="file" accept=".csv,text/csv" onChange={handleBulkFile} />
              </Button>
            </Stack>
            {bulkFileError && <Alert severity="error">{bulkFileError}</Alert>}
            {bulkRows.length > 0 && <>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
                <Chip size="small" label={bulkRows.length + " rows"} />
                <Chip size="small" color="success" label={bulkRows.filter((row) => row.payload).length + " valid"} />
                {bulkRows.some((row) => row.errors.length > 0) && <Chip size="small" color="error" label={bulkRows.filter((row) => row.errors.length > 0).length + " invalid"} />}
                {completedBulkCount > 0 && <Chip size="small" color="success" label={completedBulkCount + " sessions created"} />}
                {Object.values(bulkResults).some((result) => result.error) && <Chip size="small" color="error" label={Object.values(bulkResults).filter((result) => result.error).length + " failed"} />}
              </Stack>
              {bulkRunning && <Alert severity="info">Creating sessions sequentially. Keep this page open until processing finishes.</Alert>}
              <Stack spacing={1} sx={{ maxHeight: 420, overflowY: "auto" }}>
                {bulkRows.map((row) => {
                  const result = bulkResults[row.line];
                  const label = row.payload ? row.payload.assignmentId + " · " + row.payload.employee.name + " · " + row.payload.patient.name : "Row " + row.line;
                  return <Box key={row.line} sx={{ border: "1px solid", borderColor: row.errors.length || result?.error ? "error.light" : result?.sessionId ? "success.light" : "divider", borderRadius: 2, p: 1.5 }}>
                    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1}>
                      <Typography variant="body2" fontWeight={650}>{label}</Typography>
                      <Chip size="small" color={row.errors.length || result?.error ? "error" : result?.sessionId ? "success" : "default"} label={row.errors.length ? "Invalid" : result?.sessionId ? "Created" : result?.error ? "Failed" : "Ready"} />
                    </Stack>
                    {row.errors.length > 0 && <Typography variant="caption" color="error.main" display="block" sx={{ mt: .5 }}>Row {row.line}: {row.errors.join("; ")}</Typography>}
                    {result?.sessionId && <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: .5 }}>Session {result.sessionId}</Typography>}
                    {result?.error && <Typography variant="caption" color="error.main" display="block" sx={{ mt: .5 }}>Creation failed: {result.error}</Typography>}
                  </Box>;
                })}
              </Stack>
              <Button variant="contained" onClick={() => void submitBulk()} disabled={bulkRunning || agents.isLoading || validBulkCount === 0} endIcon={bulkRunning ? <CircularProgress size={16} color="inherit" /> : undefined}>
                {bulkRunning ? "Creating sessions…" : "Create " + validBulkCount + " valid sessions"}
              </Button>
            </>}
          </Stack>
        </CardContent></Card>
      )}
    </Stack>
  );
}
