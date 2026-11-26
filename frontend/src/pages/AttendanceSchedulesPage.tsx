import { useEffect, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TablePagination, TableRow, TableSortLabel, TextField, Typography } from "@mui/material";
import EventAvailableRoundedIcon from "@mui/icons-material/EventAvailableRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import TaskAltRoundedIcon from "@mui/icons-material/TaskAltRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { fetchAttendance, fetchAthulyaAttendanceSubmissions, fetchAthulyaSchedules, fetchCallingSettings, fetchSessionArtifacts, submitAttendanceReviewDecision, type AttendanceRecord, type AthulyaAttendanceSubmission, type AthulyaSchedule } from "../api/client";
import { MetricCard, PageHeader, StatusChip, OperationsTable } from "../components/OperationsUI";
import { CallRecording } from "../components/CallRecording";

type ScheduleSortKey = "check_in" | "check_out" | "status" | "patient" | "caregivers" | "service";
type ScheduleSort = `${ScheduleSortKey}_${"ascending" | "descending"}`;

function todayInIndia() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function attendanceTimeOnScheduleDate(dateValue: string | null | undefined, timeValue: string | null | undefined) {
  const date = String(dateValue || "").slice(0, 10);
  const time = String(timeValue || "").slice(0, 5);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !/^\\d{2}:\\d{2}$/.test(time)) return null;
  const instant = new Date(`${date}T${time}:00+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function serviceDateBounds(date: string) {
  const start = new Date(`${date}T00:00:00+05:30`);
  const end = new Date(`${date}T23:59:59.999+05:30`);
  return { fromDate: start.toISOString(), toDate: end.toISOString() };
}

function scheduledInstant(dateValue: string | null | undefined, timeValue: string | null | undefined) {
  if (!dateValue || !timeValue) return null;
  const dateText = String(dateValue).slice(0, 10);
  const rawTime = String(timeValue).trim();
  if (/\d{4}-\d{2}-\d{2}T/.test(rawTime)) {
    const parsed = new Date(rawTime);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const match = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = String(match[4] || "").toUpperCase();
  if (minute > 59 || second > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
  } else if (hour > 23) return null;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  const parsed = new Date(`${dateText}T${time}+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type AttendanceStatus = "upcoming" | "in_progress" | "delayed" | "retry" | "escalated" | "unresolved" | "retry_scheduled" | "attention_required" | "completed" | "cancelled";

function scheduleStatus(schedule: AthulyaSchedule, records: AttendanceRecord[]): AttendanceStatus {
  const externalStatus = String(schedule.status || "").trim().toLowerCase().replaceAll(/[\s_-]/g, "");
  if (["cancelled", "canceled"].includes(externalStatus)) return "cancelled";

  const checkInDue = scheduledInstant(schedule.date, schedule.startTime);
  const checkOutDue = scheduledInstant(schedule.date, schedule.endTime);
  const now = Date.now();
  if (!records.length) {
    return checkInDue && checkOutDue && now > checkOutDue.getTime() ? "attention_required" : "upcoming";
  }

  const stages = records.flatMap((record) => [
    { status: record.checkIn.status },
    { status: record.checkOut.status },
  ]);
  if (stages.every(({ status }) => status === "confirmed")) return "completed";
  if (stages.some(({ status }) => status === "unresolved")) return "unresolved";
  if (stages.some(({ status }) => status === "escalated")) return "escalated";
  if (stages.some(({ status }) => status === "retry")) return "retry";
  if (records.some((record) => record.sessionStatus === "exception")
    || stages.some(({ status }) => ["not_answered", "missed", "review"].includes(status))) {
    return "attention_required";
  }
  if (records.some((record) =>
    (record.checkIn.status === "follow_up" && record.stageReasons.checkIn === "not_answered")
    || (record.checkOut.status === "follow_up" && record.stageReasons.checkOut === "not_answered")
  )) return "retry_scheduled";

  if (records.some((record) =>
    (record.checkIn.status === "follow_up" && record.stageReasons.checkIn === "employee_requested_callback")
    || (record.checkOut.status === "follow_up" && record.stageReasons.checkOut === "employee_requested_callback")
  )) return "delayed";

  if (stages.some(({ status }) => ["calling", "processing", "confirmed", "follow_up"].includes(status))
    || records.some((record) => record.checkInAttemptCount > 0 || record.checkOutAttemptCount > 0)) return "in_progress";

  if (checkInDue && checkOutDue && now > checkOutDue.getTime()) return "attention_required";
  return "upcoming";
}

function matchingAttendance(schedule: AthulyaSchedule, records: AttendanceRecord[]) {
  const ids = new Set([schedule.athulyaScheduleId, schedule.athulyaSchedulePk].filter(Boolean));
  return records.filter((record) => ids.has(record.assignmentId));
}

function scheduleSubmissionEvents(schedule: AthulyaSchedule, submissions: AthulyaAttendanceSubmission[]) {
  const ids = new Set([schedule.athulyaScheduleId, schedule.athulyaSchedulePk].filter(Boolean));
  return submissions.filter((event) => event.scheduleId && ids.has(event.scheduleId));
}

function latestStageSubmission(events: AthulyaAttendanceSubmission[], eventType: AthulyaAttendanceSubmission["eventType"]) {
  return events.filter((event) => event.eventType === eventType)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

function unifiedAttendanceStatus(schedule: AthulyaSchedule, records: AttendanceRecord[]) {
  const internal = scheduleStatus(schedule, records);
  if (internal === "cancelled") return "cancelled";
  if (records.length > 0 && records.every((record) => record.checkIn.status === "confirmed" && record.checkOut.status === "confirmed")) return "completed";
  if (records.some((record) => record.checkIn.status === "confirmed")) {
    const end = scheduledInstant(schedule.date, schedule.endTime);
    return end && Date.now() > end.getTime() ? "missing check-out" : "checked in";
  }
  const start = scheduledInstant(schedule.date, schedule.startTime);
  if (!records.length && start && Date.now() < start.getTime()) return "upcoming";
  return "pending check-in";
}

function compactScheduleTime(value: string, scheduleDate: string | null | undefined) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (dateKey === scheduleDate) return scheduleClock(value);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function localStageHint(records: AttendanceRecord[], stage: "checkIn" | "checkOut", scheduleDate: string | null | undefined, retryLimit?: number) {
  const candidates = records.map((record) => ({ record, value: record[stage], reason: record.stageReasons[stage] }));
  // A schedule can have multiple attendance sessions over time. Prefer the
  // most recently updated stage so an old `calling` session cannot mask a
  // newer failed/finished attempt.
  const priority = (status: string) => ["calling", "processing"].includes(status) ? 3 : ["retry", "follow_up", "escalated"].includes(status) ? 2 : ["review", "not_answered", "missed", "unresolved", "confirmed"].includes(status) ? 1 : 0;
  const current = candidates.sort((left, right) => {
    const updatedDifference = new Date(right.record.updatedAt).getTime() - new Date(left.record.updatedAt).getTime();
    return updatedDifference || priority(right.value.status) - priority(left.value.status);
  })[0];
  if (!current) return null;
  if (current.value.status === "calling") return "Calling now";
  if (current.value.status === "processing") return "Processing call";
  if (["review", "not_answered", "missed"].includes(current.value.status)) return "Needs review";
  if (current.value.status === "retry" || (current.value.status === "follow_up" && current.reason !== "employee_requested_callback")) {
    const attempt = current.record[stage === "checkIn" ? "checkInAttemptCount" : "checkOutAttemptCount"] + 1;
    const count = retryLimit ? ` · attempt ${attempt} of ${retryLimit}` : ` · attempt ${attempt}`;
    return `Retry${count}${current.value.nextCallAt ? ` · ${compactScheduleTime(current.value.nextCallAt, scheduleDate)}` : " scheduled"}`;
  }
  if (current.value.status === "follow_up") {
    return current.value.nextCallAt ? `Callback · ${compactScheduleTime(current.value.nextCallAt, scheduleDate)}` : "Callback requested";
  }
  if (current.value.status === "escalated") {
    const attempt = current.record[stage === "checkIn" ? "checkInCareManagerAttemptCount" : "checkOutCareManagerAttemptCount"] + 1;
    const count = retryLimit ? ` · attempt ${attempt} of ${retryLimit}` : ` · attempt ${attempt}`;
    return `Care manager${count}${current.value.nextCallAt ? ` · ${compactScheduleTime(current.value.nextCallAt, scheduleDate)}` : " follow-up"}`;
  }
  if (current.value.status === "unresolved") return "Manual follow-up needed";
  return null;
}

function scheduleClock(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && /[T ]/.test(value)) {
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);
  }
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 24 && minute < 60) return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, hour, minute));
  }
  return value;
}

function dateTimeLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
  }).format(date);
}

function AttendanceStage({ records, stage, scheduleDate, scheduledTime, emptyLabel, canAssessCall, retryLimit, onReviewClick }: { records: AttendanceRecord[]; stage: "checkIn" | "checkOut"; scheduleDate: string | null; scheduledTime: string | null | undefined; emptyLabel: string; canAssessCall: boolean; retryLimit?: number; onReviewClick?: (sessionId: string, stage: "check_in" | "check_out") => void }) {
  const dueAt = scheduledInstant(scheduleDate, scheduledTime);
  const overdue = Boolean(dueAt && dueAt.getTime() <= Date.now());
  const stageName = stage === "checkIn" ? "Checked In" : "Completed";
  if (!records.length) return <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
    <Typography variant="body2" color={scheduleClock(scheduledTime) === "—" ? "text.disabled" : "text.secondary"} sx={{ minWidth: 68, whiteSpace: "nowrap" }}>
      {scheduleClock(scheduledTime) === "—" ? emptyLabel : scheduleClock(scheduledTime)}
    </Typography>
    {canAssessCall && <StatusChip compact status={overdue ? "call not placed" : "upcoming"} />}
  </Stack>;

  return <Stack spacing={0.75}>
    {records.map((record) => {
      const stageStatus = record[stage];
      const attemptCount = stage === "checkIn" ? record.checkInAttemptCount : record.checkOutAttemptCount;
      const reason = stage === "checkIn" ? record.stageReasons.checkIn : record.stageReasons.checkOut;
      const employeeRequestedDelay = stageStatus.status === "follow_up" && reason === "employee_requested_callback";
      const retryScheduled = stageStatus.status === "retry" || (stageStatus.status === "follow_up" && !employeeRequestedDelay);
      const wasNotPlaced = overdue && attemptCount === 0 && stageStatus.status === "scheduled";
      let displayStatus = stageStatus.status;
      if (stageStatus.status === "confirmed") displayStatus = stageName;
      else if (stageStatus.status === "scheduled") displayStatus = wasNotPlaced ? "call not placed" : "upcoming";
      else if (employeeRequestedDelay) displayStatus = "delayed";
      else if (stageStatus.status === "retry") displayStatus = "retry";
      else if (stageStatus.status === "escalated") displayStatus = "escalated";
      else if (stageStatus.status === "unresolved") displayStatus = "unresolved";
      else if (retryScheduled && reason === "not_answered") displayStatus = "not answered";
      else if (retryScheduled) displayStatus = "retry scheduled";
      else if (stageStatus.status === "review") displayStatus = "needs review";
      const displayTime = stageStatus.status === "confirmed"
        ? stageStatus.reportedAt || scheduledTime
        : ["follow_up", "retry", "escalated"].includes(stageStatus.status) && stageStatus.nextCallAt
          ? stageStatus.nextCallAt
          : scheduledTime;
      const hint = localStageHint([record], stage, scheduleDate, retryLimit);
      return <Stack key={record.sessionId} spacing={0.35} alignItems="flex-start">
        {records.length > 1 && <Typography variant="caption" color="text.secondary">{record.employee.name}</Typography>}
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="nowrap">
          <Typography variant="body2" color={stageStatus.status === "confirmed" ? "text.primary" : displayTime ? "text.secondary" : "text.disabled"} sx={{ minWidth: 68, whiteSpace: "nowrap" }}>
            {displayTime ? scheduleClock(displayTime) : emptyLabel}
          </Typography>
          {["review", "unresolved", "not_answered", "missed"].includes(stageStatus.status)
            ? <Chip size="small" color="error" label="Review" clickable onClick={() => onReviewClick?.(record.sessionId, stage === "checkIn" ? "check_in" : "check_out")} />
            : <StatusChip compact status={displayStatus} />}
        </Stack>
        {hint && <Typography variant="caption" color={hint.startsWith("Retry") ? "error.main" : hint.startsWith("Care manager") ? "warning.dark" : hint.includes("follow-up") ? "error.main" : "text.secondary"} sx={{ fontSize: 11, lineHeight: 1.2 }}>{hint}</Typography>}
      </Stack>;
    })}
  </Stack>;
}

export function AttendanceSchedulesPage({ userRole = "admin" }: { userRole?: "admin" | "care_manager" }) {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selectedDate, setSelectedDate] = useState(todayInIndia);
  const [sortBy, setSortBy] = useState<ScheduleSort>("check_in_descending");
  const [selectedSchedule, setSelectedSchedule] = useState<AthulyaSchedule | null>(null);
  const [reviewFocus, setReviewFocus] = useState<{ sessionId: string; stage: "check_in" | "check_out" } | null>(null);
  const [reviewActualTime, setReviewActualAt] = useState("");
  const [reviewMessage, setReviewMessage] = useState<{ severity: "success" | "error"; text: string } | null>(null);
  const queryClient = useQueryClient();
  const reviewDecision = useMutation({
    mutationFn: (action: "approve" | "cancel") => {
      if (!reviewFocus) throw new Error("Select an attendance stage to review.");
      const actualAt = action === "approve"
        ? attendanceTimeOnScheduleDate(selectedSchedule?.date, reviewActualTime)
        : null;
      if (action === "approve" && !actualAt) throw new Error("Select a valid attendance time.");
      return submitAttendanceReviewDecision(reviewFocus.sessionId, {
        action, stage: reviewFocus.stage,
        ...(actualAt ? { actualAt: actualAt.toISOString() } : {}),
      });
    },
    onSuccess: async (_result, action) => {
      setReviewFocus(null);
      setReviewMessage({ severity: "success", text: action === "approve" ? "Attendance marked completed and queued for Athulya submission." : "Duty cancelled." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["attendance"] }),
        queryClient.invalidateQueries({ queryKey: ["session-artifacts"] }),
      ]);
    },
    onError: (error: any) => setReviewMessage({ severity: "error", text: error?.response?.data?.error || error.message || "Could not save the review decision." }),
  });
  const isAdmin = userRole === "admin";
  const schedules = useQuery({
    queryKey: ["athulya-schedules", selectedDate],
    queryFn: () => fetchAthulyaSchedules({ fromDate: selectedDate, toDate: selectedDate }),
    refetchInterval: 30_000,
  });
  const submissionQuery = useQuery({
    queryKey: ["athulya-attendance-submissions", selectedDate],
    queryFn: () => fetchAthulyaAttendanceSubmissions({ ...serviceDateBounds(selectedDate), limit: 500 }),
    enabled: isAdmin,
    refetchInterval: isAdmin ? 15_000 : false,
    retry: false,
  });
  const attendance = useQuery({
    queryKey: ["attendance", "schedule-status"],
    queryFn: () => fetchAttendance({ limit: 500 }),
    refetchInterval: 15_000,
  });
  const callingSettings = useQuery({ queryKey: ["calling-settings"], queryFn: fetchCallingSettings, staleTime: 60_000 });
  const scheduleAttendance = useQuery({
    queryKey: ["attendance", "schedule-detail", selectedSchedule?.id],
    enabled: Boolean(selectedSchedule),
    queryFn: async () => {
      const ids = [selectedSchedule?.athulyaScheduleId, selectedSchedule?.athulyaSchedulePk].filter((value): value is string => Boolean(value));
      const matches = (await Promise.all(ids.map((search) => fetchAttendance({ search, limit: 500 })))).flat()
        .filter((record) => ids.includes(record.assignmentId));
      return [...new Map(matches.map((record) => [record.sessionId, record])).values()];
    },
    refetchInterval: selectedSchedule ? 15_000 : (false as const),
  });
  const schedulesData = schedules.data || [];
  const attendanceData = attendance.data || [];
  const submissionEvents = submissionQuery.data || [];
  const scheduleSessions = selectedSchedule
    ? (scheduleAttendance.data || matchingAttendance(selectedSchedule, attendanceData))
    : [];
  const conversationQueries = useQueries({ queries: scheduleSessions.map((record) => ({
    queryKey: ["session-artifacts", record.sessionId],
    queryFn: () => fetchSessionArtifacts(record.sessionId),
    enabled: Boolean(selectedSchedule),
    retry: false,
    refetchInterval: selectedSchedule ? 15_000 : (false as const),
  })) });
  const statusesBySchedule = new Map(schedulesData.map((schedule) => [schedule.id, scheduleStatus(schedule, attendanceData)]));
  const enrichedSchedules = schedulesData.map((schedule) => {
    const localTasks = matchingAttendance(schedule, attendanceData);
    return { schedule, localTasks, status: scheduleStatus(schedule, localTasks) };
  });
  const sortedSchedules = [...enrichedSchedules].sort((left, right) => {
    const a = left.schedule;
    const b = right.schedule;
    const startA = scheduledInstant(a.date, a.startTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const startB = scheduledInstant(b.date, b.startTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const endA = scheduledInstant(a.date, a.endTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const endB = scheduledInstant(b.date, b.endTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sortKey = sortBy.replace(/_(ascending|descending)$/, "") as ScheduleSortKey;
    const descending = sortBy.endsWith("descending");
    let comparison = 0;
    if (sortKey === "check_in") comparison = startA - startB;
    else if (sortKey === "check_out") comparison = endA - endB;
    else {
      const valueFor = (schedule: AthulyaSchedule) => {
        if (sortKey === "status") return statusesBySchedule.get(schedule.id) || "upcoming";
        if (sortKey === "patient") return schedule.patient.name || "";
        if (sortKey === "caregivers") return schedule.caregivers.map((caregiver) => caregiver.name || caregiver.phone || "").join(", ");
        return schedule.service || "";
      };
      comparison = valueFor(a).localeCompare(valueFor(b), undefined, { sensitivity: "base", numeric: true });
    }
    return descending ? -comparison : comparison;
  });
  useEffect(() => setPage(0), [selectedDate, sortBy, schedulesData.length]);
  const pageRows = sortedSchedules.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const counts = enrichedSchedules.reduce((result, { status }) => {
    result[status] += 1;
    return result;
  }, { upcoming: 0, in_progress: 0, delayed: 0, retry: 0, escalated: 0, unresolved: 0, retry_scheduled: 0, attention_required: 0, completed: 0, cancelled: 0 } satisfies Record<AttendanceStatus, number>);
  const dateLabel = selectedDate
    ? new Date(`${selectedDate}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })
    : "Choose a date";

  const selectedScheduleEvents = selectedSchedule ? scheduleSubmissionEvents(selectedSchedule, submissionEvents) : [];
  const selectedCheckInSubmission = latestStageSubmission(selectedScheduleEvents, "check_in");
  const selectedCheckOutSubmission = latestStageSubmission(selectedScheduleEvents, "check_out");
  const activeSortKey = sortBy.replace(/_(ascending|descending)$/, "") as ScheduleSortKey;
  const activeSortDirection = sortBy.endsWith("descending") ? "desc" : "asc";
  const changeSort = (key: ScheduleSortKey) => setSortBy((current) => {
    const currentKey = current.replace(/_(ascending|descending)$/, "");
    const nextDirection = currentKey === key && current.endsWith("ascending") ? "descending" : "ascending";
    return `${key}_${nextDirection}` as ScheduleSort;
  });

  return <Stack spacing={{ xs: 1.5, md: 1.75 }} sx={{ height: { xs: "auto", md: "calc(100dvh - 152px)" }, minHeight: { xs: 0, md: 440 }, pb: { xs: 1, md: 0 } }}>
    <PageHeader title="Schedule & Attendance" actions={<Chip icon={<EventAvailableRoundedIcon />} label={dateLabel} variant="outlined" />} />
    <Grid container spacing={1.75}>
      <Grid size={{ xs: 6, sm: 6, md: 3 }}><MetricCard compact label="Schedules" value={schedules.isLoading ? "—" : schedulesData.length.toLocaleString()} detail="For the selected day" icon={<EventAvailableRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, sm: 6, md: 3 }}><MetricCard compact label="Upcoming" value={schedules.isLoading ? "—" : counts.upcoming.toLocaleString()} detail="Waiting for scheduled time" icon={<PendingActionsRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 6, sm: 6, md: 3 }}><MetricCard compact label="Delayed" value={schedules.isLoading || attendance.isLoading ? "—" : counts.delayed.toLocaleString()} detail="Missed calls or needs follow-up" icon={<PendingActionsRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
      <Grid size={{ xs: 6, sm: 6, md: 3 }}><MetricCard compact label="Completed" value={schedules.isLoading ? "—" : counts.completed.toLocaleString()} detail="Finished duties" icon={<TaskAltRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
    </Grid>
    <Card sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: { xs: 400, md: 0 }, overflow: "hidden" }}>
      {schedules.isLoading && <LinearProgress />}
      {schedules.isError && <Alert severity="error" sx={{ m: 2 }}>Scheduled duties could not be loaded.</Alert>}
      {attendance.isError && <Alert severity="warning" sx={{ m: 2 }}>Attendance updates could not be loaded.</Alert>}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "stretch", sm: "center" }} sx={{ p: { xs: 1.25, sm: 2 }, borderBottom: "1px solid #e8edf3", flexShrink: 0 }}>
        <TextField type="date" size="small" required label="Schedule date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value || todayInIndia())} InputLabelProps={{ shrink: true }} sx={{ minWidth: { sm: 200 } }} />
        <Button size="small" onClick={() => setSelectedDate(todayInIndia())} disabled={selectedDate === todayInIndia()}>Today</Button>
        <Chip label={`${schedulesData.length} schedules`} variant="outlined" sx={{ alignSelf: { xs: "flex-start", sm: "center" } }} />
      </Stack>
      <OperationsTable sx={{ flex: 1, minHeight: { xs: 250, md: 0 }, maxHeight: { xs: "55dvh", md: "none" }, overflow: "auto" }}>
        <Table size="small" stickyHeader sx={{ minWidth: 850 }} aria-label="Attendance and schedules">
          <TableHead><TableRow>
            {([{ key: "patient", label: "Patient" }, { key: "caregivers", label: "Care givers" }, { key: "service", label: "Service" }, { key: "check_in", label: "Check in" }, { key: "check_out", label: "Check out" }, { key: "status", label: "Status" }] as const).map(({ key, label }) => <TableCell key={key} sortDirection={activeSortKey === key ? activeSortDirection : false} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>
              <TableSortLabel active={activeSortKey === key} direction={activeSortKey === key ? activeSortDirection : "asc"} onClick={() => changeSort(key)}>{label}</TableSortLabel>
            </TableCell>)}
            <TableCell sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>Details</TableCell>
          </TableRow></TableHead>
          <TableBody>
            {pageRows.map(({ schedule, localTasks, status }) => <TableRow key={schedule.id} hover>
              <TableCell>{schedule.patient.name || "—"}</TableCell>
              <TableCell>{schedule.caregivers.map((caregiver) => caregiver.name || caregiver.phone).join(", ") || "—"}</TableCell>
              <TableCell>{schedule.service || "—"}</TableCell>
              <TableCell><AttendanceStage records={localTasks} stage="checkIn" scheduleDate={schedule.date} scheduledTime={schedule.startTime} retryLimit={callingSettings.data?.retry.maxConsecutiveNoAnswer} canAssessCall={attendance.isSuccess} emptyLabel={attendance.isLoading ? "Loading…" : attendance.isError ? "Unavailable" : "—"} onReviewClick={(sessionId, stage) => { setSelectedSchedule(schedule); setReviewFocus({ sessionId, stage }); setReviewActualAt(""); setReviewMessage(null); }} /></TableCell>
              <TableCell><AttendanceStage records={localTasks} stage="checkOut" scheduleDate={schedule.date} scheduledTime={schedule.endTime} retryLimit={callingSettings.data?.retry.maxConsecutiveNoAnswer} canAssessCall={attendance.isSuccess} emptyLabel={attendance.isLoading ? "Loading…" : attendance.isError ? "Unavailable" : "—"} onReviewClick={(sessionId, stage) => { setSelectedSchedule(schedule); setReviewFocus({ sessionId, stage }); setReviewActualAt(""); setReviewMessage(null); }} /></TableCell>
              <TableCell><StatusChip compact status={status} /></TableCell>
              <TableCell><Button size="small" onClick={() => setSelectedSchedule(schedule)}>Details</Button></TableCell>
            </TableRow>)}
            {schedules.isSuccess && schedulesData.length === 0 && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5 }}>No schedules found for {dateLabel}. Choose another date or contact your administrator.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </OperationsTable>
      <TablePagination component="div" count={sortedSchedules.length} page={page} onPageChange={(_, nextPage) => setPage(nextPage)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Schedules per page" />
    </Card>

    <Dialog open={Boolean(selectedSchedule)} onClose={() => { setSelectedSchedule(null); setReviewFocus(null); }} fullWidth maxWidth="md" PaperProps={{ sx: { borderRadius: 3 } }}>
      {selectedSchedule && <>
        <DialogTitle sx={{ px: { xs: 2, sm: 3 }, pt: 2.5, pb: 1.5 }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h5" fontWeight={750} sx={{ overflowWrap: "anywhere" }}>{selectedSchedule.patient.name || "Patient schedule"}</Typography>
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" sx={{ mt: 0.5 }}>
                <Typography variant="body2" color="text.secondary">{selectedSchedule.service || "Care service"}</Typography>
                <Chip size="small" variant="outlined" label={`Schedule ID · ${selectedSchedule.athulyaScheduleId || selectedSchedule.athulyaSchedulePk || selectedSchedule.id}`} sx={{ height: 23, maxWidth: "100%", fontSize: 11, fontWeight: 650 }} />
              </Stack>
            </Box>
            <StatusChip status={unifiedAttendanceStatus(selectedSchedule, scheduleSessions)} />
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, py: 2.5, bgcolor: "#fbfcfb" }}>
          <Stack spacing={2}>
            {reviewFocus && scheduleSessions.filter((record) => record.sessionId === reviewFocus.sessionId).map((record) => {
              const queryIndex = scheduleSessions.findIndex((item) => item.sessionId === record.sessionId);
              const artifacts = conversationQueries[queryIndex]?.data;
              const attempts = (artifacts?.callAttempts || []).filter((attempt) => attempt.stage === reviewFocus.stage && attempt.callTargetRole === "employee").sort((a, b) => a.attemptNumber - b.attemptNumber);
              const attempt = attempts.at(-1);
              const transcript = attempt ? artifacts?.transcripts.find((item) => item.callAttemptId === attempt.id) : undefined;
              const summary = typeof attempt?.outcome?.transcript_summary === "string" ? attempt.outcome.transcript_summary : typeof attempt?.outcome?.summary === "string" ? attempt.outcome.summary : "";
              return <Card key={record.sessionId} variant="outlined" sx={{ p: 2, borderColor: "#efb5b5", boxShadow: "none" }}>
                <Typography variant="subtitle1" fontWeight={800}>Care manager review · {reviewFocus.stage === "check_in" ? "Check-in" : "Check-out"}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Review the call recording and transcript, then confirm the actual attendance time or cancel the duty.</Typography>
                {conversationQueries[queryIndex]?.isLoading && <LinearProgress sx={{ mb: 1 }} />}
                {conversationQueries[queryIndex]?.isError && <Alert severity="error" sx={{ mb: 1 }}>Call evidence could not be loaded.</Alert>}
                {!attempt && <Alert severity="warning" sx={{ mb: 1 }}>No caregiver call attempt is available for this stage.</Alert>}
                {attempt && <Stack spacing={1.25} sx={{ mb: 1.5 }}>
                  {attempt.recordingAvailable ? <CallRecording sessionId={record.sessionId} attemptId={attempt.id} /> : <Alert severity="info">Call recording is not available for this attempt.</Alert>}
                  {summary && <Typography variant="body2"><strong>Call summary:</strong> {summary}</Typography>}
                  {transcript?.text && <Box sx={{ p: 1.25, bgcolor: "#f6f8f7", borderRadius: 1.5 }}><Typography variant="caption" fontWeight={750}>TRANSCRIPT</Typography><Typography variant="body2" sx={{ whiteSpace: "pre-wrap", mt: 0.5 }}>{transcript.text}</Typography></Box>}
                </Stack>}
                {reviewMessage && <Alert severity={reviewMessage.severity} sx={{ mb: 1.25 }}>{reviewMessage.text}</Alert>}
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 1.25 }}>
                  <TextField size="small" type="date" label="Schedule date" value={selectedSchedule.date.slice(0, 10)} disabled InputLabelProps={{ shrink: true }} sx={{ width: { xs: "100%", sm: 190 } }} />
                  <TextField size="small" type="time" label="Actual attendance time" value={reviewActualTime} onChange={(event) => setReviewActualTime(event.target.value)} inputProps={{ step: 60 }} InputLabelProps={{ shrink: true }} helperText="Date is fixed to the schedule. Enter the confirmed time." sx={{ width: { xs: "100%", sm: 230 } }} />
                </Stack>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                  <Button variant="contained" color="success" disabled={!attempt || reviewDecision.isPending || !attendanceTimeOnScheduleDate(selectedSchedule.date, reviewActualTime)} onClick={() => reviewDecision.mutate("approve")}>Mark stage completed</Button>
                  <Button variant="outlined" color="error" disabled={reviewDecision.isPending} onClick={() => reviewDecision.mutate("cancel")}>Cancel duty</Button>
                </Stack>
              </Card>;
            })}
            <Card variant="outlined" sx={{ p: { xs: 1.25, sm: 1.5 }, boxShadow: "none", borderColor: "#d8e6df", bgcolor: "#f6faf8" }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                <Typography variant="subtitle2" fontWeight={800}>Attendance timeline</Typography>
                <Chip size="small" label="IST" variant="outlined" sx={{ height: 22, fontSize: 11 }} />
              </Stack>
              {scheduleAttendance.isLoading && <LinearProgress sx={{ mb: 0.5 }} />}
              {scheduleAttendance.isError && <Typography variant="caption" color="error.main" sx={{ display: "block", mb: 0.5 }}>Actual attendance could not be loaded.</Typography>}
              {([{
                label: "Check-in",
                scheduled: scheduledInstant(selectedSchedule.date, selectedSchedule.startTime),
                actual: scheduleSessions.find((record) => record.checkIn.reportedAt)?.checkIn.reportedAt || selectedCheckInSubmission?.eventAt || null,
                submission: selectedCheckInSubmission,
              }, {
                label: "Check-out",
                scheduled: scheduledInstant(selectedSchedule.date, selectedSchedule.endTime),
                actual: scheduleSessions.find((record) => record.checkOut.reportedAt)?.checkOut.reportedAt || selectedCheckOutSubmission?.eventAt || null,
                submission: selectedCheckOutSubmission,
              }]).map(({ label, scheduled, actual, submission }) => {
                const scheduledLabel = scheduled ? dateTimeLabel(scheduled.toISOString()) : null;
                const actualLabel = actual ? dateTimeLabel(actual) : null;
                const showBoth = Boolean(scheduledLabel && actualLabel && scheduledLabel !== actualLabel);
                return <Stack key={label} direction="row" alignItems="center" spacing={1} sx={{ py: 0.75, borderTop: "1px solid #e3ebe6" }}>
                  <Typography variant="body2" fontWeight={700} sx={{ width: 78, flexShrink: 0 }}>{label}</Typography>
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                    {showBoth ? <><Box component="span" color="text.secondary" fontWeight={550}>{scheduledLabel}</Box><Box component="span" color="text.disabled" sx={{ mx: 0.5 }}>/</Box><Box component="span" color="success.dark" fontWeight={750}>{actualLabel}</Box></> : <Box component="span" color={actualLabel ? "success.dark" : "text.secondary"} fontWeight={actualLabel ? 750 : 600}>{actualLabel || scheduledLabel || "Time unavailable"}</Box>}
                  </Typography>
                  {submission?.status === "synced" ? <Chip size="small" icon={<TaskAltRoundedIcon sx={{ fontSize: "15px !important" }} />} label="Synced" color="success" variant="outlined" sx={{ height: 22, fontSize: 10, fontWeight: 700, "& .MuiChip-label": { px: 0.75 } }} /> : submission ? <StatusChip compact status={submission.status === "awaiting_api_specification" ? "pending" : submission.status} /> : <Chip size="small" label="Not synced" variant="outlined" sx={{ height: 22, fontSize: 10, color: "text.secondary", "& .MuiChip-label": { px: 0.75 } }} />}
                </Stack>;
              })}
            </Card>

            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1.5 }}>Patient and care details</Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
                <Detail label="Patient" value={selectedSchedule.patient.name} />
                <Detail label="Patient ID" value={selectedSchedule.patient.id} />
                <Detail label="Patient UHID" value={selectedSchedule.patient.uhid} />
                <Detail label="Service" value={selectedSchedule.service} />
                <Detail label="Care plan" value={selectedSchedule.carePlan} />
                <Detail label="Branch" value={selectedSchedule.branch} />
                <Detail label="Vendor" value={selectedSchedule.vendorCompany} />
                <Detail label="Care Manager" value={selectedSchedule.careManager.name} />
                <Detail label="Schedule imported" value={selectedSchedule.lastSyncedAt ? dateTimeLabel(selectedSchedule.lastSyncedAt) : "Timestamp unavailable"} />
              </Box>
            </Card>


            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1.5 }}>
                <Box><Typography variant="subtitle2" fontWeight={750}>Assigned caregivers</Typography><Typography variant="caption" color="text.secondary">{selectedSchedule.caregivers.length} assigned</Typography></Box>
              </Stack>
              {selectedSchedule.caregivers.length ? <Stack spacing={1}>
                {selectedSchedule.caregivers.map((caregiver) => <Card key={`${caregiver.id}:${caregiver.phone}`} variant="outlined" sx={{ p: 1.5, boxShadow: "none", bgcolor: "#fff" }}>
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} justifyContent="space-between">
                    <Box><Typography fontWeight={700}>{caregiver.name || "Caregiver"}</Typography><Typography variant="body2" color="text.secondary">{caregiver.id ? `ID ${caregiver.id} · ` : ""}{caregiver.phone || "Phone unavailable"}</Typography></Box>
                    <StatusChip status={caregiver.status || "pending"} />
                  </Stack>
                </Card>)}
              </Stack> : <Alert severity="info">No caregivers are listed on this schedule.</Alert>}
            </Card>

            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Box sx={{ mb: 1.5 }}>
                <Typography variant="subtitle1" fontWeight={800}>Call and retry history</Typography>
                <Typography variant="caption" color="text.secondary">Expand a stage, then open a call to review its transcript and recording.</Typography>
              </Box>
              {scheduleAttendance.isLoading && <LinearProgress sx={{ mb: 1.5 }} />}
              {scheduleAttendance.isError && <Alert severity="error" sx={{ mb: 1.5 }}>Could not load this schedule’s call history.</Alert>}
              {scheduleAttendance.isSuccess && scheduleSessions.length === 0 && <Alert severity="info">No attendance call sessions are linked to this schedule yet.</Alert>}
              {scheduleSessions.map((record, index) => {
                const query = conversationQueries[index];
                const artifacts = query?.data;
                return <Box key={record.sessionId} sx={{ mt: index ? 2 : 0, pt: index ? 2 : 0, borderTop: index ? "1px solid" : undefined, borderColor: "divider" }}>
                  <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="space-between" spacing={0.5} sx={{ mb: 1 }}>
                    <Box><Typography variant="body2" fontWeight={750}>{record.employee.name || "Caregiver"}</Typography><Typography variant="caption" color="text.secondary">Call session</Typography></Box>
                    <StatusChip compact status={record.sessionStatus} />
                  </Stack>
                  {query?.isLoading && <LinearProgress sx={{ mb: 1.25 }} />}
                  {query?.isError && <Alert severity="error" sx={{ mb: 1.25 }}>Could not load this session’s call details.</Alert>}
                  {artifacts && <Stack spacing={1}>
                    {(["check_in", "check_out"] as const).map((stage) => {
                      const attempts = artifacts.callAttempts.filter((attempt) => attempt.stage === stage).sort((a, b) => a.attemptNumber - b.attemptNumber);
                      const latestAttempt = attempts.at(-1);
                      const stageAttendance = stage === "check_in" ? record.checkIn : record.checkOut;
                      const stageLabel = stage === "check_in" ? "Check-in" : "Check-out";
                      return <Accordion key={stage} disableGutters elevation={0} sx={{ border: "1px solid #e3e9e6", borderRadius: "12px !important", boxShadow: "none", "&:before": { display: "none" }, "&.Mui-expanded": { my: 0 } }}>
                        <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ px: 1.5, minHeight: 58, "&.Mui-expanded": { minHeight: 58 }, "& .MuiAccordionSummary-content": { my: 1, minWidth: 0 }, "& .MuiAccordionSummary-content.Mui-expanded": { my: 1 } }}>
                          <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.5, sm: 1.25 }} alignItems={{ sm: "center" }} justifyContent="space-between" sx={{ width: "100%", minWidth: 0, pr: 1 }}>
                            <Box sx={{ minWidth: 0 }}>
                              <Typography variant="body2" fontWeight={750}>{stageLabel} calls</Typography>
                              <Typography variant="caption" color="text.secondary">{attempts.length} {attempts.length === 1 ? "attempt" : "attempts"}{latestAttempt?.scheduledAt ? ` · Latest ${dateTimeLabel(latestAttempt.scheduledAt)}` : ""}</Typography>
                            </Box>
                            <Stack direction="row" spacing={0.75} alignItems="center" flexShrink={0}>
                              <StatusChip compact status={latestAttempt?.status || stageAttendance.status} />
                              {stageAttendance.nextCallAt && <Chip size="small" variant="outlined" color="warning" label={`${stageAttendance.status === "escalated" ? "Care manager" : "Next retry"} · ${compactScheduleTime(stageAttendance.nextCallAt, selectedSchedule.date)}`} />}
                            </Stack>
                          </Stack>
                        </AccordionSummary>
                        <AccordionDetails sx={{ px: 1.5, pt: 0, pb: 1.5 }}>
                          {attempts.length === 0 ? <Typography variant="body2" color="text.secondary">No calls have been placed for this stage.</Typography> : <Stack spacing={1}>
                            {attempts.map((attempt) => {
                              const transcript = artifacts.transcripts.find((item) => item.callAttemptId === attempt.id);
                              const transcriptSummary = typeof attempt.outcome?.transcript_summary === "string"
                                ? attempt.outcome.transcript_summary
                                : typeof attempt.outcome?.transcriptSummary === "string"
                                  ? attempt.outcome.transcriptSummary
                                  : null;
                              return <Accordion key={attempt.id} disableGutters elevation={0} sx={{ border: "1px solid #e8edeb", borderRadius: "10px !important", boxShadow: "none", bgcolor: "#fff", "&:before": { display: "none" }, "&.Mui-expanded": { my: 0 } }}>
                                <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ px: 1.25, minHeight: 54, "&.Mui-expanded": { minHeight: 54 }, "& .MuiAccordionSummary-content": { my: 0.75, minWidth: 0 }, "& .MuiAccordionSummary-content.Mui-expanded": { my: 0.75 } }}>
                                  <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.5, sm: 1 }} alignItems={{ sm: "center" }} justifyContent="space-between" sx={{ width: "100%", minWidth: 0, pr: 1 }}>
                                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, flexWrap: "wrap" }}>
                                      <Chip size="small" label={attempt.attemptNumber === 1 ? "Initial call" : `Retry ${attempt.attemptNumber - 1}`} color={attempt.attemptNumber === 1 ? "default" : "warning"} variant={attempt.attemptNumber === 1 ? "outlined" : "filled"} />
                                      <Typography variant="body2" fontWeight={700}>{attempt.callTargetRole === "care_manager" ? "Care manager" : "Caregiver"}</Typography>
                                      <Typography variant="caption" color="text.secondary">{attempt.scheduledAt ? dateTimeLabel(attempt.scheduledAt) : "Call time unavailable"}</Typography>
                                    </Stack>
                                    <Stack direction="row" spacing={0.75} alignItems="center" flexShrink={0}><StatusChip compact status={attempt.status} />{attempt.durationSeconds != null && <Typography variant="caption" color="text.secondary" fontWeight={650}>{attempt.durationSeconds}s</Typography>}</Stack>
                                  </Stack>
                                </AccordionSummary>
                                <AccordionDetails sx={{ px: 1.25, pt: 0, pb: 1.5 }}>
                                  <Stack spacing={1.25}>
                                    <Typography variant="caption" color="text.secondary">
                                      {attempt.answeredAt ? `Answered ${dateTimeLabel(attempt.answeredAt)}` : "Not answered"}{attempt.endedAt ? ` · ended ${dateTimeLabel(attempt.endedAt)}` : ""}
                                    </Typography>
                                    {attempt.failure && <Alert severity={attempt.failure.retryable ? "warning" : "error"} variant="outlined">
                                      Chiefvoice {attempt.failure.stage === "post_call" ? "post-call processing" : "call"} failed: {attempt.failure.code.replace(/[_.-]+/g, " ")}. {attempt.failure.retryable ? "A retry is allowed." : "This failure is not retryable."}
                                    </Alert>}
                                    {transcriptSummary && <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: "#f6f8f7" }}>
                                      <Typography variant="overline" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.4, fontWeight: 750 }}>CALL SUMMARY</Typography>
                                      <Typography variant="body2" fontWeight={550} sx={{ mt: 0.35, overflowWrap: "anywhere" }}>{transcriptSummary}</Typography>
                                    </Box>}
                                    <Accordion disableGutters elevation={0} sx={{ border: "1px solid #e5ebe8", borderRadius: "10px !important", boxShadow: "none", "&:before": { display: "none" }, "&.Mui-expanded": { my: 0 } }}>
                                      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ px: 1.25, minHeight: 46, "&.Mui-expanded": { minHeight: 46 }, "& .MuiAccordionSummary-content": { my: 0.75 }, "& .MuiAccordionSummary-content.Mui-expanded": { my: 0.75 } }}>
                                        <Stack direction="row" spacing={0.75} alignItems="center"><Typography variant="body2" fontWeight={700}>Transcript</Typography>{transcript?.language && <Chip size="small" label={transcript.language.toUpperCase()} variant="outlined" />}</Stack>
                                      </AccordionSummary>
                                      <AccordionDetails sx={{ px: 1.5, pt: 0, pb: 1.5 }}>
                                        {transcript?.text ? <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6 }}>{transcript.text}</Typography> : <Typography variant="body2" color="text.secondary">Transcript not available yet.</Typography>}
                                      </AccordionDetails>
                                    </Accordion>
                                    <Box sx={{ pt: 0.5 }}>
                                      {attempt.recordingAvailable ? <CallRecording sessionId={record.sessionId} attemptId={attempt.id} /> : <Typography variant="caption" color="text.secondary">Recording not available yet.</Typography>}
                                    </Box>
                                  </Stack>
                                </AccordionDetails>
                              </Accordion>;
                            })}
                          </Stack>}
                        </AccordionDetails>
                      </Accordion>;
                    })}
                  </Stack>}
                </Box>;
              })}
            </Card>

            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1.5 }}>Schedule reference</Typography>
              <Detail label="Schedule ID" value={selectedSchedule.athulyaScheduleId || selectedSchedule.athulyaSchedulePk} />
            </Card>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.75 }}><Button onClick={() => setSelectedSchedule(null)} variant="contained">Close</Button></DialogActions>
      </>}
    </Dialog>
  </Stack>;
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return <Stack spacing={0.35} sx={{ minWidth: 0 }}><Typography variant="caption" color="text.secondary" fontWeight={600}>{label}</Typography><Typography variant="body2" fontWeight={600} sx={{ overflowWrap: "anywhere" }}>{value || "—"}</Typography></Stack>;
}
