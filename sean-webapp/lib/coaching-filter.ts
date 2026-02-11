/**
 * Coaching Data Filter
 * Prevents coaching client data from being used in responses for unauthorized users
 */

/**
 * Check if a query is asking about coaching data
 */
export function isCoachingQuery(query: string): boolean {
  const coachingKeywords = [
    "coaching",
    "client session",
    "coaching client",
    "gauge",
    "assessment",
    "coaching progress",
    "coaching insight",
    "coaching note",
    "neuro-coach",
    "client journey",
    "coaching session",
  ];

  const lowerQuery = query.toLowerCase();
  return coachingKeywords.some((keyword) => lowerQuery.includes(keyword));
}

/**
 * Filters out coaching-related data from responses for users without access
 */
export function filterCoachingData(data: any, hasCoachingAccess: boolean) {
  if (hasCoachingAccess) {
    return data; // No filtering needed
  }

  // Remove any coaching-related fields
  if (Array.isArray(data)) {
    return data.filter((item) => !isCoachingData(item));
  }

  if (typeof data === "object" && data !== null) {
    const filtered = { ...data };
    delete filtered.coachingClients;
    delete filtered.coachingSessions;
    delete filtered.clientGauges;
    delete filtered.coachingInsights;
    delete filtered.clientAssessments;
    delete filtered.coachingNotes;
    return filtered;
  }

  return data;
}

/**
 * Check if data object contains coaching-related information
 */
function isCoachingData(item: any): boolean {
  const coachingKeywords = [
    "coaching",
    "client_session",
    "gauge_reading",
    "coach_id",
    "session_summary",
    "neuro_coach",
    "client_assessment",
  ];

  const itemStr = JSON.stringify(item).toLowerCase();
  return coachingKeywords.some((keyword) => itemStr.includes(keyword));
}

/**
 * Generate a system prompt that blocks coaching data access
 * @param hasCoachingAccess - Whether the user has coaching access
 * @returns System prompt addition
 */
export function getCoachingFilterPrompt(hasCoachingAccess: boolean): string {
  if (hasCoachingAccess) {
    return `\n\nYou have full access to coaching client data and can answer questions about coaching sessions, client progress, and insights.`;
  }

  return `\n\nIMPORTANT: You do NOT have access to coaching client data.
If asked about coaching clients or sessions, respond:
"I don't have access to coaching client data. Please contact Ruan for coaching-related inquiries."

DO NOT answer questions about:
- Coaching sessions or client progress
- Client assessments or gauges
- Coaching insights or notes
- Any data from the Neuro-Coach Method coaching app

You can only answer questions about accounting, allocations, tax, and business operations.`;
}
