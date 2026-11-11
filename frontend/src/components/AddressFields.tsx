import { Autocomplete, Grid, TextField } from "@mui/material";
import type { ChangeEvent } from "react";
import { SERVICE_DISTRICTS, SERVICE_STATES } from "../utils/india-locations";

export interface AddressParts {
  state: string;
  district: string;
  pincode: string;
  locality: string;
}

const emptyAddress: AddressParts = { state: "", district: "", pincode: "", locality: "" };
const separator = " | ";

export function parseAddress(value: string): AddressParts {
  if (!value) return { ...emptyAddress };
  const parts = value.split(separator);
  // Preserve pre-existing free-form addresses as the street/town value.
  if (parts.length !== 4) return { ...emptyAddress, locality: value };
  return { state: parts[0], district: parts[1], pincode: parts[2], locality: parts[3] };
}

export function formatAddress(parts: AddressParts): string {
  return [parts.state, parts.district, parts.pincode, parts.locality].join(separator);
}

export function AddressFields({ value, onChange, required = false }: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const parts = parseAddress(value);
  const change = (key: keyof AddressParts) => (event: ChangeEvent<HTMLInputElement>) => {
    onChange(formatAddress({ ...parts, [key]: event.target.value }));
  };
  const stateOptions = parts.state && !SERVICE_STATES.includes(parts.state) ? [...SERVICE_STATES, parts.state] : SERVICE_STATES;
  const knownDistricts = SERVICE_DISTRICTS[parts.state] || [];
  const districtOptions = parts.district && !knownDistricts.includes(parts.district) ? [...knownDistricts, parts.district] : knownDistricts;
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 4 }}><Autocomplete
        options={stateOptions}
        value={parts.state || null}
        onChange={(_, state) => onChange(formatAddress({ ...parts, state: state || "", district: "" }))}
        renderInput={(params) => <TextField {...params} fullWidth required={required} label="State" placeholder="Search states" />}
      /></Grid>
      <Grid size={{ xs: 12, sm: 4 }}><Autocomplete
        options={districtOptions}
        value={parts.district || null}
        disabled={!parts.state || knownDistricts.length === 0}
        onChange={(_, district) => onChange(formatAddress({ ...parts, district: district || "" }))}
        renderInput={(params) => <TextField {...params} fullWidth required={required} label="District" placeholder={parts.state ? "Search districts" : "Select a state first"} />}
      /></Grid>
      <Grid size={{ xs: 12, sm: 4 }}><TextField fullWidth required={required} label="PIN code" value={parts.pincode} onChange={change("pincode")} inputProps={{ inputMode: "numeric", maxLength: 6 }} /></Grid>
      <Grid size={12}><TextField fullWidth required={required} label="House / Street & Town" value={parts.locality} onChange={change("locality")} /></Grid>
    </Grid>
  );
}
