import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Divider, Grid, Stack, Typography } from "@mui/material";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import ScheduleRoundedIcon from "@mui/icons-material/ScheduleRounded";
import ArticleRoundedIcon from "@mui/icons-material/ArticleRounded";
import { fetchAssignmentStatus, fetchSessionArtifacts } from "../api/client";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/OperationsUI";
import { CallRecording } from "../components/CallRecording";

function statusColor(status: string): "success" | "error" | "warning" | "default" {
  if (status === "confirmed" || status === "completed") return "success";
  if (status === "not_answered" || status === "review" || status === "exception") return "error";
  if (status === "calling" || status === "processing" || status === "follow_up") return "warning";
  return "default";
}

function formatSessionTime(value: string | null | undefined, timeZone?: string) {
  if (!value) return "Not confirmed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium", timeStyle: "short", timeZone: timeZone || "Asia/Kolkata",
  };
  try {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
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
  const [logStage, setLogStage] = useState<"check_in" | "check_out" | null>(null);
  const artifacts = useQuery({
    queryKey: ["session-artifacts", sessionId],
    queryFn: () => fetchSessionArtifacts(sessionId),
    enabled: false,
    retry: false,
  });

  const showCallLogs = (stage?: "check_in" | "check_out") => {
    setLogStage(stage || null);
    void artifacts.refetch().then(() => requestAnimationFrame(() => document.getElementById("session-call-logs")?.scrollIntoView({ behavior: "smooth", block: "start" })));
  };

  return (
    <Stack spacing={3}>
      <PageHeader eyebrow="ASSIGNMENT TRACKING" title="Session status" description={sessionId} actions={<Button startIcon={<ArrowBackRoundedIcon />} onClick={() => navigate(-1)}>Back</Button>} />
      {query.isLoading && <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}><CircularProgress /></Box>}
      {query.isError && <Alert severity="error">Could not load this session. Confirm the session ID and that your account can access this assignment.</Alert>}
      {query.data && <>
        {query.data.checkIn.flag === "not_answered" || query.data.checkOut.flag === "not_answered" ? <Alert severity="error" icon={<ErrorOutlineRoundedIcon />}>The call retry limit was reached for {query.data.checkIn.flag === "not_answered" && query.data.checkOut.flag === "not_answered" ? "check-in and check-out" : query.data.checkIn.flag === "not_answered" ? "check-in" : "check-out"}. Operations follow-up is required.</Alert> : null}
        <Stack direction="row" justifyContent="flex-end"><Typography variant="caption" color="text.secondary">Times shown in {query.data.timeZone || "Asia/Kolkata"}</Typography></Stack>
        <Grid container spacing={2.5}>
          {[{ label: "Check-in", value: query.data.checkIn }, { label: "Check-out", value: query.data.checkOut }].map((stage) => <Grid key={stage.label} size={{ xs: 12, md: 6 }}><Card><CardContent sx={{ p: 3 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center"><Typography variant="h6">{stage.label}</Typography><Chip color={statusColor(stage.value.status)} label={stage.value.flag ? "Not answered" : stage.value.status.replaceAll("_", " ")} sx={{ textTransform: "capitalize", fontWeight: 650 }} /></Stack>
            <Box sx={{ minHeight: 100, display: "grid", placeItems: "center", py: 2 }}>{stage.value.status === "confirmed" ? <CheckCircleRoundedIcon color="success" sx={{ fontSize: 42 }} /> : stage.value.flag ? <ErrorOutlineRoundedIcon color="error" sx={{ fontSize: 42 }} /> : <ScheduleRoundedIcon color="disabled" sx={{ fontSize: 42 }} />}</Box>
            {stage.value.status === "processing" && <Alert severity="info" sx={{ mb: 2 }}>Call ended. Recording and attendance details are being processed.</Alert>}
            {stage.value.status === "calling" && <Alert severity="warning" sx={{ mb: 2 }}>The outbound call is in progress.</Alert>}
            {stage.value.status === "scheduled" && stage.value.scheduledAt && <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Call scheduled for {formatSessionTime(stage.value.scheduledAt, query.data.timeZone)}</Typography>}
            {stage.value.status === "follow_up" && stage.value.nextCallAt && (new Date(stage.value.nextCallAt).getTime() <= Date.now() ? <Alert severity="warning" sx={{ mb: 1.5 }}>Retry overdue since {formatSessionTime(stage.value.nextCallAt, query.data.timeZone)}. The service is checking for missed work and will place the call as soon as possible.</Alert> : <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Next call scheduled for {formatSessionTime(stage.value.nextCallAt, query.data.timeZone)}</Typography>)}
            <Typography variant="body2" color="text.secondary">Reported time</Typography><Typography fontWeight={650} sx={{ mb: 2 }}>{formatSessionTime(stage.value.reportedAt, query.data.timeZone)}</Typography>
            <Button fullWidth sx={{ mt: 1 }} variant="outlined" startIcon={<HistoryRoundedIcon />} onClick={() => showCallLogs(stage.label === "Check-in" ? "check_in" : "check_out")}>View {stage.label.toLowerCase()} logs</Button>
          </CardContent></Card></Grid>)}
        </Grid>
        <Card id="session-call-logs"><CardContent sx={{ p: 3 }}>
          <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={1.5}>
            <Box><Typography variant="h6">Call logs and recordings</Typography><Typography variant="body2" color="text.secondary">View attempts, transcripts, and recordings separately for check-in and check-out.</Typography></Box>
            <Button variant="outlined" startIcon={artifacts.isFetching ? <CircularProgress size={16} /> : <ArticleRoundedIcon />} onClick={() => showCallLogs()} disabled={artifacts.isFetching}>
              {artifacts.data ? "Refresh call logs" : "View call logs"}
            </Button>
          </Stack>
          {artifacts.isError && <Alert severity="error" sx={{ mt: 2 }}>Could not load call logs. Confirm this API key can access the session.</Alert>}
          {artifacts.data && <Stack spacing={2.5} sx={{ mt: 2.5 }}>
            {(["check_in", "check_out"] as const).map((stage) => {
              if (logStage && logStage !== stage) return null;
              const attempts = artifacts.data.callAttempts.filter((attempt) => attempt.stage === stage);
              return <Box key={stage}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.25 }}>
                  <Typography variant="subtitle1" fontWeight={750}>{stage === "check_in" ? "Check-in" : "Check-out"}</Typography>
                  <Chip size="small" label={`${attempts.length} ${attempts.length === 1 ? "call" : "calls"}`} />
                  {(() => {
                    const task = artifacts.data.tasks.find((item) => item.stage === stage);
                    return task ? <Chip size="small" variant="outlined" label={`Task ${task.id.slice(0, 8)} · ${task.deliveryStatus}`} /> : null;
                  })()}
                </Stack>
                {attempts.length === 0 ? <Typography variant="body2" color="text.secondary">No calls have been placed for this stage yet.</Typography> : <Stack spacing={1.5}>
                  {attempts.map((attempt) => {
                    const transcript = artifacts.data.transcripts.find((item) => item.callAttemptId === attempt.id);
                    return <Card key={attempt.id} variant="outlined" sx={{ boxShadow: "none" }}>
                      <CardContent sx={{ p: 2, "&:last-child": { pb: 2 } }}>
                        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={1}>
                          <Typography fontWeight={700}>Attempt {attempt.attemptNumber}</Typography>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Chip size="small" color={statusColor(attempt.status)} label={attempt.status.replaceAll("_", " ")} sx={{ textTransform: "capitalize" }} />
                            {attempt.durationSeconds != null && <Typography variant="caption" color="text.secondary">{attempt.durationSeconds}s</Typography>}
                          </Stack>
                        </Stack>
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: .5 }}>
                          {attempt.scheduledAt ? formatSessionTime(attempt.scheduledAt, query.data.timeZone) : "Call time unavailable"}
                          {attempt.answeredAt ? ` · answered ${formatSessionTime(attempt.answeredAt, query.data.timeZone)}` : ""}
                          {attempt.endedAt ? ` · ended ${formatSessionTime(attempt.endedAt, query.data.timeZone)}` : ""}
                        </Typography>
                        <Divider sx={{ my: 1.5 }} />
                        {transcript ? <Box sx={{ mb: 1.5 }}>
                          <Typography variant="subtitle2">Transcript · {transcript.language}</Typography>
                          <Typography variant="body2" sx={{ mt: .5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{transcript.text || "No speech was transcribed."}</Typography>
                        </Box> : <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Transcript not available yet.</Typography>}
                        {attempt.recordingAvailable ? <CallRecording sessionId={sessionId} attemptId={attempt.id} /> : <Typography variant="caption" color="text.secondary">Recording not available yet.</Typography>}
                      </CardContent>
                    </Card>;
                  })}
                </Stack>}
              </Box>;
            })}
            <Box>
              <Typography variant="subtitle1" fontWeight={750} sx={{ mb: 1 }}>Session activity</Typography>
              {artifacts.data.logs.length ? <Stack spacing={.75}>
                {artifacts.data.logs.map((log, index) => <Stack key={`${log.createdAt}-${index}`} direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1} sx={{ py: .75, borderBottom: "1px solid", borderColor: "divider" }}>
                  <Typography variant="body2">{log.eventType.replaceAll(".", " · ").replaceAll("_", " ")}</Typography>
                  <Typography variant="caption" color="text.secondary">{formatSessionTime(log.createdAt, query.data.timeZone)}</Typography>
                </Stack>)}
              </Stack> : <Typography variant="body2" color="text.secondary">No activity logs recorded yet.</Typography>}
            </Box>
          </Stack>}
        </CardContent></Card>
        <Card><CardContent sx={{ p: 3 }}><Typography variant="h6" sx={{ mb: 2 }}>Attendance task delivery</Typography><Stack direction={{ xs: "column", sm: "row" }} spacing={4}><Box><Typography variant="caption" color="text.secondary">Check-in event</Typography><Typography fontWeight={650} textTransform="capitalize">{query.data.checkIn.deliveryStatus || "pending"}</Typography></Box><Box><Typography variant="caption" color="text.secondary">Check-out event</Typography><Typography fontWeight={650} textTransform="capitalize">{query.data.checkOut.deliveryStatus || "pending"}</Typography></Box><Box><Typography variant="caption" color="text.secondary">Assignment progress</Typography><Typography fontWeight={650} textTransform="capitalize">{query.data.sessionStatus}</Typography></Box><Box><Typography variant="caption" color="text.secondary">Assignment</Typography><Typography fontWeight={650}>{query.data.assignmentId}</Typography></Box></Stack></CardContent></Card>
        <Typography variant="caption" color="text.secondary">Active sessions refresh every 8 seconds.</Typography>
      </>}
    </Stack>
  );
}
