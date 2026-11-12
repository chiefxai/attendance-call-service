import { useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import LockResetRoundedIcon from "@mui/icons-material/LockResetRounded";
import { AxiosError } from "axios";
import { changePassword, type WebUser } from "../api/client";

function errorText(error: unknown) {
  return error instanceof AxiosError
    ? error.response?.data?.error || "Could not update your password. Try again."
    : error instanceof Error ? error.message : "Could not update your password.";
}

export function ChangePasswordPage({
  user,
  required,
  onChanged,
  onCancel,
  onSignOut,
}: {
  user: WebUser;
  required: boolean;
  onChanged: (user: WebUser) => void;
  onCancel?: () => void;
  onSignOut: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onChanged(result.user);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", px: 2, py: 4, bgcolor: "background.default" }}>
      <Card sx={{ width: "100%", maxWidth: 440, p: { xs: 3, sm: 4 }, borderRadius: 4 }}>
        <Stack component="form" onSubmit={submit} spacing={2.25}>
          <Box>
            <Box sx={{ width: 46, height: 46, mb: 2, borderRadius: 3, display: "grid", placeItems: "center", bgcolor: "primary.main", color: "white" }}>
              <LockResetRoundedIcon />
            </Box>
            <Typography variant="h5" fontWeight={750}>{required ? "Set a new password" : "Change password"}</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.75 }}>
              {required ? "For account security, update the temporary password before continuing." : `Update the password for ${user.displayName}.`}
            </Typography>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField fullWidth required type="password" label="Current password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          <TextField fullWidth required type="password" label="New password" autoComplete="new-password" helperText="Use at least 12 characters." inputProps={{ minLength: 12 }} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          <TextField fullWidth required type="password" label="Confirm new password" autoComplete="new-password" inputProps={{ minLength: 12 }} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          <Button fullWidth type="submit" size="large" variant="contained" disabled={busy}>
            {busy ? <CircularProgress size={22} color="inherit" /> : "Save password"}
          </Button>
          <Stack direction="row" justifyContent="space-between">
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
            <Button onClick={onSignOut} sx={{ ml: "auto" }}>Sign out</Button>
          </Stack>
        </Stack>
      </Card>
    </Box>
  );
}
