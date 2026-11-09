// The PROSM Time integration API contract (OpenAPI 3.1), served at GET /api-v1/openapi.json.
// Any system - accounting, HR, BI, a fingerprint device - can be built against it. Kept next to
// the gateway so the two change together.

const page = (item: Record<string, unknown>) => ({
  type: "object",
  required: ["data", "nextCursor", "requestId"],
  properties: {
    data: { type: "array", items: item },
    nextCursor: { type: ["string", "null"], description: "Pass as ?cursor= to get the next page; null on the last page." },
    requestId: { type: "string" },
  },
});
const cursor = { name: "cursor", in: "query", schema: { type: "string" }, description: "From the previous page's nextCursor." };
const limit = { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } };
const since = (description: string) => ({ name: "since", in: "query", schema: { type: "string", format: "date-time" }, description });
const until = { name: "until", in: "query", schema: { type: "string", format: "date-time" }, description: "Defaults to now." };
const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/Error" },
};
const read = (summary: string, scope: string, parameters: unknown[], item: Record<string, unknown>) => ({
  get: {
    summary,
    description: `Needs the \`${scope}\` scope.`,
    security: [{ apiKey: [] }],
    parameters,
    responses: { "200": { description: "A page", content: { "application/json": { schema: page(item) } } }, ...errors },
  },
});

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "PROSM Time API",
    version: "1.0.0",
    description:
      "Read your organisation's data from PROSM Time and send attendance to it. Create a key in PROSM Time (Integrations, owner only) with only the scopes the other system needs, and send it as `Authorization: Bearer <key>`. The organisation always comes from the key. Lists are paged with a cursor. Every response carries a requestId - quote it when asking for help. Keys can expire and be revoked at any time; test and live keys are separate.",
  },
  servers: [{ url: "https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/api-v1" }],
  components: {
    securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "A PROSM Time API key (ptime_live_... or ptime_test_...)." } },
    responses: {
      Error: {
        description: "An error",
        content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } }, requestId: { type: "string" } } } } },
      },
    },
  },
  // instant notifications to your system (created by the owner in PROSM Time, Integrations)
  webhooks: {
    event: {
      post: {
        summary: "An event happened in PROSM Time",
        description:
          "PROSM Time posts JSON {id, type, createdAt, organizationId, environment, data} to your HTTPS address. Types: employee.created, employee.updated, employee.deactivated, attendance.clock_in, attendance.clock_out, leave.requested, leave.approved, leave.rejected, leave.cancelled. Check the header X-PROSM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of '<t>.<raw body>' with your signing secret>, and refuse old timestamps. Answer 2xx quickly; any other answer is retried after 1, 5 and 30 minutes, 2, 6, 12 and 24 hours. The same event may arrive twice: use its id to ignore repeats. data carries ids and states only (no amounts, no contact details).",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, createdAt: { type: "string", format: "date-time" }, organizationId: { type: "string" }, environment: { type: "string" }, data: { type: "object" } } } } } },
        responses: { "200": { description: "Received" } },
      },
    },
  },
  paths: {
    "/me": {
      get: {
        summary: "The key itself: organisation, environment and scopes",
        security: [{ apiKey: [] }],
        responses: { "200": { description: "The key" }, ...errors },
      },
    },
    "/employees": read("Employees", "employees:read", [cursor, limit], {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" }, name: { type: "string" }, role: { type: "string" }, active: { type: "boolean" },
        siteIds: { type: "array", items: { type: "string", format: "uuid" } }, employeeCode: { type: ["string", "null"] },
        email: { type: "string", description: "Only with the employees:read_sensitive scope." }, updatedAt: { type: "string", format: "date-time" },
      },
    }),
    "/sites": read("Sites", "sites:read", [cursor, limit], {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, active: { type: "boolean" }, timezone: { type: "string" }, latitude: { type: "number" }, longitude: { type: "number" }, radiusMeters: { type: "integer" } },
    }),
    "/attendance": read("Attendance records (approved in PROSM Time)", "attendance:read", [since("Defaults to 30 days before until; the window is at most 92 days."), until, cursor, limit], {
      type: "object",
      properties: {
        id: { type: "string" }, employeeId: { type: "string" }, siteId: { type: ["string", "null"] }, status: { type: "string" },
        clockInAt: { type: "string", format: "date-time" }, clockOutAt: { type: ["string", "null"], format: "date-time" },
        workedMinutes: { type: ["number", "null"] }, breakMinutes: { type: "number" }, verified: { type: "boolean" },
      },
    }),
    "/leaves": read("Leave requests", "leaves:read", [since("Defaults to 90 days before until; at most 366 days."), until, cursor, limit], {
      type: "object",
      properties: { id: { type: "string" }, employeeId: { type: "string" }, type: { type: "string" }, startDate: { type: "string", format: "date" }, endDate: { type: "string", format: "date" }, workingDays: { type: "number" }, status: { type: "string" } },
    }),
    "/leave-balances": read("Leave balances per employee and leave type", "leaves:read", [{ name: "year", in: "query", schema: { type: "integer" } }, cursor, limit], {
      type: "object",
      properties: {
        employeeId: { type: "string" }, year: { type: "integer" },
        balances: { type: "array", items: { type: "object", properties: { leaveType: { type: "string" }, name: { type: "string" }, paid: { type: "boolean" }, entitledDays: { type: ["number", "null"] }, usedDays: { type: "number" }, pendingDays: { type: "number" }, remainingDays: { type: ["number", "null"] } } } },
      },
    }),
    "/shifts": read("Scheduled shifts", "shifts:read", [since("Defaults to 14 days before until; at most 92 days."), until, cursor, limit], {
      type: "object",
      properties: { id: { type: "string" }, employeeId: { type: "string" }, siteId: { type: ["string", "null"] }, date: { type: "string", format: "date" }, startTime: { type: "string" }, endTime: { type: "string" }, status: { type: "string" } },
    }),
    "/payroll-records": read("Payroll of locked cycles (net lines only, from the approved version)", "payroll:read", [{ name: "cycleId", in: "query", schema: { type: "string", format: "uuid" } }, cursor, limit], {
      type: "object",
      properties: {
        cycleId: { type: "string" }, cycleTitle: { type: "string" }, periodStart: { type: "string" }, periodEnd: { type: "string" }, cycleVersion: { type: "integer" },
        employeeId: { type: "string" }, employeeCode: { type: ["string", "null"] }, currency: { type: "string" },
        totalEarnings: { type: "number" }, totalDeductions: { type: "number" }, totalInstallments: { type: "number" }, netSalary: { type: "number" },
        lines: { type: "array", items: { type: "object", properties: { name: { type: "string" }, nameEn: { type: ["string", "null"] }, category: { type: "string" }, amount: { type: "number" } } } },
      },
    }),
    "/attendance-events": {
      post: {
        summary: "Send attendance from another system (a fingerprint device, an HR system)",
        description:
          "Needs the `attendance:write` scope. 1 to 500 events per call. Each event carries your own unique externalId: sending the same event again is safe (it comes back as duplicate); the same externalId with different content is a conflict. Events enter PROSM Time as pending and count for nothing until a manager approves them; approval turns each clock-in and the next clock-out of the same person into one attendance record. Events may be up to 62 days old and not in the future.",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["events"],
                properties: {
                  events: {
                    type: "array", minItems: 1, maxItems: 500,
                    items: {
                      type: "object",
                      required: ["externalId", "employeeId", "type", "occurredAt"],
                      properties: {
                        externalId: { type: "string", maxLength: 120, description: "Your id for this event - unique in your organisation." },
                        employeeId: { type: "string", format: "uuid", description: "From GET /employees." },
                        siteId: { type: "string", format: "uuid", description: "Optional, from GET /sites." },
                        type: { type: "string", enum: ["clock_in", "clock_out"] },
                        occurredAt: { type: "string", format: "date-time" },
                        device: { type: "string", maxLength: 120 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Every event was accepted or already known" },
          "207": { description: "Some events were refused - see results[].reason (external_id_required, invalid_type, unknown_employee, unknown_site, in_the_future, too_old, invalid_value, external_id_reused_with_other_content)" },
          ...errors,
        },
      },
    },
  },
} as const;
