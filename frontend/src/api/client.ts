import axios from "axios";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api/call-service",
  timeout: 20_000,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});


api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) window.dispatchEvent(new Event("attendance:unauthorized"));
    return Promise.reject(error);
  },
);

export interface WebUser {
  id: string;
  email: string | null;
  phone?: string | null;
  displayName: string;
  role: "admin" | "care_manager";
  mustChangePassword?: boolean;
}

export interface CareManager {
  id: string;
  athulyaCareManagerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  userId: string | null;
  accountActive: boolean | null;
  createdAt: string | null;
  lastLogin: string | null;
}

export interface AthulyaIntegrationSettings {
  integrationName: string;
  apiBaseUrl: string;
  enabled: boolean;
  autoSyncEnabled: boolean;
  autoSyncEnabledAt: string | null;
  lastAutoSyncSlot: string | null;
  autoSyncTimeZone: string;
  autoSyncScope: "all" | "branch" | "care_manager";
  autoSyncScopeId: string;
  keyConfigured: boolean;
  apiKeyMasked: string;
  updatedAt: string | null;
  lastSuccessfulScheduleSync: string | null;
  lastSuccessfulAttendanceSubmission: string | null;
  attendanceSubmissionStatus: "ready" | "not_configured";
}

export interface AthulyaSyncRun {
  id: string;
  syncSource: "manual" | "automatic" | null;
  syncScope: "all" | "branch" | "care_manager" | null;
  syncScopeId: string | null;
  status: "running" | "succeeded" | "failed";
  fromDate: string | null;
  toDate: string | null;
  recordsReceived: number;
  recordsUpserted: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AthulyaSchedule {
  id: string;
  athulyaScheduleId: string;
  athulyaSchedulePk: string;
  patient: { id: string; uhid: string; name: string };
  careManager: { id: string; name: string; phone: string };
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  status: string;
  service: string;
  carePlan: string;
  branch: string;
  vendorCompany: string;
  caregivers: Array<{ id: string; name: string; phone: string; status: string }>;
  lastSyncedAt: string;
}

export interface AthulyaAttendanceSubmission {
  id: string;
  eventType: "check_in" | "check_out";
  eventAt: string;
  status: "pending" | "processing" | "synced" | "failed" | "retry_scheduled" | "awaiting_api_specification";
  retryCount: number;
  responseCode: number | null;
  errorMessage: string | null;
  externalReference: string | null;
  createdAt: string;
  scheduleId: string | null;
  patientId: string | null;
  patientName: string | null;
  caregiverName: string | null;
}

export async function fetchCareManagers() {
  const response = await api.get<CareManager[]>("/care-managers");
  return response.data;
}

export async function provisionCareManagerAccount(id: string, password: string) {
  const response = await api.post<{ success: boolean; loginPhone: string; active: boolean; mustChangePassword: boolean }>(`/care-managers/${encodeURIComponent(id)}/provision`, { password });
  return response.data;
}

export async function createCareManager(payload: { name: string; email: string; phone: string; athulyaCareManagerId: string; password: string }) {
  const response = await api.post<CareManager>("/care-managers", payload);
  return response.data;
}

export async function updateCareManager(id: string, payload: { name: string; email: string; phone: string; athulyaCareManagerId: string }) {
  const response = await api.put<{ success: boolean }>(`/care-managers/${encodeURIComponent(id)}`, payload);
  return response.data;
}

export async function setCareManagerActive(id: string, active: boolean) {
  const response = await api.patch<{ success: boolean; active: boolean }>(`/care-managers/${encodeURIComponent(id)}`, { active });
  return response.data;
}

export async function resetCareManagerPassword(id: string, password: string) {
  const response = await api.post<{ success: boolean; sessionsRevoked: boolean }>(`/care-managers/${encodeURIComponent(id)}/reset-password`, { password });
  return response.data;
}

export async function provisionCareManagerAccount(id: string, password: string) {
  const response = await api.post<{ success: boolean; loginPhone: string; active: boolean; mustChangePassword: boolean }>(
    `/care-managers/${encodeURIComponent(id)}/provision`, { password },
  );
  return response.data;
}

export async function fetchAthulyaIntegration() {
  const response = await api.get<AthulyaIntegrationSettings>("/integrations/athulya");
  return response.data;
}

export async function saveAthulyaIntegration(payload: { integrationName: string; apiBaseUrl: string; apiKey?: string; enabled: boolean; autoSyncEnabled: boolean }) {
  const response = await api.put<AthulyaIntegrationSettings>("/integrations/athulya", payload);
  return response.data;
}

export async function testAthulyaIntegration(payload: { apiKey?: string; apiBaseUrl?: string } = {}) {
  const response = await api.post<{ connected: boolean; scheduleDate: string; recordsReceived: number }>("/integrations/athulya/test", payload);
  return response.data;
}

export async function startAthulyaSync(payload: { scheduleDate: string; careManagerId?: string; branchId?: string; clientId?: string }) {
  const response = await api.post<{ runId: string; status: string; scheduleDate: string }>("/integrations/athulya/sync", payload);
  return response.data;
}

export async function fetchAthulyaSyncRuns() {
  const response = await api.get<AthulyaSyncRun[]>("/integrations/athulya/sync-status");
  return response.data;
}


export interface ScheduledAthulyaCallItem {
  sessionId: string;
  assignmentId: string;
  schedulePk: string;
  caregiverId: string;
  caregiverName: string;
  patientName: string;
  stage: "check_in" | "check_out";
  taskStatus: string;
  scheduledAt: string;
  deliveryStatus: string;
  nextCallAt: string | null;
  queueJobId: string | null;
  queueJobStatus: "queued" | "running" | null;
  queueRunAt: string | null;
  queuedAttemptNumber: number | null;
  activeCallStatus: string | null;
  activeAttemptNumber: number | null;
  activeStartedAt: string | null;
  attemptCount: number;
  latestAttemptNumber: number | null;
  latestAttemptStatus: string | null;
}

export async function fetchScheduledAthulyaCalls(date: string) {
  const response = await api.get<{ date: string; timeZone: string; items: ScheduledAthulyaCallItem[] }>("/scheduled-calls", { params: { date } });
  return response.data;
}

export async function fetchAthulyaSchedules(params: { fromDate?: string; toDate?: string } = {}) {
  const response = await api.get<AthulyaSchedule[]>("/integrations/athulya/schedules", { params });
  return response.data;
}

export async function fetchAthulyaAttendanceSubmissions(params: { eventType?: string; status?: string; fromDate?: string; toDate?: string; caregiverId?: string; patientId?: string } = {}) {
  const response = await api.get<AthulyaAttendanceSubmission[]>("/integrations/athulya/attendance-submissions", { params });
  return response.data;
}

const authApi = axios.create({
  baseURL: "/api/auth",
  timeout: 20_000,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

export async function signIn(identifier: string, password: string) {
  const response = await authApi.post<{ user: WebUser }>("/login", { identifier, password });
  return response.data;
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const response = await authApi.post<{ user: WebUser }>("/change-password", { currentPassword, newPassword });
  return response.data;
}

export async function fetchCurrentUser() {
  const response = await authApi.get<{ user: WebUser }>("/me");
  return response.data;
}

export async function signOut() {
  const response = await authApi.post<{ success: boolean }>("/logout");
  return response.data;
}

export interface ServiceApiKey {
  id: string;
  organizationId: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}


export interface AttendanceStageStatus {
  taskId?: string | null;
  deliveryStatus?: string;
  status: string;
  flag: "not_answered" | null;
  reportedAt: string | null;
  scheduledAt?: string | null;
  nextCallAt?: string | null;
}

export interface AssignmentStatus {
  sessionId: string;
  assignmentId: string;
  sessionStatus: string;
  timeZone?: string;
  checkIn: AttendanceStageStatus;
  checkOut: AttendanceStageStatus;
  backendDeliveryStatus: string;
}

export interface SessionCallAttempt {
  id: string;
  stage: "check_in" | "check_out";
  attemptNumber: number;
  status: string;
  scheduledAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  outcome: Record<string, unknown> | null;
  recordingAvailable: boolean;
  recordingUrl: string | null;
}

export interface SessionTranscript {
  id: string;
  callAttemptId: string;
  language: string;
  text: string;
  extraction: Record<string, unknown> | null;
  createdAt: string;
}

export interface SessionAuditLog {
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface SessionArtifacts {
  session: { id: string; assignmentId: string; sessionStatus: string };
  tasks: Array<{ id: string; stage: "check_in" | "check_out"; status: string; scheduledAt: string; deliveryStatus: string }>;
  callAttempts: SessionCallAttempt[];
  transcripts: SessionTranscript[];
  logs: SessionAuditLog[];
}

export interface IncomingPatientCall {
  id: string;
  status: "processing" | "ready" | "failed" | "no_answer" | "canceled" | "cancelled";
  fromNumber: string;
  patient: { id?: string | null; name?: string | null; phoneNumber?: string | null; address?: string | null; careCategory?: string | null; hub?: string | null } | null;
  language: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  enquiryStatus: "processing" | "need_review" | "suggestion" | "shortage" | "resolved";
  resolvedStaff: { id: string; name: string; phoneNumber: string | null; address: string; language: string } | null;
  resolvedAt: string | null;
  hasRecording: boolean;
  hasTranscript: boolean;
  transcript: string | null;
  transcriptLanguage: string | null;
  enquiryAnalysisStatus: "pending" | "processing" | "complete" | "needs_details" | "failed";
  enquiryAnalysis: {
    activityId?: string | null;
    activityName?: string | null;
    durationMinutes?: number | null;
    timeZone?: string | null;
    requestedLocalDate?: string | null;
    requestedLocalTime?: string | null;
    requestedStartAt?: string | null;
    requestedEndAt?: string | null;
    needsSummary?: string;
    requiresHumanFollowUp?: boolean;
    missingDetails?: string[];
  };
  staffSuggestions: Array<{
    id: string;
    name: string;
    phoneNumber: string | null;
    address: string;
    language: string;
    locationMatch: "same_district" | "same_region" | "other_region";
  }>;
  bookingStatus: "not_started" | "calling" | "scheduled" | "not_answered" | "no_staff_available" | "needs_review";
  bookingStaff: { id: string; name: string; phoneNumber: string; address?: string; language?: string } | null;
  bookingScheduleSessionId: string | null;
  appointmentCalls: Array<{
    id: string; candidateIndex: number; staff: { id: string; name: string; phoneNumber: string | null; address?: string };
    providerCallId: string | null; status: string; answeredAt: string | null; endedAt: string | null;
    durationSeconds: number | null; transcript: string | null; outcome: Record<string, unknown>; recordingObjectKey: string | null;
  }>;
}
export type IncomingCall = IncomingPatientCall;

export interface CareActivity {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  durationMinutes: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentLanguagePrompt {
  dialect: string;
  systemPrompt: string;
}

export interface Agent {
  id: string;
  name: string;
  active: boolean;
  language: string;
  voice?: string | null;
  systemPrompt?: string;
  languagePrompts?: Record<string, AgentLanguagePrompt>;
}

export interface AssignmentPayload {
  assignmentId: string;
  agentId: string;
  fromNumber?: string;
  language: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  metadata?: { timeZone?: string; [key: string]: unknown };
  employee: { id: string; name: string; companyName?: string; phoneNumber: string; address?: string };
  patient: { id: string; name: string; address: string; phoneNumber?: string };
}

export interface AttendanceRecord {
  sessionId: string;
  assignmentId: string;
  scheduleVersion: string;
  language: string;
  employee: { id: string | null; name: string; companyName?: string; phoneMasked: string | null };
  patient: { id: string | null; name: string };
  scheduledStartAt: string;
  scheduledEndAt: string;
  checkIn: { status: string; reportedAt: string | null; nextCallAt: string | null };
  checkOut: { status: string; reportedAt: string | null; nextCallAt: string | null };
  stageReasons: { checkIn: string | null; checkOut: string | null };
  sessionStatus: string;
  backendDeliveryStatus: string;
  callAttemptCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CallingSettings {
  defaultFromNumber: string;
  allowInboundCalls: boolean;
  allowNonPatientInboundCalls: boolean;
  requireHumanVerificationForStaffBooking: boolean;
  unansweredCallEscalation: "platform_notification" | "call_care_manager";
  retry: {
    maxConsecutiveNoAnswer: number;
    initialMinutes: number;
    multiplier: number;
    maxMinutes: number;
  };
  source: { defaultFromNumber: "settings" | "environment"; retry: "settings" | "environment" };
}

export interface CareManagerNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  referenceType: string;
  referenceId: string;
  createdAt: string;
  readAt: string | null;
}

export async function fetchCareManagerNotifications() {
  const response = await api.get<CareManagerNotification[]>("/care-manager/notifications");
  return response.data;
}

export async function markCareManagerNotificationRead(id: string) {
  const response = await api.post(`/care-manager/notifications/${encodeURIComponent(id)}/read`);
  return response.data;
}

export interface OperationsSummary {
  scheduledToday: number;
  checkInsConfirmed: number;
  checkOutsConfirmed: number;
  checkInsPending: number;
  checkOutsPending: number;
  exceptions: number;
  completedSchedules: number;
  callsToday: number;
  activeCalls: number;
  completedCalls: number;
  averageDurationSeconds: number;
  callsWaiting: number;
  maxConcurrentCalls: number;
  careManagers: number;
  caregivers: number;
  patients: number;
}

export interface CreateStaffPayload {
  id: string;
  name: string;
  companyName?: string;
  phoneNumber: string;
  address: string;
  language: string;
}

export interface CreatePatientPayload {
  id: string;
  name: string;
  phoneNumber?: string;
  address: string;
  language: string;
  careCategory?: string;
  hub?: string;
}

export interface StaffRecord {
  id: string;
  name: string;
  companyName: string;
  branch?: string;
  phoneNumber: string | null;
  phoneMasked: string | null;
  address: string;
  language: string;
  patientName: string;
  patientId: string | null;
  dutyStatus: string;
  assignmentId: string;
  sessionId: string;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
}

export interface PatientRecord {
  id: string;
  name: string;
  patientUhid?: string;
  branch?: string;
  phoneNumber: string | null;
  address: string;
  language: string;
  assignedStaff: string;
  employeeId: string | null;
  careCategory: string;
  hub: string;
  locationVerification: string;
  status: string;
}

export interface SupervisionItem {
  id: string;
  sessionId: string;
  assignmentId: string;
  employee: { id: string | null; name: string; phoneMasked: string | null };
  patient: { id: string | null; name: string };
  stage: "check_in" | "check_out";
  status: string;
  severity: string;
  reason: string;
  callAttemptCount: number;
  scheduledAt: string;
  updatedAt: string;
}

export interface CallCenterData {
  activeCalls: Array<{
    attemptId: string; callId: string | null; sessionId: string; assignmentId: string;
    stage: string; status: string; attemptNumber: number;
    employee: { id: string | null; name: string }; patient: { id: string | null; name: string };
    language: string; startedAt: string;
  }>;
  retryQueue: Array<{
    jobId: string; sessionId: string; assignmentId: string; stage: string;
    attemptNumber: number; runAt: string; language: string;
    employee: { id: string | null; name: string }; patient: { name: string };
  }>;
  maxConcurrentCalls: number;
}

export async function fetchAssignmentStatus(sessionId: string) {
  const response = await api.get<AssignmentStatus>(`/assignments/${sessionId}/status`);
  return response.data;
}

export async function fetchSessionArtifacts(sessionId: string) {
  const response = await api.get<SessionArtifacts>(`/assignments/${sessionId}/artifacts`);
  return response.data;
}

export async function fetchCallRecording(sessionId: string, attemptId: string) {
  const response = await api.get<Blob>(`/assignments/${sessionId}/recordings/${attemptId}`, { responseType: "blob" });
  return response.data;
}

export async function fetchCallingSettings() {
  const response = await api.get<CallingSettings>("/settings/calling");
  return response.data;
}

export async function saveCallingSettings(settings: Omit<CallingSettings, "source">) {
  const response = await api.put<CallingSettings>("/settings/calling", settings);
  return response.data;
}

export async function resetCallingSettings() {
  const response = await api.post<CallingSettings>("/settings/calling/reset");
  return response.data;
}

export async function fetchOperationsSummary() {
  const response = await api.get<OperationsSummary>("/dashboard/summary");
  return response.data;
}

export async function fetchAttendance(params: { search?: string; status?: string; limit?: number } = {}) {
  const response = await api.get<AttendanceRecord[]>("/assignments", { params });
  return response.data;
}

export async function createStaff(payload: CreateStaffPayload) {
  const response = await api.post<StaffRecord>("/staff", payload);
  return response.data;
}

export async function updateStaff(id: string, payload: CreateStaffPayload) {
  const response = await api.put<StaffRecord>(`/staff/${encodeURIComponent(id)}`, payload);
  return response.data;
}

export async function fetchStaff(params: { search?: string; status?: string; limit?: number } = {}) {
  const response = await api.get<StaffRecord[]>("/staff", { params });
  return response.data;
}

export async function createPatient(payload: CreatePatientPayload) {
  const response = await api.post<PatientRecord>("/patients", payload);
  return response.data;
}

export async function updatePatient(id: string, payload: CreatePatientPayload) {
  const response = await api.put<PatientRecord>(`/patients/${encodeURIComponent(id)}`, payload);
  return response.data;
}

export async function fetchPatients(params: { search?: string; status?: string; limit?: number } = {}) {
  const response = await api.get<PatientRecord[]>("/patients", { params });
  return response.data;
}

export async function fetchSupervisionQueue(params: { search?: string; severity?: string; limit?: number } = {}) {
  const response = await api.get<SupervisionItem[]>("/supervision-queue", { params });
  return response.data;
}

export async function fetchAttendanceLedger(params: { search?: string; limit?: number } = {}) {
  const response = await api.get<AttendanceRecord[]>("/attendance/ledger", { params });
  return response.data;
}

export async function fetchCallCenterData() {
  const response = await api.get<CallCenterData>("/call-center");
  return response.data;
}

export async function fetchCareActivities(includeInactive = true) {
  const response = await api.get<CareActivity[]>("/activities", { params: { includeInactive } });
  return response.data;
}

export async function createCareActivity(activity: Pick<CareActivity, "name" | "aliases" | "description" | "durationMinutes">) {
  const response = await api.post<CareActivity>("/activities", activity);
  return response.data;
}

export async function updateCareActivity(id: string, activity: Pick<CareActivity, "name" | "aliases" | "description" | "durationMinutes" | "active">) {
  const response = await api.put<CareActivity>("/activities/" + encodeURIComponent(id), activity);
  return response.data;
}
export async function fetchIncomingCalls(limit = 100) {
  const response = await api.get<IncomingPatientCall[]>("/incoming-calls", { params: { limit } });
  return response.data;
}

export async function resolveIncomingEnquiry(id: string, staffId: string) {
  const response = await api.post<{ id: string; enquiryStatus: IncomingCall["enquiryStatus"]; resolvedStaff: NonNullable<IncomingCall["resolvedStaff"]>; resolvedAt: string; bookingStatus?: IncomingCall["bookingStatus"]; bookingScheduleSessionId?: string | null }>(
    `/incoming-calls/${encodeURIComponent(id)}/resolve`, { staffId },
  );
  return response.data;
}

export function incomingCallRecordingUrl(id: string) {
  return `${api.defaults.baseURL || "/api/call-service"}/incoming-calls/${encodeURIComponent(id)}/recording`;
}

export function appointmentCallRecordingUrl(id: string, attemptId: string) {
  return `${api.defaults.baseURL || "/api/call-service"}/incoming-calls/${encodeURIComponent(id)}/appointment-attempts/${encodeURIComponent(attemptId)}/recording`;
}

export async function fetchAgents() {
  const response = await api.get<Agent[]>("/agents");
  return response.data;
}

export async function createAgent(agent: Pick<Agent, "name" | "language" | "voice" | "systemPrompt" | "languagePrompts">) {
  const response = await api.post<Agent>("/agents", agent);
  return response.data;
}

export async function updateAgent(agentId: string, update: Pick<Agent, "name" | "language" | "voice" | "systemPrompt" | "languagePrompts">) {
  const response = await api.patch<Agent>(`/agents/${agentId}`, update);
  return response.data;
}

export interface EmployeeScheduleOverlap {
  overlap: boolean;
  conflict: { assignmentId: string; patientName: string; scheduledStartAt: string; scheduledEndAt: string } | null;
}

export async function fetchEmployeeScheduleOverlap(params: {
  employeeId: string;
  startAt: string;
  endAt: string;
  assignmentId?: string;
}) {
  const response = await api.get<EmployeeScheduleOverlap>("/assignments/overlap", { params });
  return response.data;
}

export async function createAssignment(payload: AssignmentPayload) {
  const response = await api.post<{
    sessionId: string;
    status: string;
    queued: string[];
    tasks: {
      checkIn: { taskId: string | null; scheduledAt: string };
      checkOut: { taskId: string | null; scheduledAt: string };
    };
  }>("/assignments", payload);
  return response.data;
}

export async function createServiceApiKey(label: string) {
  const response = await api.post<ServiceApiKey & { apiKey: string }>("/api-keys", { label });
  return response.data;
}

export async function fetchServiceApiKeys() {
  const response = await api.get<ServiceApiKey[]>("/api-keys");
  return response.data;
}

export async function revokeServiceApiKey(id: string) {
  const response = await api.delete<{ success: boolean }>(`/api-keys/${id}`);
  return response.data;
}
