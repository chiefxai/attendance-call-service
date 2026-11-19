import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography } from "@mui/material";
import LockResetRoundedIcon from "@mui/icons-material/LockResetRounded";
import { AxiosError } from "axios";
import { fetchCareManagers, provisionCareManagerAccount, resetCareManagerPassword, setCareManagerActive, type CareManager } from "../api/client";
import { PageHeader } from "../components/OperationsUI";
import { SortByMenu } from "../components/SortByMenu";
import { formatAppDate, formatAppDateTime } from "../utils/dateTime";

type ManagerSort = "name_ascending" | "name_descending" | "created_newest" | "created_oldest";
const managerSortOptions = [
  { value: "name_ascending", label: "Name: A to Z" },
  { value: "name_descending", label: "Name: Z to A" },
  { value: "created_newest", label: "Created: newest first" },
  { value: "created_oldest", label: "Created: oldest first" },
] as const;

const errorMessage = (error: unknown) => error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";

export function CareManagersPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["care-managers"], queryFn: fetchCareManagers });
  const [passwordTarget, setPasswordTarget] = useState<CareManager | null>(null);
  const [accountTarget, setAccountTarget] = useState<CareManager | null>(null);
  const [error, setError] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [sortBy, setSortBy] = useState<ManagerSort>("name_ascending");
  const managers = query.data || [];
  const sortedManagers = [...managers].sort((a, b) => {
    if (sortBy.startsWith("name_")) {
      const comparison = (a.name || `Care Manager ${a.athulyaCareManagerId}`).localeCompare(b.name || `Care Manager ${b.athulyaCareManagerId}`, undefined, { sensitivity: "base" });
      return sortBy === "name_ascending" ? comparison : -comparison;
    }
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return sortBy === "created_newest" ? dateB - dateA : dateA - dateB;
  });
  useEffect(() => setPage(0), [managers.length, sortBy]);
  const pageManagers = sortedManagers.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
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
  const provision = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) => provisionCareManagerAccount(id, password),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["care-managers"] });
      setAccountTarget(null);
      setAccountPassword("");
      setError("");
    },
  });
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    if (passwordTarget) reset.mutate({ id: passwordTarget.id, password: newPassword }, { onError: (reason) => setError(errorMessage(reason)) });
  };
  const submitAccount = (event: FormEvent) => {
    event.preventDefault();
    if (accountTarget) provision.mutate({ id: accountTarget.id, password: accountPassword }, { onError: (reason) => setError(errorMessage(reason)) });
  };

  return <Stack spacing={{ xs: 1.5, md: 1.75 }} sx={{ height: { xs: "auto", md: "calc(100dvh - 152px)" }, minHeight: { xs: 0, md: 440 }, pb: { xs: 1, md: 0 } }}>
    <PageHeader title="Care Managers" actions={<SortByMenu value={sortBy} options={managerSortOptions} onChange={setSortBy} />} />
    {query.isError && <Alert severity="error">Could not load Care Managers: {errorMessage(query.error)}</Alert>}
    {toggle.isError && <Alert severity="error">Could not update account: {errorMessage(toggle.error)}</Alert>}
    {reset.isSuccess && <Alert severity="success">Password reset. The Care Manager must choose a new password at their next sign-in.</Alert>}
    {provision.isSuccess && <Alert severity="success">Account provided. The Care Manager can sign in with their registered phone number and must change the temporary password.</Alert>}
    {provision.isError && <Alert severity="error">Could not provide account: {errorMessage(provision.error)}</Alert>}
    <Card sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: { xs: 380, md: 0 }, overflow: "hidden" }}><CardContent sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {query.isLoading ? <Stack alignItems="center" sx={{ py: 5 }}><CircularProgress /></Stack> : <TableContainer sx={{ flex: 1, minHeight: { xs: 230, md: 0 }, maxHeight: { xs: "55dvh", md: "none" }, overflow: "auto" }}>
        <Table size="small"><TableHead><TableRow><TableCell>Name</TableCell><TableCell>Phone</TableCell><TableCell>Athulya ID</TableCell><TableCell>Status</TableCell><TableCell>Created</TableCell><TableCell>Last login</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
          <TableBody>{pageManagers.map((manager) => {
            const active = manager.active && manager.accountActive === true;
            const provisioned = Boolean(manager.userId);
            return <TableRow key={manager.id} hover>
              <TableCell><Typography fontWeight={650}>{manager.name || `Care Manager ${manager.athulyaCareManagerId}`}</Typography></TableCell>
              <TableCell>{manager.phone || "—"}</TableCell>
              <TableCell>{manager.athulyaCareManagerId}</TableCell>
              <TableCell><Chip size="small" color={active ? "success" : "default"} label={!provisioned ? "Account not provisioned" : active ? "Active" : "Inactive"} /></TableCell>
              <TableCell>{manager.createdAt ? formatAppDate(manager.createdAt) : "—"}</TableCell>
              <TableCell>{manager.lastLogin ? formatAppDateTime(manager.lastLogin) : "Never"}</TableCell>
              <TableCell align="right"><Stack direction="row" spacing={.5} justifyContent="flex-end">
                {!provisioned && <Button size="small" disabled={!manager.phone || provision.isPending} onClick={() => { setError(""); setAccountTarget(manager); }}>Provide account</Button>}
                <Tooltip title={provisioned ? "Reset password" : "Provision this login from the server first"}>
                  <span><IconButton disabled={!provisioned} onClick={() => { setError(""); setPasswordTarget(manager); }} aria-label={`Reset ${manager.name || manager.athulyaCareManagerId}'s password`}><LockResetRoundedIcon /></IconButton></span>
                </Tooltip>
                <Tooltip title={provisioned ? active ? "Deactivate account" : "Activate account" : "Provision this login from the server before activating"}>
                  <span><Button size="small" disabled={!provisioned || toggle.isPending} onClick={() => toggle.mutate({ id: manager.id, active: !active })}>{active ? "Deactivate" : "Activate"}</Button></span>
                </Tooltip>
              </Stack></TableCell>
            </TableRow>;
          })}{query.isSuccess && managers.length === 0 && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5, color: "text.secondary" }}>No Care Manager IDs have been imported yet. Sync Athulya schedules to load them.</TableCell></TableRow>}</TableBody>
        </Table>
        <TablePagination component="div" count={managers.length} page={page} onPageChange={(_, nextPage) => setPage(nextPage)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Care managers per page" />
      </TableContainer>}
    </CardContent></Card>

    <Dialog open={Boolean(accountTarget)} onClose={() => setAccountTarget(null)} fullWidth maxWidth="xs"><DialogTitle>Provide Care Manager account</DialogTitle><Stack component="form" onSubmit={submitAccount}><DialogContent><Stack spacing={2}><Typography variant="body2" color="text.secondary">Sign-in will use {accountTarget?.phone || "the registered phone number"}. The account starts inactive until you activate it. The Care Manager must change this temporary password after signing in.</Typography><TextField required type="password" label="Temporary password" helperText="At least 12 characters" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} />{error && <Alert severity="error">{error}</Alert>}</Stack></DialogContent><DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setAccountTarget(null)}>Cancel</Button><Button type="submit" variant="contained" disabled={provision.isPending}>{provision.isPending ? "Providing…" : "Provide account"}</Button></DialogActions></Stack></Dialog>
    <Dialog open={Boolean(passwordTarget)} onClose={() => setPasswordTarget(null)} fullWidth maxWidth="xs"><DialogTitle>Reset password</DialogTitle><Stack component="form" onSubmit={submitPassword}><DialogContent><Stack spacing={2}><Typography variant="body2" color="text.secondary">Set a new temporary password for {passwordTarget?.name}. They must change it after signing in. Their current sessions will be signed out.</Typography><TextField required type="password" label="Temporary password" helperText="At least 12 characters" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />{error && <Alert severity="error">{error}</Alert>}</Stack></DialogContent><DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setPasswordTarget(null)}>Cancel</Button><Button type="submit" variant="contained" disabled={reset.isPending}>{reset.isPending ? "Saving…" : "Reset password"}</Button></DialogActions></Stack></Dialog>
  </Stack>;
}
