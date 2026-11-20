import { useEffect, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink } from "react-router-dom";
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, Grid, InputLabel, LinearProgress, MenuItem, Select, Stack, Table, TableBody, TableCell, TableHead, TablePagination, TableRow, TextField, Typography } from "@mui/material";
import EventAvailableRoundedIcon from "@mui/icons-material/EventAvailableRounded";
import PendingActionsRoundedIcon from "@mui/icons-material/PendingActionsRounded";
import TaskAltRoundedIcon from "@mui/icons-material/TaskAltRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import { fetchAttendance, fetchAthulyaAttendanceSubmissions, fetchAthulyaIntegration, fetchAthulyaSchedules, fetchAthulyaSyncRuns, fetchMockPlatformServerSettings, fetchSessionArtifacts, startAthulyaSync, type AttendanceRecord, type AthulyaAttendanceSubmission, type AthulyaSchedule } from "../api/client";
import { MetricCard, PageHeader, StatusChip, OperationsTable } from "../components/OperationsUI";
import { CallRecording } from "../components/CallRecording";
import { SortByMenu } from "../components/SortByMenu";
import { formatAppDateTime } from "../utils/dateTime";

type ScheduleSort =
  | "current_upcoming"
  | "check_in_ascending" | "check_in_descending"
  | "check_out_ascending" | "check_out_descending"
  | "schedule_time_ascending" | "schedule_time_descending"
  | "status_ascending" | "status_descending"
  | "patient_ascending" | "patient_descending"
  | "caregivers_ascending" | "caregivers_descending"
  | "service_ascending" | "service_descending";
const scheduleSortOptions = [
  { value: "current_upcoming", label: "Current & upcoming first" },
  { value: "check_in_ascending", label: "Check-in: earliest first" },
  { value: "check_in_descending", label: "Check-in: latest first" },
  { value: "check_out_ascending", label: "Check-out: earliest first" },
  { value: "check_out_descending", label: "Check-out: latest first" },
  { value: "schedule_time_ascending", label: "Schedule time: earliest first" },
  { value: "schedule_time_descending", label: "Schedule time: latest first" },
  { value: "status_ascending", label: "Status: A to Z" },
  { value: "status_descending", label: "Status: Z to A" },
  { value: "patient_ascending", label: "Patient: A to Z" },
  { value: "patient_descending", label: "Patient: Z to A" },
  { value: "caregivers_ascending", label: "Care givers: A to Z" },
  { value: "caregivers_descending", label: "Care givers: Z to A" },
  { value: "service_ascending", label: "Service: A to Z" },
  { value: "service_descending", label: "Service: Z to A" },
] as const;

const settingError = (error: unknown) => error instanceof Error ? error.message : "Request failed";

function todayInIndia() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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

function SubmissionStatusCell({ event }: { event?: AthulyaAttendanceSubmission }) {
  if (!event) return <Stack spacing={0.25}><StatusChip compact status="not submitted" /><Typography variant="caption" color="text.secondary">No event record</Typography></Stack>;
  const error = event.errorMessage;
  return <Stack spacing={0.25} sx={{ minWidth: 112 }}>
    <StatusChip compact status={event.status === "awaiting_api_specification" ? "pending" : event.status} />
    <Typography variant="caption" color={error ? "error.main" : "text.secondary"} sx={{ maxWidth: 220, overflowWrap: "anywhere" }}>
      {error || `${event.retryCount} ${event.retryCount === 1 ? "attempt" : "attempts"}`}
    </Typography>
  </Stack>;
}

function compactScheduleTime(value: string, scheduleDate: string | null | undefined) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (dateKey === scheduleDate) return scheduleClock(value);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function localStageHint(records: AttendanceRecord[], stage: "checkIn" | "checkOut", scheduleDate: string | null | undefined) {
  const candidates = records.map((record) => ({ record, value: record[stage], reason: record.stageReasons[stage] }));
  const priority = (status: string) => status === "calling" || status === "processing" ? 4 : ["retry", "follow_up"].includes(status) ? 3 : status === "escalated" ? 2 : status === "unresolved" ? 1 : 0;
  const current = candidates.sort((left, right) => priority(right.value.status) - priority(left.value.status))[0];
  if (!current) return null;
  if (current.value.status === "calling") return "Calling now";
  if (current.value.status === "processing") return "Processing call";
  if (current.value.status === "retry" || (current.value.status === "follow_up" && current.reason !== "employee_requested_callback")) {
    return current.value.nextCallAt ? `Retry · ${compactScheduleTime(current.value.nextCallAt, scheduleDate)}` : "Retry scheduled";
  }
  if (current.value.status === "follow_up") {
    return current.value.nextCallAt ? `Callback · ${compactScheduleTime(current.value.nextCallAt, scheduleDate)}` : "Callback requested";
  }
  if (current.value.status === "escalated") {
    return current.value.nextCallAt ? `Care manager · ${compactScheduleTime(current.value.nextCallAt, scheduleDate)}` : "Care manager follow-up";
  }
  if (current.value.status === "unresolved") return "Manual follow-up needed";
  return null;
}

function ScheduleAttendanceCell({ event, localRecords, stage, scheduledTime, scheduleDate }: { event?: AthulyaAttendanceSubmission; localRecords: AttendanceRecord[]; stage: "checkIn" | "checkOut"; scheduledTime: string | null | undefined; scheduleDate: string | null | undefined }) {
  const localTimestamp = localRecords.find((record) => record[stage].status === "confirmed")?.[stage].reportedAt;
  const callHint = localStageHint(localRecords, stage, scheduleDate);
  return <Stack spacing={0.45} alignItems="flex-start">
    <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
      {event ? dateTimeLabel(event.eventAt) : localTimestamp ? dateTimeLabel(localTimestamp) : `Scheduled ${scheduleClock(scheduledTime)}`}
    </Typography>
    {callHint && <Typography variant="caption" color={callHint.startsWith("Follow-up") ? "error.main" : "text.secondary"} sx={{ lineHeight: 1.2, whiteSpace: "nowrap" }}>{callHint}</Typography>}
    <SubmissionStatusCell event={event} />
  </Stack>;
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

function scheduleDateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  }).format(date);
}

function dateTimeLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
  }).format(date);
}

export function AttendanceSchedulesPage({ userRole = "admin" }: { userRole?: "admin" | "care_manager" }) {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selectedDate, setSelectedDate] = useState(todayInIndia);
  const [sortBy, setSortBy] = useState<ScheduleSort>("current_upcoming");
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState("all");
  const [caregiverFilter, setCaregiverFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [syncScope, setSyncScope] = useState<"all" | "branch" | "care_manager">("all");
  const [syncScopeId, setSyncScopeId] = useState("");
  const [submissionFilters, setSubmissionFilters] = useState({ eventType: "all", status: "all", scheduleId: "" });
  const [selectedSchedule, setSelectedSchedule] = useState<AthulyaSchedule | null>(null);
  const queryClient = useQueryClient();
  const isAdmin = userRole === "admin";
  const schedules = useQuery({
    queryKey: ["athulya-schedules", selectedDate],
    queryFn: () => fetchAthulyaSchedules({ fromDate: selectedDate, toDate: selectedDate }),
    refetchInterval: 30_000,
  });
  const integration = useQuery({ queryKey: ["athulya-integration"], queryFn: fetchAthulyaIntegration, enabled: isAdmin, retry: false });
  const mockPlatform = useQuery({ queryKey: ["mock-platform-server"], queryFn: fetchMockPlatformServerSettings, enabled: isAdmin, retry: false });
  const syncRuns = useQuery({ queryKey: ["athulya-sync-runs"], queryFn: fetchAthulyaSyncRuns, enabled: isAdmin, refetchInterval: isAdmin ? 5000 : false, retry: false });
  const submissionQuery = useQuery({
    queryKey: ["athulya-attendance-submissions", selectedDate],
    queryFn: () => fetchAthulyaAttendanceSubmissions({ ...serviceDateBounds(selectedDate), limit: 500 }),
    enabled: isAdmin,
    refetchInterval: isAdmin ? 15_000 : false,
    retry: false,
  });
  const syncMutation = useMutation({
    mutationFn: startAthulyaSync,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["athulya-sync-runs"] }),
        queryClient.invalidateQueries({ queryKey: ["athulya-schedules", selectedDate] }),
        queryClient.invalidateQueries({ queryKey: ["attendance", "schedule-status"] }),
      ]);
    },
  });
  const attendance = useQuery({
    queryKey: ["attendance", "schedule-status"],
    queryFn: () => fetchAttendance({ limit: 500 }),
    refetchInterval: 15_000,
  });
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
  const syncRunRows = syncRuns.data || [];
  const isMockMode = mockPlatform.data?.enabled === true;
  const syncAvailable = integration.data?.enabled === true || isMockMode;
  const selectedDateRun = syncRunRows.find((run) => run.status === "running" && run.fromDate === selectedDate);
  const anySyncRunning = syncRunRows.some((run) => run.status === "running");
  const syncRunning = syncMutation.isPending || anySyncRunning;
  const lastSuccessfulRun = syncRunRows.find((run) => run.status === "succeeded" && run.fromDate === selectedDate);
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
  const statusPriority: Record<AttendanceStatus, number> = { in_progress: 0, upcoming: 1, retry: 2, retry_scheduled: 2, delayed: 2, escalated: 3, attention_required: 4, unresolved: 5, completed: 6, cancelled: 7 };
  const branchOptions = [...new Set(schedulesData.map((schedule) => schedule.branch).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const caregiverOptions = [...new Map(schedulesData.flatMap((schedule) => schedule.caregivers.map((caregiver) => [caregiver.id || caregiver.name, caregiver] as const))).values()];
  const enrichedSchedules = schedulesData.map((schedule) => {
    const localTasks = matchingAttendance(schedule, attendanceData);
    const events = scheduleSubmissionEvents(schedule, submissionEvents);
    return { schedule, localTasks, events, status: unifiedAttendanceStatus(schedule, localTasks) };
  });
  const filteredSchedules = enrichedSchedules.filter(({ schedule, status }) => {
    const query = search.trim().toLowerCase();
    const searchMatch = !query || [schedule.athulyaScheduleId, schedule.athulyaSchedulePk, schedule.patient.name, schedule.patient.uhid, ...schedule.caregivers.map((caregiver) => `${caregiver.name} ${caregiver.id}`)].some((value) => String(value || "").toLowerCase().includes(query));
    const statusMatch = statusFilter === "all" || status === statusFilter;
    const branchMatch = branchFilter === "all" || schedule.branch === branchFilter;
    const caregiverMatch = caregiverFilter === "all" || schedule.caregivers.some((caregiver) => caregiver.id === caregiverFilter || caregiver.name === caregiverFilter);
    return searchMatch && statusMatch && branchMatch && caregiverMatch;
  });
  const sortedSchedules = [...filteredSchedules].sort((left, right) => {
    const a = left.schedule;
    const b = right.schedule;
    const startA = scheduledInstant(a.date, a.startTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const startB = scheduledInstant(b.date, b.startTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const endA = scheduledInstant(a.date, a.endTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const endB = scheduledInstant(b.date, b.endTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (sortBy === "current_upcoming") {
      const rank = statusPriority[statusesBySchedule.get(a.id) || "upcoming"] - statusPriority[statusesBySchedule.get(b.id) || "upcoming"];
      return rank || startA - startB;
    }
    const descending = sortBy.endsWith("descending");
    let comparison = 0;
    if (sortBy.startsWith("schedule_time_")) comparison = startA - startB;
    else if (sortBy.startsWith("check_in_")) comparison = startA - startB;
    else if (sortBy.startsWith("check_out_")) comparison = endA - endB;
    else {
      const valueFor = (schedule: AthulyaSchedule) => {
        if (sortBy.startsWith("status_")) return statusesBySchedule.get(schedule.id) || "upcoming";
        if (sortBy.startsWith("patient_")) return schedule.patient.name || "";
        if (sortBy.startsWith("caregivers_")) return schedule.caregivers.map((caregiver) => caregiver.name || caregiver.phone || "").join(", ");
        return schedule.service || "";
      };
      comparison = valueFor(a).localeCompare(valueFor(b), undefined, { sensitivity: "base", numeric: true });
    }
    return descending ? -comparison : comparison;
  });
  useEffect(() => setPage(0), [selectedDate, sortBy, statusFilter, branchFilter, caregiverFilter, search, submissionFilters.scheduleId, schedulesData.length]);
  const pageRows = sortedSchedules.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const completedSchedules = enrichedSchedules.filter(({ status }) => status === "completed").length;
  const pendingAttendance = enrichedSchedules.filter(({ status }) => !["completed", "cancelled"].includes(status)).length;
  const submissionFailures = submissionEvents.filter((event) => event.status === "failed").length;
  const filteredSubmissionEvents = submissionEvents.filter((event) =>
    (submissionFilters.eventType === "all" || event.eventType === submissionFilters.eventType)
    && (submissionFilters.status === "all" || event.status === submissionFilters.status)
    && (!submissionFilters.scheduleId || String(event.scheduleId || "").toLowerCase().includes(submissionFilters.scheduleId.toLowerCase())));
  const syncSelectedDate = () => syncMutation.mutate({
    scheduleDate: selectedDate,
    careManagerId: syncScope === "care_manager" ? syncScopeId.trim() : undefined,
    branchId: syncScope === "branch" ? syncScopeId.trim() : undefined,
  });
  const dateLabel = selectedDate
    ? new Date(`${selectedDate}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })
    : "Choose a date";

  const selectedScheduleEvents = selectedSchedule ? scheduleSubmissionEvents(selectedSchedule, submissionEvents) : [];
  const selectedCheckInSubmission = latestStageSubmission(selectedScheduleEvents, "check_in");
  const selectedCheckOutSubmission = latestStageSubmission(selectedScheduleEvents, "check_out");
  const latestSelectedDateRun = syncRunRows.find((run) => run.fromDate === selectedDate);

  return <Stack spacing={{ xs: 1.5, md: 1.75 }} sx={{ height: { xs: "auto", md: "calc(100dvh - 152px)" }, minHeight: { xs: 0, md: 440 }, pb: { xs: 1, md: 0 } }}>
    <PageHeader eyebrow="WORKFORCE INTELLIGENCE / ATTENDANCE OPERATIONS" title="Schedule & Attendance" />
    <Card variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, borderColor: "#e2e9e6", boxShadow: "none" }}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: "column", lg: "row" }} spacing={1.5} alignItems={{ xs: "stretch", lg: "center" }} justifyContent="space-between">
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} alignItems={{ xs: "stretch", sm: "center" }}>
            <TextField type="date" size="small" required label="Service date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value || todayInIndia())} InputLabelProps={{ shrink: true }} sx={{ minWidth: { sm: 190 } }} />
            <Button size="small" onClick={() => setSelectedDate(todayInIndia())} disabled={selectedDate === todayInIndia()}>Today</Button>
            <Chip size="small" label="Asia/Kolkata · midnight to midnight" variant="outlined" />
          </Stack>
          {isAdmin && <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ xs: "stretch", sm: "center" }}>
            <FormControl size="small" sx={{ minWidth: 150 }}><InputLabel>Sync scope</InputLabel><Select label="Sync scope" value={syncScope} onChange={(event) => { setSyncScope(event.target.value as typeof syncScope); setSyncScopeId(""); }}><MenuItem value="all">Everyone</MenuItem><MenuItem value="branch">One branch</MenuItem><MenuItem value="care_manager">One Care Manager</MenuItem></Select></FormControl>
            {syncScope !== "all" && <TextField size="small" label={syncScope === "branch" ? "Branch ID" : "Care Manager ID"} value={syncScopeId} onChange={(event) => setSyncScopeId(event.target.value)} sx={{ minWidth: 180 }} />}
            <Button variant="contained" startIcon={<SyncRoundedIcon />} disabled={!syncAvailable || !selectedDate || syncRunning || (syncScope !== "all" && !syncScopeId.trim())} onClick={syncSelectedDate}>
              {syncRunning ? "Sync running…" : "Sync schedules"}
            </Button>
          </Stack>}
        </Stack>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" color="text.secondary">Sync status</Typography>
            {isAdmin ? <StatusChip compact status={selectedDateRun?.status || latestSelectedDateRun?.status || "not synced"} /> : <Typography variant="caption" color="text.secondary">Admin sync controls</Typography>}
            {isAdmin && <Typography variant="caption" color="text.secondary">Last successful sync: {lastSuccessfulRun?.completedAt ? formatAppDateTime(lastSuccessfulRun.completedAt) : "No successful sync recorded"}</Typography>}
          </Stack>
          {isAdmin && !syncAvailable && !integration.isLoading && !mockPlatform.isLoading && <Button size="small" component={RouterLink} to="/settings/athulya">Configure Athulya integration</Button>}
        </Stack>
        {schedules.isError && <Alert severity="error">Schedule list could not be loaded. Check the selected date and your organization access.</Alert>}
        {isAdmin && (syncMutation.isError || integration.isError || mockPlatform.isError) && <Alert severity="error">{syncMutation.isError ? `Schedule sync could not be started: ${settingError(syncMutation.error)}` : "Athulya sync availability could not be checked."}</Alert>}
        {syncMutation.isSuccess && <Alert severity="success">Sync queued for {syncMutation.data.scheduleDate}. The selected date’s schedule list and sync status will refresh automatically.</Alert>}
        {submissionQuery.isError && isAdmin && <Alert severity="warning">Athulya attendance submission details could not be loaded; schedules and local attendance remain available.</Alert>}
      </Stack>
    </Card>

    <Grid container spacing={1.5}>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard compact label="Imported schedules" value={schedules.isLoading ? "—" : schedulesData.length.toLocaleString()} detail="For the selected service date" icon={<EventAvailableRoundedIcon />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard compact label="Pending attendance" value={schedules.isLoading || attendance.isLoading ? "—" : pendingAttendance.toLocaleString()} detail="Excludes completed and cancelled duties" icon={<PendingActionsRoundedIcon />} tint="#fff3df" accent="#b8751a" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard compact label="Completed schedules" value={schedules.isLoading || attendance.isLoading ? "—" : completedSchedules.toLocaleString()} detail="Both local attendance stages confirmed" icon={<TaskAltRoundedIcon />} tint="#e5f5ee" accent="#178264" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><MetricCard compact label="Submission failures" value={!isAdmin || submissionQuery.isLoading ? "—" : submissionFailures.toLocaleString()} detail="Failed Athulya events for selected date" icon={<PendingActionsRoundedIcon />} tint="#fff0ed" accent="#c44747" /></Grid>
    </Grid>

    <Card sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: { xs: 400, md: 0 }, overflow: "hidden" }}>
      {schedules.isLoading && <LinearProgress />}
      {attendance.isError && <Alert severity="warning" sx={{ m: 1.5 }}>Local attendance call status could not be loaded.</Alert>}
      <Stack direction={{ xs: "column", lg: "row" }} spacing={1} alignItems={{ xs: "stretch", lg: "center" }} sx={{ p: { xs: 1.25, sm: 1.75 }, borderBottom: "1px solid #e8edf3", flexShrink: 0 }}>
        <TextField size="small" placeholder="Search patient, UHID, caregiver, schedule ID" value={search} onChange={(event) => setSearch(event.target.value)} InputProps={{ startAdornment: <SearchRoundedIcon fontSize="small" color="action" sx={{ mr: 1 }} /> }} sx={{ flex: 1, minWidth: 220 }} />
        <FormControl size="small" sx={{ minWidth: 140 }}><InputLabel>Attendance</InputLabel><Select label="Attendance" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><MenuItem value="all">All statuses</MenuItem>{["upcoming", "pending check-in", "checked in", "missing check-out", "completed", "cancelled"].map((value) => <MenuItem key={value} value={value} sx={{ textTransform: "capitalize" }}>{value}</MenuItem>)}</Select></FormControl>
        <FormControl size="small" sx={{ minWidth: 140 }}><InputLabel>Branch</InputLabel><Select label="Branch" value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)}><MenuItem value="all">All branches</MenuItem>{branchOptions.map((branch) => <MenuItem key={branch} value={branch}>{branch}</MenuItem>)}</Select></FormControl>
        <FormControl size="small" sx={{ minWidth: 160 }}><InputLabel>Caregiver</InputLabel><Select label="Caregiver" value={caregiverFilter} onChange={(event) => setCaregiverFilter(event.target.value)}><MenuItem value="all">All caregivers</MenuItem>{caregiverOptions.map((caregiver) => <MenuItem key={caregiver.id || caregiver.name} value={caregiver.id || caregiver.name}>{caregiver.name || caregiver.id}</MenuItem>)}</Select></FormControl>
        <SortByMenu value={sortBy} options={scheduleSortOptions} onChange={setSortBy} />
      </Stack>
      <OperationsTable sx={{ flex: 1, minHeight: { xs: 250, md: 0 }, maxHeight: { xs: "55dvh", md: "none" }, overflow: "auto" }}>
        <Table size="small" sx={{ minWidth: 1220 }} aria-label="Schedule and attendance management">
          <TableHead><TableRow>{["Schedule ID", "Patient", "Caregiver", "Branch", "Schedule time", "Check-in", "Check-out", "Attendance status", "Details"].map((label) => <TableCell key={label} sx={{ fontWeight: 700, whiteSpace: "nowrap", bgcolor: "#f7f9fc" }}>{label}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {pageRows.map(({ schedule, localTasks, events, status }) => <TableRow key={schedule.id} hover>
              <TableCell><Typography variant="body2" fontWeight={650}>{schedule.athulyaScheduleId || schedule.athulyaSchedulePk}</Typography></TableCell>
              <TableCell><Typography variant="body2" fontWeight={650}>{schedule.patient.name || "—"}</Typography><Typography variant="caption" color="text.secondary">UHID {schedule.patient.uhid || "—"}</Typography></TableCell>
              <TableCell>{schedule.caregivers.map((caregiver) => caregiver.name || caregiver.id).join(", ") || "—"}</TableCell>
              <TableCell>{schedule.branch || "—"}</TableCell>
              <TableCell sx={{ whiteSpace: "nowrap" }}>{scheduleClock(schedule.startTime)} – {scheduleClock(schedule.endTime)}<Typography variant="caption" display="block" color="text.secondary">{scheduleDateLabel(schedule.date)}</Typography></TableCell>
              <TableCell><ScheduleAttendanceCell event={latestStageSubmission(events, "check_in")} localRecords={localTasks} stage="checkIn" scheduledTime={schedule.startTime} scheduleDate={schedule.date} /></TableCell>
              <TableCell><ScheduleAttendanceCell event={latestStageSubmission(events, "check_out")} localRecords={localTasks} stage="checkOut" scheduledTime={schedule.endTime} scheduleDate={schedule.date} /></TableCell>
              <TableCell><StatusChip compact status={status} /></TableCell>
              <TableCell><Button size="small" onClick={() => setSelectedSchedule(schedule)}>View details</Button></TableCell>
            </TableRow>)}
            {schedules.isSuccess && pageRows.length === 0 && <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5 }}>{schedulesData.length === 0 ? `No schedules found for ${dateLabel}. Choose another date or sync this service date.` : "No schedules match the current search and filters."}</TableCell></TableRow>}
          </TableBody>
        </Table>
      </OperationsTable>
      <TablePagination component="div" count={sortedSchedules.length} page={page} onPageChange={(_, nextPage) => setPage(nextPage)} rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50, 100]} labelRowsPerPage="Schedules per page" />
    </Card>

    {isAdmin && <Accordion disableGutters sx={{ border: "1px solid #e2e9e6", borderRadius: "14px !important", boxShadow: "none", "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />}><Box><Typography fontWeight={700}>Schedule Sync History</Typography><Typography variant="caption" color="text.secondary">Recent manual and automatic imports for the organization.</Typography></Box></AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        {syncRuns.isError && <Alert severity="error" sx={{ mb: 1.5 }}>Could not load schedule sync history.</Alert>}
        {syncRuns.isLoading ? <LinearProgress /> : <OperationsTable sx={{ maxHeight: 360 }}><Table size="small" stickyHeader><TableHead><TableRow>{["Started", "Type", "Scope", "Schedule date", "Status", "Received", "Saved", "Error"].map((label) => <TableCell key={label} sx={{ fontWeight: 700 }}>{label}</TableCell>)}</TableRow></TableHead><TableBody>
          {syncRunRows.map((run) => <TableRow key={run.id}><TableCell>{formatAppDateTime(run.startedAt)}</TableCell><TableCell>{run.syncSource === "automatic" ? "Automatic" : "Manual"}</TableCell><TableCell>{run.syncScope === "branch" ? `Branch ${run.syncScopeId}` : run.syncScope === "care_manager" ? `Care Manager ${run.syncScopeId}` : "Everyone"}</TableCell><TableCell>{run.fromDate && run.fromDate === run.toDate ? run.fromDate : `${run.fromDate || "—"} – ${run.toDate || "—"}`}</TableCell><TableCell><StatusChip compact status={run.status} /></TableCell><TableCell>{run.recordsReceived}</TableCell><TableCell>{run.recordsUpserted}</TableCell><TableCell>{run.errorMessage || "—"}</TableCell></TableRow>)}
          {syncRuns.isSuccess && syncRunRows.length === 0 && <TableRow><TableCell colSpan={8} align="center">No schedule sync history yet.</TableCell></TableRow>}
        </TableBody></Table></OperationsTable>}
      </AccordionDetails>
    </Accordion>}

    {isAdmin && <Accordion disableGutters sx={{ border: "1px solid #e2e9e6", borderRadius: "14px !important", boxShadow: "none", "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />}><Box><Typography fontWeight={700}>Attendance Submission History</Typography><Typography variant="caption" color="text.secondary">Athulya check-in and check-out events for the selected service date.</Typography></Box></AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 1.5 }}>
          <FormControl size="small" sx={{ minWidth: 145 }}><InputLabel>Event</InputLabel><Select label="Event" value={submissionFilters.eventType} onChange={(event) => setSubmissionFilters((current) => ({ ...current, eventType: event.target.value }))}><MenuItem value="all">All events</MenuItem><MenuItem value="check_in">Check-in</MenuItem><MenuItem value="check_out">Check-out</MenuItem></Select></FormControl>
          <FormControl size="small" sx={{ minWidth: 155 }}><InputLabel>Submission status</InputLabel><Select label="Submission status" value={submissionFilters.status} onChange={(event) => setSubmissionFilters((current) => ({ ...current, status: event.target.value }))}><MenuItem value="all">All statuses</MenuItem>{["pending", "processing", "retry_scheduled", "failed", "synced", "awaiting_api_specification"].map((value) => <MenuItem key={value} value={value} sx={{ textTransform: "capitalize" }}>{value.replaceAll("_", " ")}</MenuItem>)}</Select></FormControl>
          <TextField size="small" label="Schedule ID" value={submissionFilters.scheduleId} onChange={(event) => setSubmissionFilters((current) => ({ ...current, scheduleId: event.target.value }))} />
        </Stack>
        {submissionQuery.isError && <Alert severity="error" sx={{ mb: 1.5 }}>Could not load attendance submission history.</Alert>}
        {submissionQuery.isLoading ? <LinearProgress /> : <OperationsTable sx={{ maxHeight: 360 }}><Table size="small" stickyHeader><TableHead><TableRow>{["Event time", "Event", "Patient", "Caregiver", "Schedule ID", "Status", "Attempts", "Error"].map((label) => <TableCell key={label} sx={{ fontWeight: 700 }}>{label}</TableCell>)}</TableRow></TableHead><TableBody>
          {filteredSubmissionEvents.map((event) => <TableRow key={event.id}><TableCell>{formatAppDateTime(event.eventAt)}</TableCell><TableCell>{event.eventType === "check_in" ? "Check-in" : "Check-out"}</TableCell><TableCell>{event.patientName || event.patientId || "—"}</TableCell><TableCell>{event.caregiverName || "—"}</TableCell><TableCell>{event.scheduleId || "—"}</TableCell><TableCell><StatusChip compact status={event.status === "awaiting_api_specification" ? "pending" : event.status} /></TableCell><TableCell>{event.retryCount}</TableCell><TableCell sx={{ maxWidth: 300, whiteSpace: "normal", overflowWrap: "anywhere" }}>{event.errorMessage || "—"}</TableCell></TableRow>)}
          {submissionQuery.isSuccess && filteredSubmissionEvents.length === 0 && <TableRow><TableCell colSpan={8} align="center">No attendance submissions match these filters.</TableCell></TableRow>}
        </TableBody></Table></OperationsTable>}
        {submissionEvents.length >= 500 && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>Showing the latest 500 events returned for the selected service date.</Typography>}
      </AccordionDetails>
    </Accordion>}

    <Dialog open={Boolean(selectedSchedule)} onClose={() => setSelectedSchedule(null)} fullWidth maxWidth="md" PaperProps={{ sx: { borderRadius: 3 } }}>
      {selectedSchedule && <>
        <DialogTitle sx={{ px: { xs: 2, sm: 3 }, pt: 2.5, pb: 1.5 }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: ".08em" }}>Duty schedule</Typography>
              <Typography variant="h5" fontWeight={750} sx={{ overflowWrap: "anywhere" }}>{selectedSchedule.patient.name || "Patient schedule"}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: .35 }}>{selectedSchedule.service || "Care service"}</Typography>
            </Box>
            <StatusChip status={unifiedAttendanceStatus(selectedSchedule, scheduleSessions)} />
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, py: 2.5, bgcolor: "#fbfcfb" }}>
          <Stack spacing={2}>
            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none", borderColor: "#dfe8e3", bgcolor: "#f4f8f6" }}>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1.5 }}>Scheduled duty</Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
                <Detail label="Scheduled check-in" value={dateTimeLabel(scheduledInstant(selectedSchedule.date, selectedSchedule.startTime)?.toISOString())} />
                <Detail label="Scheduled check-out" value={dateTimeLabel(scheduledInstant(selectedSchedule.date, selectedSchedule.endTime)?.toISOString())} />
              </Box>
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
              <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} spacing={0.5} sx={{ mb: 1.5 }}>
                <Typography variant="subtitle2" fontWeight={750}>Actual attendance times</Typography>
                <Typography variant="caption" color="text.secondary">Times are shown in Asia/Kolkata</Typography>
              </Stack>
              {scheduleAttendance.isLoading && <LinearProgress sx={{ mb: 1.5 }} />}
              {scheduleAttendance.isError && <Alert severity="error" sx={{ mb: 1.5 }}>Could not load actual attendance times.</Alert>}
              {scheduleAttendance.isSuccess && scheduleSessions.length === 0 && <Alert severity="info">No actual check-in or check-out times have been recorded yet.</Alert>}
              <Stack spacing={1}>
                {scheduleSessions.map((record) => <Card key={record.sessionId} variant="outlined" sx={{ p: 1.5, boxShadow: "none", bgcolor: "#fff" }}>
                  <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }} justifyContent="space-between">
                    <Box sx={{ minWidth: { md: 150 } }}><Typography variant="body2" fontWeight={700}>{record.employee.name || "Caregiver"}</Typography><Typography variant="caption" color="text.secondary">Attendance times</Typography></Box>
                    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, minmax(110px, 1fr))" }, gap: 1.5, flex: 1 }}>
                      <Detail label="Scheduled check-in" value={dateTimeLabel(record.scheduledStartAt)} />
                      <Detail label="Actual check-in" value={record.checkIn.reportedAt ? dateTimeLabel(record.checkIn.reportedAt) : "Not recorded"} />
                      <Detail label="Scheduled check-out" value={dateTimeLabel(record.scheduledEndAt)} />
                      <Detail label="Actual check-out" value={record.checkOut.reportedAt ? dateTimeLabel(record.checkOut.reportedAt) : "Not recorded"} />
                    </Box>
                  </Stack>
                </Card>)}
              </Stack>
            </Card>

            <Card variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, boxShadow: "none" }}>
              <Typography variant="subtitle2" fontWeight={750} sx={{ mb: 1.5 }}>Athulya attendance submissions</Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
                {([
                  { title: "Check-in", event: selectedCheckInSubmission, localTime: scheduleSessions.find((record) => record.checkIn.status === "confirmed")?.checkIn.reportedAt },
                  { title: "Check-out", event: selectedCheckOutSubmission, localTime: scheduleSessions.find((record) => record.checkOut.status === "confirmed")?.checkOut.reportedAt },
                ]).map(({ title, event, localTime }) => <Box key={title} sx={{ minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={700}>{title}</Typography>
                  <Typography variant="caption" display="block" color="text.secondary" sx={{ mb: 0.6 }}>Attendance event: {event ? dateTimeLabel(event.eventAt) : localTime ? dateTimeLabel(localTime) : "Not recorded"}</Typography>
                  {event ? <Stack spacing={0.45} alignItems="flex-start"><StatusChip compact status={event.status === "awaiting_api_specification" ? "pending" : event.status} /><Typography variant="caption" color="text.secondary">{event.retryCount} {event.retryCount === 1 ? "attempt" : "attempts"}</Typography>{event.errorMessage && <Typography variant="caption" color="error.main" sx={{ overflowWrap: "anywhere" }}>{event.errorMessage}</Typography>}</Stack>
                    : <Typography variant="caption" color="text.secondary">No Athulya submission record</Typography>}
                </Box>)}
              </Box>
              <Alert severity="info" sx={{ mt: 1.5 }}>Eligible submissions retry automatically. The current API provides event time, status, attempt count, and error, but no last-attempt timestamp or manual retry action.</Alert>
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
              <Box sx={{ mb: 1.5 }}><Typography variant="subtitle2" fontWeight={750}>Call and retry history</Typography><Typography variant="caption" color="text.secondary">Each check-in and check-out call is listed separately, in attempt order.</Typography></Box>
              {scheduleAttendance.isLoading && <LinearProgress />}
              {scheduleAttendance.isError && <Alert severity="error">Could not find attendance call sessions for this schedule.</Alert>}
              {scheduleAttendance.isSuccess && scheduleSessions.length === 0 && <Alert severity="info">No attendance call sessions are linked to this schedule yet.</Alert>}
              {scheduleSessions.map((record, index) => {
                const query = conversationQueries[index];
                const artifacts = query?.data;
                return <Box key={record.sessionId} sx={{ mt: index ? 2 : 0, pt: index ? 2 : 0, borderTop: index ? "1px solid" : undefined, borderColor: "divider" }}>
                  <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="space-between" spacing={.5} sx={{ mb: 1.25 }}>
                    <Box><Typography variant="body2" fontWeight={700}>{record.employee.name || "Caregiver"}</Typography><Typography variant="caption" color="text.secondary">Attendance calls</Typography></Box>
                    <StatusChip status={record.sessionStatus} />
                  </Stack>
                  {query?.isLoading && <LinearProgress sx={{ mb: 1.25 }} />}
                  {query?.isError && <Alert severity="error" sx={{ mb: 1.25 }}>Could not load this session’s call details.</Alert>}
                  {artifacts && <Stack spacing={1.5}>
                    {(["check_in", "check_out"] as const).map((stage) => {
                      const attempts = artifacts.callAttempts.filter((attempt) => attempt.stage === stage);
                      return <Box key={stage}>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: .75 }}>
                          <Typography variant="body2" fontWeight={700}>{stage === "check_in" ? "Check-in calls" : "Check-out calls"}</Typography>
                          <Chip size="small" variant="outlined" label={`${attempts.length} ${attempts.length === 1 ? "call" : "calls"}`} />
                        </Stack>
                        {attempts.length === 0 ? <Typography variant="caption" color="text.secondary">No calls placed for this stage.</Typography> : <Stack spacing={1}>
                          {attempts.map((attempt) => {
                            const transcript = artifacts.transcripts.find((item) => item.callAttemptId === attempt.id);
                            const transcriptSummary = typeof attempt.outcome?.transcript_summary === "string"
                              ? attempt.outcome.transcript_summary
                              : typeof attempt.outcome?.transcriptSummary === "string"
                                ? attempt.outcome.transcriptSummary
                                : null;
                            return <Card key={attempt.id} variant="outlined" sx={{ p: 1.5, boxShadow: "none", bgcolor: "#fff" }}>
                              <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} spacing={.75}>
                                <Stack direction="row" spacing={0.75} alignItems="center">
                                  <Chip size="small" label={attempt.attemptNumber === 1 ? "Initial call" : `Retry ${attempt.attemptNumber - 1}`} color={attempt.attemptNumber === 1 ? "default" : "warning"} variant={attempt.attemptNumber === 1 ? "outlined" : "filled"} />
                                  <Typography variant="body2" fontWeight={700}>{attempt.callTargetRole === "care_manager" ? "Care manager" : "Caregiver"}</Typography>
                                </Stack>
                                <Stack direction="row" spacing={1} alignItems="center"><StatusChip status={attempt.status} />{attempt.durationSeconds != null && <Typography variant="caption" color="text.secondary">{attempt.durationSeconds}s</Typography>}</Stack>
                              </Stack>
                              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: .5 }}>
                                {attempt.scheduledAt ? dateTimeLabel(attempt.scheduledAt) : "Call time unavailable"}
                                {attempt.answeredAt ? ` · answered ${dateTimeLabel(attempt.answeredAt)}` : ""}
                                {attempt.endedAt ? ` · ended ${dateTimeLabel(attempt.endedAt)}` : ""}
                              </Typography>
                              {attempt.failure && <Alert severity={attempt.failure.retryable ? "warning" : "error"} variant="outlined" sx={{ mt: 1 }}>
                                Chiefvoice {attempt.failure.stage === "post_call" ? "post-call processing" : "call"} failed: {attempt.failure.code.replace(/[_.-]+/g, " ")}. {attempt.failure.retryable ? "A retry is allowed." : "This failure is not retryable."}
                              </Alert>}
                              {transcriptSummary && <Box sx={{ mt: 1.25 }}>
                                <Typography variant="caption" color="text.secondary" fontWeight={700}>CALL SUMMARY</Typography>
                                <Typography variant="body2" sx={{ mt: .5, overflowWrap: "anywhere" }}>{transcriptSummary}</Typography>
                              </Box>}
                              <Box sx={{ mt: 1.25, pt: 1.25, borderTop: "1px solid", borderColor: "divider" }}>
                                <Typography variant="caption" color="text.secondary" fontWeight={700}>TRANSCRIPT{transcript?.language ? ` · ${transcript.language.toUpperCase()}` : ""}</Typography>
                                {transcript?.text ? <Typography variant="body2" sx={{ mt: .5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{transcript.text}</Typography> : <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: .5 }}>Transcript not available yet.</Typography>}
                              </Box>
                              <Box sx={{ mt: 1.25 }}>
                                {attempt.recordingAvailable ? <CallRecording sessionId={record.sessionId} attemptId={attempt.id} /> : <Typography variant="caption" color="text.secondary">Recording not available yet.</Typography>}
                              </Box>
                            </Card>;
                          })}
                        </Stack>}
                      </Box>;
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
