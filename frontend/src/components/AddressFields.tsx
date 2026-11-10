import { Grid, TextField } from "@mui/material";

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
  const change = (key: keyof AddressParts) => (event: React.ChangeEvent<HTMLInputElement>) => {
    onChange(formatAddress({ ...parts, [key]: event.target.value }));
  };
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 4 }}><TextField fullWidth required={required} label="State" value={parts.state} onChange={change("state")} /></Grid>
      <Grid size={{ xs: 12, sm: 4 }}><TextField fullWidth required={required} label="District" value={parts.district} onChange={change("district")} /></Grid>
      <Grid size={{ xs: 12, sm: 4 }}><TextField fullWidth required={required} label="PIN code" value={parts.pincode} onChange={change("pincode")} inputProps={{ inputMode: "numeric", maxLength: 6 }} /></Grid>
      <Grid size={12}><TextField fullWidth required={required} label="House / Street & Town" value={parts.locality} onChange={change("locality")} /></Grid>
    </Grid>
  );
}
