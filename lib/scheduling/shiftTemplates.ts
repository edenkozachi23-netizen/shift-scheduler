import type { ShiftTemplate } from "./types";

export const SHIFT_TEMPLATES: ShiftTemplate[] = [
  {
    shiftTemplateId: "morning-07-19",
    shiftCode: "M1",
    shiftLabelHe: "בוקר 07:00–19:00",
    period: "morning",
    startTime: "07:00",
    endTime: "19:00",
  },
  {
    shiftTemplateId: "morning-08-20",
    shiftCode: "M2",
    shiftLabelHe: "בוקר 08:00–20:00",
    period: "morning",
    startTime: "08:00",
    endTime: "20:00",
  },
  {
    shiftTemplateId: "evening-19-07",
    shiftCode: "E1",
    shiftLabelHe: "ערב 19:00–07:00",
    period: "evening",
    startTime: "19:00",
    endTime: "07:00",
  },
  {
    shiftTemplateId: "evening-20-08",
    shiftCode: "E2",
    shiftLabelHe: "ערב 20:00–08:00",
    period: "evening",
    startTime: "20:00",
    endTime: "08:00",
  },
];

export const SHIFT_TEMPLATE_MAP: Record<string, ShiftTemplate> = Object.fromEntries(
  SHIFT_TEMPLATES.map((t) => [t.shiftTemplateId, t])
);

export const T_MORNING_07 = SHIFT_TEMPLATES[0];
export const T_MORNING_08 = SHIFT_TEMPLATES[1];
export const T_EVENING_19 = SHIFT_TEMPLATES[2];
export const T_EVENING_20 = SHIFT_TEMPLATES[3];
