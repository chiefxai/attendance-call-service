import { useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import { AxiosError } from "axios";
import { signIn, type WebUser } from "../api/client";

function errorText(error: unknown) {
  return error instanceof AxiosError
    ? error.response?.data?.error || "Could not sign in. Check your connection and try again."
    : error instanceof Error ? error.message : "Could not sign in.";
}

export function LoginPage({ onSignedIn }: { onSignedIn: (user: WebUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await signIn(email.trim(), password);
      setPassword("");
      onSignedIn(result.user);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", px: 2, py: 4, bgcolor: "background.default" }}>
      <Card sx={{ width: "100%", maxWidth: 420, p: { xs: 3, sm: 4 }, borderRadius: 4 }}>
        <Stack component="form" onSubmit={submit} spacing={2.5}>
          <Box>
            <Box sx={{ width: 46, height: 46, mb: 2, borderRadius: 3, display: "grid", placeItems: "center", bgcolor: "primary.main", color: "white" }}>
              <LockRoundedIcon />
            </Box>
            <Typography variant="h5" fontWeight={750}>Sign in</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.75 }}>Use the account provided by your system administrator.</Typography>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField autoFocus fullWidth required type="email" label="Email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
          <TextField fullWidth required type="password" label="Password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <Button fullWidth type="submit" size="large" variant="contained" disabled={busy}>
            {busy ? <CircularProgress size={22} color="inherit" /> : "Sign in"}
          </Button>
          <Typography variant="caption" color="text.secondary" textAlign="center">Accounts are created by an administrator on the service.</Typography>
        </Stack>
      </Card>
    </Box>
  );
}
