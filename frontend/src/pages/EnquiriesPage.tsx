import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, FormControl, Grid, InputLabel, MenuItem, Select,
  Stack, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ContactSupportRoundedIcon from "@mui/icons-material/ContactSupportRounded";
import { AxiosError } from "axios";
import { createPatient, fetchPatients, type CreatePatientPayload, type PatientRecord } from "../api/client";
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
  const queryClient = useQueryClient();
  const patients = useQuery({
    queryKey: ["patients"],
    queryFn: () => fetchPatients({ limit: 500 }),
  });
  const createMutation = useMutation({
    mutationFn: createPatient,
    onSuccess: async (patient) => {
      setSelectedPatient(patient);
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
    setDialogOpen(true);
  };

  const useExistingPatient = () => {
    const patient = patients.data?.find((record) => record.id === existingPatientId);
    if (!patient) {
      setFormError("Choose a patient to continue.");
      return;
    }
    setSelectedPatient(patient);
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
          <Alert severity="info" sx={{ mt: 2 }}>
            Patient details are ready. Enquiry-specific fields and follow-up actions can be added once that workflow is defined.
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
          {formError && mode === "new" && <Alert severity="error">{formError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={() => setDialogOpen(false)} disabled={createMutation.isPending}>Cancel</Button>
        {mode === "existing" ? (
          <Button variant="contained" onClick={useExistingPatient} disabled={!existingPatientId || patients.isLoading}>Use patient</Button>
        ) : (
          <Button
            variant="contained"
            startIcon={createMutation.isPending ? <CircularProgress size={16} color="inherit" /> : <AddRoundedIcon />}
            onClick={createNewPatient}
            disabled={createMutation.isPending || !patientForm.name.trim() || !patientForm.address.trim() || Boolean(phoneError)}
          >
            {createMutation.isPending ? "Saving patient…" : "Create patient"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  </Stack>;
}
