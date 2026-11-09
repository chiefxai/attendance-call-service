import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Grid, Stack, Typography } from "@mui/material";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import ScheduleRoundedIcon from "@mui/icons-material/ScheduleRounded";
import { fetchAssignmentStatus } from "../api/client";
import { useNavigate } from "react-router-dom";

function statusColor(status: string): "success" | "error" | "warning" | "default" {
  if (status === "confirmed" || status === "completed") return "success";
  if (status === "not_answered" || status === "review" || status === "exception") return "error";
  if (status === "calling" || status === "processing" || status === "follow_up") return "warning";
  return "default";
}

export function AssignmentStatusPage() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["assignment-status", sessionId],
    queryFn: () => fetchAssignmentStatus(sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: (state) => state.state.data?.sessionStatus === "active" ? 8_000 : false,
  });

  return (
    <Stack spacing={3}>
      <Button startIcon={<ArrowBackRoundedIcon />} onClick={() => navigate(-1)} sx={{ alignSelf: "flex-start" }}>Back to overview</Button>
      <Box><Typography variant="overline" color="primary.main" fontWeight={750} letterSpacing=".12em">ASSIGNMENT TRACKING</Typography><Typography variant="h4" sx={{ mt: .5 }}>Session status</Typography><Typography color="text.secondary" sx={{ mt: .75, overflowWrap: "anywhere" }}>{sessionId}</Typography></Box>
      {query.isLoading && <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}><CircularProgress /></Box>}
      {query.isError && <Alert severity="error">Could not load this session. Confirm the session ID and that your account can access this assignment.</Alert>}
      {query.data && <>
        {query.data.checkIn.flag === "not_answered" || query.data.checkOut.flag === "not_answered" ? <Alert severity="error" icon={<ErrorOutlineRoundedIcon />}>The call retry limit was reached for {query.data.checkIn.flag === "not_answered" && query.data.checkOut.flag === "not_answered" ? "check-in and check-out" : query.data.checkIn.flag === "not_answered" ? "check-in" : "check-out"}. Operations follow-up is required.</Alert> : null}
        <Grid container spacing={2.5}>
          {[{ label: "Check-in", value: query.data.checkIn }, { label: "Check-out", value: query.data.checkOut }].map((stage) => <Grid key={stage.label} size={{ xs: 12, md: 6 }}><Card><CardContent sx={{ p: 3 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center"><Typography variant="h6">{stage.label}</Typography><Chip color={statusColor(stage.value.status)} label={stage.value.flag ? "Not answered" : stage.value.status.replaceAll("_", " ")} sx={{ textTransform: "capitalize", fontWeight: 650 }} /></Stack>
            <Box sx={{ minHeight: 100, display: "grid", placeItems: "center", py: 2 }}>{stage.value.status === "confirmed" ? <CheckCircleRoundedIcon color="success" sx={{ fontSize: 42 }} /> : stage.value.flag ? <ErrorOutlineRoundedIcon color="error" sx={{ fontSize: 42 }} /> : <ScheduleRoundedIcon color="disabled" sx={{ fontSize: 42 }} />}</Box>
            {stage.value.status === "processing" && <Alert severity="info" sx={{ mb: 2 }}>Call ended. Recording and attendance details are being processed.</Alert>}
            {stage.value.status === "calling" && <Alert severity="warning" sx={{ mb: 2 }}>The outbound call is in progress.</Alert>}
            {stage.value.status === "scheduled" && stage.value.scheduledAt && <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Call scheduled for {new Date(stage.value.scheduledAt).toLocaleString()}</Typography>}
            {stage.value.status === "follow_up" && stage.value.nextCallAt && <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Next call scheduled for {new Date(stage.value.nextCallAt).toLocaleString()}</Typography>}
            <Typography variant="body2" color="text.secondary">Reported time</Typography><Typography fontWeight={650}>{stage.value.reportedAt ? new Date(stage.value.reportedAt).toLocaleString() : "Not confirmed"}</Typography>
          </CardContent></Card></Grid>)}
        </Grid>
        <Card><CardContent sx={{ p: 3 }}><Typography variant="h6" sx={{ mb: 2 }}>Session delivery</Typography><Stack direction={{ xs: "column", sm: "row" }} spacing={4}><Box><Typography variant="caption" color="text.secondary">Overall session</Typography><Typography fontWeight={650} textTransform="capitalize">{query.data.sessionStatus}</Typography></Box><Box><Typography variant="caption" color="text.secondary">Backend delivery</Typography><Typography fontWeight={650} textTransform="capitalize">{query.data.backendDeliveryStatus}</Typography></Box><Box><Typography variant="caption" color="text.secondary">Assignment</Typography><Typography fontWeight={650}>{query.data.assignmentId}</Typography></Box></Stack></CardContent></Card>
        <Typography variant="caption" color="text.secondary">Active sessions refresh every 8 seconds.</Typography>
      </>}
    </Stack>
  );
}
