import axios from "axios";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api/call-service",
  timeout: 20_000,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});


export interface WebUser {
  id: string;
  email: string;
  displayName: string;
}

const authApi = axios.create({
  baseURL: "/api/auth",
  timeout: 20_000,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

export async function signIn(email: string, password: string) {
  const response = await authApi.post<{ user: WebUser }>("/login", { email, password });
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
  callAttempts: SessionCallAttempt[];
  transcripts: SessionTranscript[];
  logs: SessionAuditLog[];
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
  employee: { id: string; name: string; phoneNumber: string; address?: string };
  patient: { id: string; name: string; address: string; phoneNumber?: string };
}

export interface AttendanceRecord {
  sessionId: string;
  assignmentId: string;
  scheduleVersion: string;
  language: string;
  employee: { id: string | null; name: string; phoneMasked: string | null };
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
  retry: {
    maxConsecutiveNoAnswer: number;
    initialMinutes: number;
    multiplier: number;
    maxMinutes: number;
  };
  source: { defaultFromNumber: "settings" | "environment"; retry: "settings" | "environment" };
}

export interface OperationsSummary {
  scheduledToday: number;
  checkInsConfirmed: number;
  checkOutsConfirmed: number;
  checkInsPending: number;
  checkOutsPending: number;
  exceptions: number;
  callsToday: number;
  activeCalls: number;
  completedCalls: number;
  averageDurationSeconds: number;
  callsWaiting: number;
  maxConcurrentCalls: number;
}

export interface StaffRecord {
  id: string;
  name: string;
  phoneNumber: string | null;
  phoneMasked: string | null;
  address: string;
  language: string;
  patientName: string;
  patientId: string | null;
  dutyStatus: string;
  assignmentId: string;
  sessionId: string;
}

export interface PatientRecord {
  id: string;
  name: string;
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

export async function fetchStaff(params: { search?: string; status?: string; limit?: number } = {}) {
  const response = await api.get<StaffRecord[]>("/staff", { params });
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

export async function createAssignment(payload: AssignmentPayload) {
  const response = await api.post<{ sessionId: string; status: string; queued: string[] }>("/assignments", payload);
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
