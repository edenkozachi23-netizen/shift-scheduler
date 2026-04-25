// Shared TypeScript types.
// Full database types will be generated from Supabase in Phase 2.

export type UserRole = "employee" | "manager";

export type ShiftPeriod = "morning" | "evening";

export type ConstraintType = "full_day" | "morning" | "evening";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
