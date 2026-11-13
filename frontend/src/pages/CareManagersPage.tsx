import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography } from "@mui/material";
import LockResetRoundedIcon from "@mui/icons-material/LockResetRounded";
import { AxiosError } from "axios";
import { fetchCareManagers, resetCareManagerPassword, setCareManagerActive, type CareManager } from "../api/client";
import { PageHeader } from "../components/OperationsUI";

const errorMessage = (error: unknown) => error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";

export function CareManagersPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["care-managers"], queryFn: fetchCareManagers });
  const [passwordTarget, setPasswordTarget] = useState<CareManager | null>(null);
  const [error, setError] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const managers = query.data || [];
  useEffect(() => setPage(0), [managers.length]);
  const pageManagers = managers.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => setCareManagerActive(id, active),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["care-managers"] }),
  });
  const reset = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) => resetCareManagerPassword(id, password),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["care-managers"] });
      setPasswordTarget(null);
      setNewPassword("");
      setError("");
    },
  });
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    if (passwordTarget) reset.mutate({ id: passwordTarget.id, password: newPassword }, { onError: (reason) => setError(errorMessage(reason)) });
  };

  return <Stack spacing={2.5}>
    <PageHeader title="Care Managers" />
    {query.isError && <Alert severity="error">Could not load Care Managers: {errorMessage(query.error)}</Alert>}
    {toggle.isError && <Alert severity="error">Could not update account: {errorMessage(toggle.error)}</Alert>}
    {reset.isSuccess && <Alert severity="success">Password reset. The Care Manager must choose a new password at their next sign-in.</Alert>}
    <Card><CardContent>
      {query.isLoading ? <Stack alignItems="center" sx={{ py: 5 }}><CircularProgress /></Stack> : <TableContainer>
        <Table size="small"><TableHead><TableRow><TableCell>Name</TableCell><TableCell>Email</TableCell><TableCell>Phone</TableCell><TableCell>Athulya ID</TableCell><TableCell>Status</TableCell><TableCell>Created</TableCell><TableCell>Last login</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
          <TableBody>{pageManagers.map((manager) => {
            const active = manager.active && manager.accountActive === true;
            const provisioned = Boolean(manager.userId);
            return <TableRow key={manager.id} hover>
              <TableCell><Typography fontWeight={650}>{manager.name || `Care Manager ${manager.athulyaCareManagerId}`}</Typography></TableCell>
              <TableCell>{manager.email || "—"}</TableCell>
              <TableCell>{manager.phone || "—"}</TableCell>
              <TableCell>{manager.athulyaCareManagerId}</TableCell>
              <TableCell><Chip size="small" color={active ? "success" : "default"} label={!provisioned ? "Account not provisioned" : active ? "Active" : "Inactive"} /></TableCell>
              <TableCell>{manager.createdAt ? new Date(manager.createdAt).toLocaleDateString() : "—"}</TableCell>
              <TableCell>{manager.lastLogin ? new Date(manager.lastLogin).toLocaleString() : "Never"}</TableCell>
              <TableCell align="right"><Stack direction="row" spacing={.5} justifyContent="flex-end">
                <Tooltip title={provisioned ? "Reset password" : "Provision this login from the server first"}>
                  <span><IconButton disabled={!provisioned} onClick={() => { setError(""); setPasswordTarget(manager); }} aria-label={`Reset ${manager.name || manager.athulyaCareManagerId}'s password`}><LockResetRoundedIcon /></IconButton></span>
                </Tooltip>
                <Tooltip title={provisioned ? active ? "Deactivate account" : "Activate account" : "Provision this login from the server before activating"}>
                  <span><Button size="small" disabled={!provisioned || toggle.isPending} onClick={() => toggle.mutate({ id: manager.id, active: !active })}>{active ? "Deactivate" : "Activate"}</Button></span>
                </Tooltip>
              </Stack></TableCell>
            </TableRow>;
          })}{query.isSuccess && managers.length === 0 && <TableRow><TableCell colSpan={8} align="center" sx={{ py: 5, color: "text.secondary" }}>No Care Manager IDs have been imported yet. Sync Athulya schedules to load them.</TableCell></TableRow>}</TableBody>
        </Table>
        <TablePagination component="div" count={managers.length} page={page} onPageChange={(_, nextPage) => setPage(nextPage)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Care managers per page" />
      </TableContainer>}
    </CardContent></Card>

    <Dialog open={Boolean(passwordTarget)} onClose={() => setPasswordTarget(null)} fullWidth maxWidth="xs"><DialogTitle>Reset password</DialogTitle><Stack component="form" onSubmit={submitPassword}><DialogContent><Stack spacing={2}><Typography variant="body2" color="text.secondary">Set a new temporary password for {passwordTarget?.name}. They must change it after signing in. Their current sessions will be signed out.</Typography><TextField required type="password" label="Temporary password" helperText="At least 12 characters" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />{error && <Alert severity="error">{error}</Alert>}</Stack></DialogContent><DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setPasswordTarget(null)}>Cancel</Button><Button type="submit" variant="contained" disabled={reset.isPending}>{reset.isPending ? "Saving…" : "Reset password"}</Button></DialogActions></Stack></Dialog>
  </Stack>;
}
