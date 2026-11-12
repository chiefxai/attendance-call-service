import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography } from "@mui/material";
import PersonAddAltRoundedIcon from "@mui/icons-material/PersonAddAltRounded";
import LockResetRoundedIcon from "@mui/icons-material/LockResetRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import { AxiosError } from "axios";
import { createCareManager, fetchCareManagers, resetCareManagerPassword, setCareManagerActive, updateCareManager, type CareManager } from "../api/client";
import { PageHeader } from "../components/OperationsUI";

const errorMessage = (error: unknown) => error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";

export function CareManagersPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["care-managers"], queryFn: fetchCareManagers });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CareManager | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<CareManager | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", athulyaCareManagerId: "", password: "" });
  const [newPassword, setNewPassword] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const managers = query.data || [];
  useEffect(() => setPage(0), [managers.length]);
  const pageManagers = managers.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const create = useMutation({ mutationFn: createCareManager, onSuccess: () => { void client.invalidateQueries({ queryKey: ["care-managers"] }); setCreateOpen(false); setForm({ name: "", email: "", phone: "", athulyaCareManagerId: "", password: "" }); setError(""); } });
  const update = useMutation({ mutationFn: ({ id, payload }: { id: string; payload: Omit<typeof form, "password"> }) => updateCareManager(id, payload), onSuccess: () => { void client.invalidateQueries({ queryKey: ["care-managers"] }); setCreateOpen(false); setEditing(null); setForm({ name: "", email: "", phone: "", athulyaCareManagerId: "", password: "" }); setError(""); } });
  const toggle = useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => setCareManagerActive(id, active), onSuccess: () => void client.invalidateQueries({ queryKey: ["care-managers"] }) });
  const reset = useMutation({ mutationFn: ({ id, password }: { id: string; password: string }) => resetCareManagerPassword(id, password), onSuccess: () => { setPasswordTarget(null); setNewPassword(""); setError(""); } });
  const submit = (event: FormEvent) => { event.preventDefault(); setError(""); if (editing) update.mutate({ id: editing.id, payload: { name: form.name, email: form.email, phone: form.phone, athulyaCareManagerId: form.athulyaCareManagerId } }, { onError: (reason) => setError(errorMessage(reason)) }); else create.mutate(form, { onError: (reason) => setError(errorMessage(reason)) }); };
  const submitPassword = (event: FormEvent) => { event.preventDefault(); if (passwordTarget) reset.mutate({ id: passwordTarget.id, password: newPassword }, { onError: (reason) => setError(errorMessage(reason)) }); };

  return <Stack spacing={2.5}>
    <PageHeader title="Care Managers" actions={<Button variant="contained" startIcon={<PersonAddAltRoundedIcon />} onClick={() => setCreateOpen(true)}>Add Care Manager</Button>} />
    {query.isError && <Alert severity="error">Could not load Care Managers: {errorMessage(query.error)}</Alert>}
    {toggle.isError && <Alert severity="error">Could not update account: {errorMessage(toggle.error)}</Alert>}
    {reset.isSuccess && <Alert severity="success">Password reset. Existing sessions were signed out.</Alert>}
    <Card><CardContent>
      {query.isLoading ? <Stack alignItems="center" sx={{ py: 5 }}><CircularProgress /></Stack> : <TableContainer>
        <Table size="small"><TableHead><TableRow><TableCell>Name</TableCell><TableCell>Email</TableCell><TableCell>Phone</TableCell><TableCell>Athulya ID</TableCell><TableCell>Status</TableCell><TableCell>Created</TableCell><TableCell>Last login</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
          <TableBody>{pageManagers.map((manager) => <TableRow key={manager.id} hover>
            <TableCell><Typography fontWeight={650}>{manager.name}</Typography></TableCell><TableCell>{manager.email || "—"}</TableCell><TableCell>{manager.phone || "—"}</TableCell><TableCell>{manager.athulyaCareManagerId}</TableCell>
            <TableCell><Chip size="small" color={manager.active && manager.accountActive ? "success" : "default"} label={manager.active && manager.accountActive ? "Active" : "Inactive"} /></TableCell>
            <TableCell>{manager.createdAt ? new Date(manager.createdAt).toLocaleDateString() : "—"}</TableCell>
            <TableCell>{manager.lastLogin ? new Date(manager.lastLogin).toLocaleString() : "Never"}</TableCell>
            <TableCell align="right"><Stack direction="row" spacing={.5} justifyContent="flex-end"><Tooltip title="Edit details"><IconButton aria-label={`Edit ${manager.name}`} onClick={() => { setEditing(manager); setForm({ name: manager.name, email: manager.email || "", phone: manager.phone || "", athulyaCareManagerId: manager.athulyaCareManagerId, password: "" }); setError(""); setCreateOpen(true); }}><EditRoundedIcon /></IconButton></Tooltip><Tooltip title="Reset password"><IconButton onClick={() => { setError(""); setPasswordTarget(manager); }} aria-label={`Reset ${manager.name}'s password`}><LockResetRoundedIcon /></IconButton></Tooltip><Button size="small" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: manager.id, active: !(manager.active && manager.accountActive) })}>{manager.active && manager.accountActive ? "Deactivate" : "Activate"}</Button></Stack></TableCell>
          </TableRow>)}{query.data?.length === 0 && <TableRow><TableCell colSpan={8} align="center" sx={{ py: 5, color: "text.secondary" }}>No Care Manager accounts yet.</TableCell></TableRow>}</TableBody>
        </Table>
        <TablePagination component="div" count={managers.length} page={page} onPageChange={(_, nextPage) => setPage(nextPage)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Care managers per page" />
      </TableContainer>}
    </CardContent></Card>

    <Dialog open={createOpen} onClose={() => { setCreateOpen(false); setEditing(null); }} fullWidth maxWidth="sm"><DialogTitle>{editing ? "Edit Care Manager" : "Create Care Manager account"}</DialogTitle><Stack component="form" onSubmit={submit}><DialogContent><Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">Care Managers can view all caregivers and patients and manage assignments. They cannot change system or integration settings.</Typography>
      <TextField required label="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <TextField required type="email" label="Login email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <TextField label="Phone number" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <TextField required label="Athulya Care Manager ID" value={form.athulyaCareManagerId} onChange={(e) => setForm({ ...form, athulyaCareManagerId: e.target.value })} />
      {!editing && <TextField required type="password" label="Initial password" helperText="At least 12 characters" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack></DialogContent><DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => { setCreateOpen(false); setEditing(null); }}>Cancel</Button><Button type="submit" variant="contained" disabled={create.isPending || update.isPending}>{create.isPending || update.isPending ? "Saving…" : editing ? "Save changes" : "Create account"}</Button></DialogActions></Stack></Dialog>

    <Dialog open={Boolean(passwordTarget)} onClose={() => setPasswordTarget(null)} fullWidth maxWidth="xs"><DialogTitle>Reset password</DialogTitle><Stack component="form" onSubmit={submitPassword}><DialogContent><Stack spacing={2}><Typography variant="body2" color="text.secondary">Set a new password for {passwordTarget?.name}. Their current sessions will be signed out.</Typography><TextField required type="password" label="New password" helperText="At least 12 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />{error && <Alert severity="error">{error}</Alert>}</Stack></DialogContent><DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setPasswordTarget(null)}>Cancel</Button><Button type="submit" variant="contained" disabled={reset.isPending}>{reset.isPending ? "Saving…" : "Reset password"}</Button></DialogActions></Stack></Dialog>
  </Stack>;
}
