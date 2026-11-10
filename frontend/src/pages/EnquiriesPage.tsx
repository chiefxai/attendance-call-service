import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, FormControl, Grid, InputLabel, MenuItem, Select,
  Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ContactSupportRoundedIcon from "@mui/icons-material/ContactSupportRounded";
import { AxiosError } from "axios";
import { createPatient, fetchIncomingCalls, fetchPatients, fetchStaff, incomingCallRecordingUrl, resolveIncomingEnquiry, type CreatePatientPayload, type IncomingCall, type PatientRecord } from "../api/client";
import { PageHeader } from "../components/OperationsUI";
import { INDIAN_MOBILE_ERROR, normalizeIndianMobile } from "../utils/phone";

type IntakeMode = "existing" | "new";
type PatientForm = CreatePatientPayload;

const emptyPatient = (): PatientForm => ({
  id: `PAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  name: "",
  phoneNumber: "",
  address: "",
  language: "en",
  careCategory: "",
  hub: "",
});

function errorMessage(error: unknown) {
  return error instanceof AxiosError
    ? error.response?.data?.error || error.message
    : error instanceof Error ? error.message : "Request failed";
}

export function EnquiriesPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<IntakeMode>("existing");
  const [existingPatientId, setExistingPatientId] = useState("");
  const [patientForm, setPatientForm] = useState<PatientForm>(emptyPatient);
  const [phoneError, setPhoneError] = useState("");
  const [formError, setFormError] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<PatientRecord | null>(null);
  const [enquiryMessage, setEnquiryMessage] = useState("");
  const [selectedMessage, setSelectedMessage] = useState("");
  const [resolveCall, setResolveCall] = useState<IncomingCall | null>(null);
  const [resolveStaffId, setResolveStaffId] = useState("");
  const [resolveError, setResolveError] = useState("");
  const queryClient = useQueryClient();
  const patients = useQuery({
    queryKey: ["patients"],
    queryFn: () => fetchPatients({ limit: 500 }),
  });
  const incomingCalls = useQuery({
    queryKey: ["incoming-calls"],
    queryFn: () => fetchIncomingCalls(),
    refetchInterval: (query) => query.state.data?.some((call) => call.enquiryStatus === "processing") ? 4000 : 15000,
  });
  const staffDirectory = useQuery({ queryKey: ["staff", "enquiry-resolution"], queryFn: () => fetchStaff({ limit: 500 }) });
  const resolveMutation = useMutation({
    mutationFn: ({ callId, staffId }: { callId: string; staffId: string }) => resolveIncomingEnquiry(callId, staffId),
    onSuccess: async () => {
      setResolveCall(null);
      setResolveStaffId("");
      setResolveError("");
      await queryClient.invalidateQueries({ queryKey: ["incoming-calls"] });
    },
    onError: (error) => setResolveError(errorMessage(error)),
  });
  const createMutation = useMutation({
    mutationFn: createPatient,
    onSuccess: async (patient) => {
      setSelectedPatient(patient);
      setSelectedMessage(enquiryMessage.trim());
      setDialogOpen(false);
      setFormError("");
      await queryClient.invalidateQueries({ queryKey: ["patients"] });
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const openDialog = () => {
    setMode("existing");
    setExistingPatientId("");
    setPatientForm(emptyPatient());
    setPhoneError("");
    setFormError("");
    setEnquiryMessage("");
    setDialogOpen(true);
  };

  const useExistingPatient = () => {
    const patient = patients.data?.find((record) => record.id === existingPatientId);
    if (!patient) {
      setFormError("Choose a patient to continue.");
      return;
    }
    setSelectedPatient(patient);
    setSelectedMessage(enquiryMessage.trim());
    setDialogOpen(false);
    setFormError("");
  };

  const createNewPatient = () => {
    const phoneInput = patientForm.phoneNumber?.trim() || "";
    const phoneNumber = phoneInput ? normalizeIndianMobile(phoneInput) : null;
    if (phoneInput && !phoneNumber) {
      setPhoneError(INDIAN_MOBILE_ERROR);
      return;
    }
    setPhoneError("");
    setFormError("");
    createMutation.mutate({
      ...patientForm,
      id: patientForm.id.trim(),
      name: patientForm.name.trim(),
      phoneNumber: phoneNumber || undefined,
      address: patientForm.address.trim(),
      careCategory: patientForm.careCategory?.trim(),
      hub: patientForm.hub?.trim(),
    });
  };

  const updatePatient = (key: keyof PatientForm, value: string) => {
    setPatientForm((current) => ({ ...current, [key]: value }));
  };

  return <Stack spacing={2.5}>
    <PageHeader
      title="Enquiries"
      actions={<Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openDialog}>Add enquiry</Button>}
    />

    <IncomingPatientEnquiries
      calls={incomingCalls.data || []}
      loading={incomingCalls.isLoading}
      error={incomingCalls.isError}
      onResolve={(call) => { setResolveCall(call); setResolveStaffId(""); setResolveError(""); }}
    />

    {selectedPatient ? (
      <Card>
        <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ xs: "stretch", sm: "center" }}>
            <Box sx={{ width: 48, height: 48, borderRadius: 2.5, display: "grid", placeItems: "center", bgcolor: "#edf4f1", color: "primary.main", flexShrink: 0 }}>
              <ContactSupportRoundedIcon />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="overline" color="primary.main" fontWeight={700}>PATIENT SELECTED</Typography>
              <Typography variant="h6" fontWeight={700}>{selectedPatient.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {selectedPatient.id} · {selectedPatient.address || "Address not available"}
              </Typography>
              {selectedPatient.careCategory && <Typography variant="body2" color="text.secondary">Care need: {selectedPatient.careCategory}</Typography>}
            </Box>
            <Button variant="outlined" onClick={openDialog}>Choose another patient</Button>
          </Stack>
          {selectedMessage && <Box sx={{ mt: 2, p: 2, border: "1px solid #e4ebe7", borderRadius: 2, bgcolor: "#fafcfb" }}>
            <Typography variant="subtitle2" fontWeight={700}>How can we help?</Typography>
            <Typography variant="body2" sx={{ mt: .5, whiteSpace: "pre-wrap" }}>{selectedMessage}</Typography>
          </Box>}
          <Alert severity="info" sx={{ mt: 2 }}>
            Patient and needs are held as an intake draft for now. Enquiry-specific fields and follow-up actions can be added once that workflow is defined.
          </Alert>
        </CardContent>
      </Card>
    ) : (
      <Card>
        <CardContent sx={{ minHeight: 300, display: "grid", placeItems: "center", textAlign: "center", p: 4 }}>
          <Stack spacing={1.25} alignItems="center" maxWidth={440}>
            <Box sx={{ width: 56, height: 56, borderRadius: 3, display: "grid", placeItems: "center", bgcolor: "#edf4f1", color: "primary.main" }}>
              <ContactSupportRoundedIcon fontSize="large" />
            </Box>
            <Typography variant="h6" fontWeight={700}>Start a patient enquiry</Typography>
            <Typography variant="body2" color="text.secondary">Choose an existing patient or add a new patient profile to begin.</Typography>
            <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openDialog}>Add enquiry</Button>
          </Stack>
        </CardContent>
      </Card>
    )}

    <Dialog open={dialogOpen} onClose={() => { if (!createMutation.isPending) setDialogOpen(false); }} fullWidth maxWidth="sm">
      <DialogTitle>Add patient enquiry</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">Link an existing patient or create a patient profile as part of intake.</Typography>
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            value={mode}
            onChange={(_, value: IntakeMode | null) => {
              if (!value) return;
              setMode(value);
              setFormError("");
              setPhoneError("");
            }}
            aria-label="Patient selection mode"
          >
            <ToggleButton value="existing">Existing patient</ToggleButton>
            <ToggleButton value="new">New patient</ToggleButton>
          </ToggleButtonGroup>

          {mode === "existing" ? (
            <>
              {patients.isError && <Alert severity="error">Could not load saved patients. Try again before selecting one.</Alert>}
              <FormControl fullWidth size="small" error={Boolean(formError)}>
                <InputLabel id="enquiry-patient-label">Patient</InputLabel>
                <Select
                  labelId="enquiry-patient-label"
                  label="Patient"
                  value={existingPatientId}
                  onChange={(event) => { setExistingPatientId(event.target.value); setFormError(""); }}
                  disabled={patients.isLoading || patients.isError}
                >
                  {patients.data?.map((patient) => (
                    <MenuItem key={patient.id} value={patient.id}>
                      {patient.name} · {patient.id}{patient.address ? ` · ${patient.address}` : ""}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {patients.isSuccess && patients.data.length === 0 && <Alert severity="info">No saved patients yet. Switch to New patient to create the first profile.</Alert>}
            </>
          ) : (
            <Grid container spacing={1.5}>
              <Grid size={12}><TextField fullWidth label="Patient ID" value={patientForm.id} InputProps={{ readOnly: true }} helperText="Generated automatically" /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth required label="Patient name" value={patientForm.name} onChange={(event) => updatePatient("name", event.target.value)} /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  type="tel"
                  label="Indian mobile number (optional)"
                  placeholder="9876543210 or +919876543210"
                  value={patientForm.phoneNumber || ""}
                  error={Boolean(phoneError)}
                  helperText={phoneError || "Enter 10 digits; 91 or +91 is optional."}
                  onChange={(event) => { setPhoneError(""); updatePatient("phoneNumber", event.target.value); }}
                  onBlur={() => {
                    const input = patientForm.phoneNumber?.trim() || "";
                    if (!input) return;
                    const normalized = normalizeIndianMobile(input);
                    if (!normalized) setPhoneError(INDIAN_MOBILE_ERROR);
                    else { setPhoneError(""); updatePatient("phoneNumber", normalized); }
                  }}
                />
              </Grid>
              <Grid size={12}><TextField fullWidth required multiline minRows={2} label="Patient address" value={patientForm.address} onChange={(event) => updatePatient("address", event.target.value)} /></Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <FormControl fullWidth size="small">
                  <InputLabel id="enquiry-language-label">Preferred language</InputLabel>
                  <Select labelId="enquiry-language-label" label="Preferred language" value={patientForm.language} onChange={(event) => updatePatient("language", event.target.value)}>
                    <MenuItem value="en">English</MenuItem><MenuItem value="ta">Tamil</MenuItem><MenuItem value="ml">Malayalam</MenuItem><MenuItem value="te">Telugu</MenuItem>
                  </Select>
                </FormControl>
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Care need / category" value={patientForm.careCategory || ""} onChange={(event) => updatePatient("careCategory", event.target.value)} /></Grid>
              <Grid size={12}><TextField fullWidth label="Hub (optional)" value={patientForm.hub || ""} onChange={(event) => updatePatient("hub", event.target.value)} /></Grid>
            </Grid>
          )}
          <TextField
            fullWidth
            required
            multiline
            minRows={3}
            label="How can we help?"
            placeholder="Describe the patient’s needs or the help they are looking for."
            value={enquiryMessage}
            onChange={(event) => setEnquiryMessage(event.target.value)}
            helperText="Add a short note about the patient’s needs or requested care."
          />
          {formError && <Alert severity="error">{formError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={() => setDialogOpen(false)} disabled={createMutation.isPending}>Cancel</Button>
        {mode === "existing" ? (
          <Button variant="contained" onClick={useExistingPatient} disabled={!existingPatientId || !enquiryMessage.trim() || patients.isLoading}>Use patient</Button>
        ) : (
          <Button
            variant="contained"
            startIcon={createMutation.isPending ? <CircularProgress size={16} color="inherit" /> : <AddRoundedIcon />}
            onClick={createNewPatient}
            disabled={createMutation.isPending || !patientForm.name.trim() || !patientForm.address.trim() || !enquiryMessage.trim() || Boolean(phoneError)}
          >
            {createMutation.isPending ? "Saving patient…" : "Create patient"}
          </Button>
        )}
      </DialogActions>
    </Dialog>

    <Dialog open={Boolean(resolveCall)} onClose={() => { if (!resolveMutation.isPending) setResolveCall(null); }} fullWidth maxWidth="sm">
      <DialogTitle>Resolve patient enquiry</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">Choose a staff member to assign for follow-up. Suggestions are listed first; you can choose any active staff member.</Typography>
          {resolveCall?.staffSuggestions.length ? <Alert severity="info">Suggested staff are ordered by district and regional match. Confirm availability with the staff member before assigning.</Alert> : <Alert severity="warning">No staff matched the requested time and location. Select a staff member after your manual review.</Alert>}
          {staffDirectory.isLoading ? <CircularProgress size={24} /> : <FormControl fullWidth>
            <InputLabel id="resolve-staff-label">Staff member</InputLabel>
            <Select labelId="resolve-staff-label" label="Staff member" value={resolveStaffId} onChange={(event) => setResolveStaffId(event.target.value)}>
              {(() => {
                const all = staffDirectory.data || [];
                const suggestedIds = new Set(resolveCall?.staffSuggestions.map((staff) => staff.id) || []);
                const suggested = resolveCall?.staffSuggestions || [];
                const remaining = all.filter((staff) => !suggestedIds.has(staff.id));
                return <>
                  {suggested.length > 0 && <MenuItem disabled value=""><em>Suggested staff</em></MenuItem>}
                  {suggested.map((staff) => <MenuItem key={staff.id} value={staff.id}>{staff.name} · {({ same_district: "Same district", same_region: "Same state", other_region: "Other area" }[staff.locationMatch])}{staff.phoneNumber ? ` · ${staff.phoneNumber}` : ""}</MenuItem>)}
                  {remaining.length > 0 && <MenuItem disabled value=""><em>All active staff</em></MenuItem>}
                  {remaining.map((staff) => <MenuItem key={staff.id} value={staff.id}>{staff.name}{staff.phoneNumber ? ` · ${staff.phoneNumber}` : ""}</MenuItem>)}
                </>;
              })()}
            </Select>
          </FormControl>}
          {staffDirectory.isError && <Alert severity="error">Could not load the staff directory.</Alert>}
          {resolveError && <Alert severity="error">{resolveError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={() => setResolveCall(null)} disabled={resolveMutation.isPending}>Cancel</Button>
        <Button variant="contained" disabled={!resolveCall || !resolveStaffId || resolveMutation.isPending} onClick={() => resolveCall && resolveMutation.mutate({ callId: resolveCall.id, staffId: resolveStaffId })}>{resolveMutation.isPending ? "Resolving…" : "Resolve enquiry"}</Button>
      </DialogActions>
    </Dialog>
  </Stack>;
}

function IncomingPatientEnquiries({ calls, loading, error, onResolve }: { calls: IncomingCall[]; loading: boolean; error: boolean; onResolve: (call: IncomingCall) => void }) {
  const formatTime = (value?: string | null) => value ? new Date(value).toLocaleString() : "Not captured";
  const locationLabel = (match: IncomingCall["staffSuggestions"][number]["locationMatch"]) => ({
    same_district: "Same district", same_region: "Same state", other_region: "Other area",
  }[match] || "Location not matched");
  const statusLabel = (status: IncomingCall["enquiryStatus"]) => ({
    processing: "Processing", need_review: "Need review", suggestion: "Suggestion", shortage: "Shortage", resolved: "Resolved",
  }[status] || "Need review");
  const statusColor = (status: IncomingCall["enquiryStatus"]) => ({
    processing: "info", need_review: "warning", suggestion: "success", shortage: "warning", resolved: "default",
  }[status] || "warning") as "info" | "warning" | "success" | "default";
  return <Stack spacing={1.5}>
    <Stack direction="row" spacing={1} alignItems="center"><Typography variant="h6" fontWeight={700}>Incoming patient calls</Typography><Chip size="small" label={calls.length} /></Stack>
    {error && <Alert severity="error">Could not load incoming patient enquiries.</Alert>}
    {loading && <Box sx={{ display: "grid", placeItems: "center", py: 3 }}><CircularProgress size={24} /></Box>}
    {calls.map((call) => <Card key={call.id}>
      <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ xs: "stretch", sm: "center" }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography fontWeight={700}>{call.patient?.name || "Incoming caller"}</Typography>
              <Typography variant="body2" color="text.secondary">{call.fromNumber} · {formatTime(call.startedAt)}</Typography>
            </Box>
            <Chip size="small" color={statusColor(call.enquiryStatus)} label={statusLabel(call.enquiryStatus)} />
          </Stack>
          {(call.enquiryAnalysis?.activityName || call.enquiryAnalysis?.needsSummary) && <Box>
            {call.enquiryAnalysis.activityName && <Typography variant="body2"><strong>Activity:</strong> {call.enquiryAnalysis.activityName}{call.enquiryAnalysis.durationMinutes ? ` · ${call.enquiryAnalysis.durationMinutes} min` : ""}</Typography>}
            {call.enquiryAnalysis?.requestedStartAt && <Typography variant="body2"><strong>Requested start:</strong> {formatTime(call.enquiryAnalysis.requestedStartAt)}</Typography>}
            {call.enquiryAnalysis?.needsSummary && <Typography variant="body2" sx={{ mt: .5, whiteSpace: "pre-wrap" }}><strong>Need:</strong> {call.enquiryAnalysis.needsSummary}</Typography>}
          </Box>}
          {call.enquiryStatus === "need_review" && <Alert severity="info">{call.enquiryAnalysis?.missingDetails?.includes("patient_district")
            ? "The patient's district is missing from the saved address, so staff location cannot be matched yet."
            : call.enquiryAnalysis?.missingDetails?.includes("activity")
              ? "The caller's need did not match an active care activity. Add or update the activity catalog, then follow up with the caller."
              : "The agent could not confidently extract the request. Review the transcript and contact the caller if needed."} Review this enquiry before assigning staff.</Alert>}
          {call.enquiryStatus === "shortage" && <Alert severity="warning">No staff without an overlapping duty were found for this time window. A human can review and choose any active staff member.</Alert>}
          {call.staffSuggestions.length > 0 && call.enquiryStatus !== "resolved" && <>
            <Alert severity="info">Up to 10 staff without an overlapping duty are shown by location match. Contact the suggested staff and confirm availability before making an assignment.</Alert>
            <TableContainer sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1.5 }}>
            <Table size="small" aria-label="Suggested staff for patient enquiry">
              <TableHead><TableRow><TableCell>#</TableCell><TableCell>Available staff</TableCell><TableCell>Phone</TableCell><TableCell>Location match</TableCell><TableCell>Address</TableCell></TableRow></TableHead>
              <TableBody>{call.staffSuggestions.slice(0, 10).map((staff, index) => <TableRow key={staff.id}>
                <TableCell>{index + 1}</TableCell><TableCell><Typography fontWeight={650}>{staff.name}</Typography><Typography variant="caption" color="text.secondary">{staff.id}</Typography></TableCell>
                <TableCell>{staff.phoneNumber || "Not provided"}</TableCell><TableCell><Chip size="small" variant="outlined" label={locationLabel(staff.locationMatch)} /></TableCell><TableCell>{staff.address || "Not provided"}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
            </TableContainer>
          </>}
          {call.enquiryStatus === "resolved" && call.resolvedStaff && <Alert severity="success">Resolved with {call.resolvedStaff.name}{call.resolvedStaff.phoneNumber ? ` · ${call.resolvedStaff.phoneNumber}` : ""}.</Alert>}
          {(call.enquiryStatus === "suggestion" || call.enquiryStatus === "shortage") && <Box><Button variant="contained" size="small" onClick={() => onResolve(call)}>Resolve</Button></Box>}
          {call.transcript && <Box sx={{ p: 1.5, bgcolor: "action.hover", borderRadius: 1.5 }}><Typography variant="subtitle2">Transcript</Typography><Typography variant="body2" sx={{ mt: .5, whiteSpace: "pre-wrap" }}>{call.transcript}</Typography></Box>}
          {call.hasRecording && <audio controls preload="none" src={incomingCallRecordingUrl(call.id)} style={{ width: "100%" }} />}
        </Stack>
      </CardContent>
    </Card>)}
    {!loading && !error && calls.length === 0 && <Card><CardContent><Typography variant="body2" color="text.secondary">No incoming patient calls yet.</Typography></CardContent></Card>}
  </Stack>;
}
