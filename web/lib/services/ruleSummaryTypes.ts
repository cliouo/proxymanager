export interface RuleSummary {
  total: number;
  active: number;
  disabled: number;
  anchors: Record<string, { total: number; active: number }>;
  policies: Record<string, number>;
  ruleSets: Record<string, number>;
}
