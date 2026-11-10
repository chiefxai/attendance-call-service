"use strict";

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");

function createAppointmentBookingTools({ repository } = {}) {
  if (!repository?.saveAppointmentAttendanceSchedule) throw new Error("Appointment booking tools require a schedule repository");

  const createAttendanceSchedule = tool(async ({ inboundCallId, organizationId, staff, attendanceAgentId, fromNumber }) => {
    const attendanceAgent = await repository.getAgent(organizationId, attendanceAgentId);
    if (!attendanceAgent?.active) throw new Error("An active attendance agent is required to create the duty schedule");
    const session = await repository.saveAppointmentAttendanceSchedule({
      inboundCallId, organizationId, staff, attendanceAgent, fromNumber,
    });
    return JSON.stringify({ sessionId: session.id, assignmentId: session.assignmentId, scheduledStartAt: session.scheduledStartAt, scheduledEndAt: session.scheduledEndAt });
  }, {
    name: "create_confirmed_attendance_schedule",
    description: "Create the attendance duty schedule only after the staff member has explicitly confirmed availability for the activity and exact start time.",
    schema: z.object({
      inboundCallId: z.string().uuid(), organizationId: z.string().min(1),
      staff: z.object({ id: z.string(), name: z.string(), phoneNumber: z.string(), address: z.string().optional(), language: z.string().optional() }),
      attendanceAgentId: z.string().uuid(), fromNumber: z.string().min(1),
    }),
  });

  return { createAttendanceSchedule };
}

module.exports = { createAppointmentBookingTools };
