import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, FormControlLabel, Grid, Stack, Switch, TextField, Typography } from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import { AxiosError } from "axios";
import { createCareActivity, fetchCareActivities, updateCareActivity, type CareActivity } from "../api/client";
import { PageHeader } from "../components/OperationsUI";

type ActivityForm = { name: string; aliasesText: string; description: string; durationMinutes: number };
const emptyForm = (): ActivityForm => ({ name: "", aliasesText: "", description: "", durationMinutes: 60 });
const errorText = (error: unknown) => error instanceof AxiosError ? error.response?.data?.error || error.message : error instanceof Error ? error.message : "Request failed";
const examples = [
  { name: "Personal care assistance", aliases: ["bathing", "showering", "grooming", "dressing", "toileting"], description: "Non-clinical help with daily hygiene, grooming, dressing, and toileting as requested.", durationMinutes: 45 },
  { name: "Mobility and transfer support", aliases: ["walking assistance", "mobility help", "bed-to-chair transfer", "wheelchair assistance"], description: "Assistance moving safely around the home and with routine transfers, following the care plan.", durationMinutes: 30 },
  { name: "Meal assistance", aliases: ["meal preparation", "feeding assistance", "help with meals"], description: "Help preparing or serving meals and providing non-clinical meal-time assistance.", durationMinutes: 45 },
  { name: "Companionship", aliases: ["conversation", "companionship visit", "supervision"], description: "Companionship and agreed non-clinical supervision during a home visit.", durationMinutes: 60 },
  { name: "Light household support", aliases: ["light housekeeping", "laundry assistance", "room tidying"], description: "Light household tasks that support the patient during the scheduled care visit.", durationMinutes: 60 },
];

export function CareActivitiesPage() {
  const queryClient = useQueryClient();
  const activities = useQuery({ queryKey: ["care-activities"], queryFn: () => fetchCareActivities(true) });
  const [form, setForm] = useState<ActivityForm>(emptyForm);
  const [editing, setEditing] = useState<CareActivity | null>(null);
  const [templateMessage, setTemplateMessage] = useState("");
  const [templateError, setTemplateError] = useState("");
  const aliases = form.aliasesText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const input = () => ({ name: form.name.trim(), aliases, description: form.description.trim(), durationMinutes: form.durationMinutes });
  const resetForm = () => { setEditing(null); setForm(emptyForm()); };
  const create = useMutation({ mutationFn: createCareActivity, onSuccess: async () => { resetForm(); await queryClient.invalidateQueries({ queryKey: ["care-activities"] }); } });
  const update = useMutation({ mutationFn: ({ id, ...payload }: CareActivity) => updateCareActivity(id, payload), onSuccess: async () => { resetForm(); await queryClient.invalidateQueries({ queryKey: ["care-activities"] }); } });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = input();
    if (editing) update.mutate({ ...editing, ...payload });
    else create.mutate(payload);
  };
  const edit = (activity: CareActivity) => {
    setEditing(activity);
    setForm({ name: activity.name, aliasesText: activity.aliases.join("\n"), description: activity.description, durationMinutes: activity.durationMinutes });
  };
  const addExamples = async () => {
    setTemplateMessage(""); setTemplateError("");
    const results = await Promise.allSettled(examples.map((example) => createCareActivity(example)));
    const added = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - added;
    setTemplateMessage(added ? `Added ${added} starter activities.` : "No starter activities were added.");
    if (failed) setTemplateError(`${failed} activity names may already exist. Review the catalog before trying again.`);
    await queryClient.invalidateQueries({ queryKey: ["care-activities"] });
  };

  return <Stack spacing={2.5}>
    <PageHeader title="Care activities" />
    <Alert severity="info">Group different caller phrases under one activity. The voice agent and post-call extractor use each activity’s description and alternate names to identify the same service, then apply its default duration when suggesting available staff.</Alert>
    {activities.isError && <Alert severity="error">Could not load care activities: {errorText(activities.error)}</Alert>}
    {(create.isError || update.isError) && <Alert severity="error">{errorText(create.error || update.error)}</Alert>}
    {(create.isSuccess || update.isSuccess) && <Alert severity="success">Care activity saved.</Alert>}
    {templateMessage && <Alert severity="success">{templateMessage}</Alert>}
    {templateError && <Alert severity="warning">{templateError}</Alert>}
    <Card><CardContent sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack component="form" onSubmit={submit} spacing={2}>
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1} alignItems={{ sm: "center" }}>
          <Box><Typography variant="h6">{editing ? "Edit activity" : "Add activity"}</Typography><Typography variant="body2" color="text.secondary">Use one canonical activity and list the different words patients may use for it.</Typography></Box>
          {!editing && <Button startIcon={<AutoAwesomeRoundedIcon />} onClick={() => void addExamples()} disabled={activities.isLoading}>Add starter examples</Button>}
        </Stack>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 4 }}><TextField required fullWidth label="Activity name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} inputProps={{ maxLength: 120 }} /></Grid>
          <Grid size={{ xs: 12, md: 3 }}><TextField required fullWidth type="number" label="Default duration (minutes)" value={form.durationMinutes} onChange={(event) => setForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} inputProps={{ min: 1, max: 10080, step: 1 }} /></Grid>
          <Grid size={{ xs: 12, md: 5 }}><TextField fullWidth multiline minRows={2} label="Description" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} inputProps={{ maxLength: 500 }} /></Grid>
          <Grid size={12}><TextField fullWidth multiline minRows={3} label="Alternate names and phrases" helperText="Enter one phrase per line, such as “bathing”, “showering”, or local names for the same activity." value={form.aliasesText} onChange={(event) => setForm((current) => ({ ...current, aliasesText: event.target.value }))} inputProps={{ maxLength: 4000 }} /></Grid>
        </Grid>
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          {editing && <Button onClick={resetForm}>Cancel</Button>}
          <Button type="submit" variant="contained" startIcon={<AddRoundedIcon />} disabled={create.isPending || update.isPending}>{editing ? "Save activity" : "Add activity"}</Button>
        </Stack>
      </Stack>
    </CardContent></Card>
    {activities.isLoading && <Box sx={{ display: "grid", placeItems: "center", py: 4 }}><CircularProgress /></Box>}
    <Stack spacing={1.25}>
      {activities.data?.map((activity) => <Card key={activity.id}><CardContent sx={{ py: 1.75, "&:last-child": { pb: 1.75 } }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ xs: "stretch", md: "center" }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap"><Typography fontWeight={700}>{activity.name}</Typography>{!activity.active && <Chip size="small" label="Inactive" />}</Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>{activity.durationMinutes} minutes · {activity.description || "No description added."}</Typography>
            <Stack direction="row" spacing={.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>{activity.aliases.map((alias) => <Chip key={alias} size="small" variant="outlined" label={alias} />)}</Stack>
          </Box>
          <Button onClick={() => edit(activity)}>Edit</Button>
          <FormControlLabel label={activity.active ? "Active" : "Inactive"} control={<Switch checked={activity.active} disabled={update.isPending} onChange={(_, active) => update.mutate({ ...activity, active })} />} />
        </Stack>
      </CardContent></Card>)}
      {activities.isSuccess && activities.data.length === 0 && <Alert severity="info">Add a care activity or use the starter examples. Each activity can include alternate caller phrases and a description.</Alert>}
    </Stack>
  </Stack>;
}

