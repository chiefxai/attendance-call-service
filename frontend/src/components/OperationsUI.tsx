import type { ReactNode } from "react";
import { Alert, Box, Card, CardContent, Chip, Stack, Typography } from "@mui/material";

export function DemoDataNotice({ children = "Illustrative preview data — live feeds will appear when the backend list and analytics APIs are connected." }: { children?: string }) {
  return <Alert severity="info" icon={false} sx={{ py: 0, border: "1px solid #dbe6ff", bgcolor: "#f2f6ff", color: "#49618a", "& .MuiAlert-message": { py: 0.85, fontSize: 12 } }}>{children}</Alert>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "flex-end" }} spacing={2}>
    <Box>{eyebrow && <Typography variant="overline" color="primary.main" fontWeight={750} letterSpacing=".12em">{eyebrow}</Typography>}<Typography variant="h4" sx={{ mt: eyebrow ? .35 : 0 }}>{title}</Typography>{description && <Typography color="text.secondary" sx={{ mt: .75, maxWidth: 760 }}>{description}</Typography>}</Box>
    {actions && <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>{actions}</Stack>}
  </Stack>;
}

export function MetricCard({ label, value, detail, icon, tint = "#e9efff", accent = "#1557c0", tag }: { label: string; value: string; detail?: string; icon: ReactNode; tint?: string; accent?: string; tag?: string }) {
  return <Card sx={{ height: "100%" }}><CardContent sx={{ p: 2.25 }}><Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}><Box sx={{ width: 38, height: 38, display: "grid", placeItems: "center", borderRadius: 2.5, bgcolor: tint, color: accent }}>{icon}</Box>{tag && <Chip size="small" label={tag} sx={{ height: 22, bgcolor: tint, color: accent, fontSize: 10, fontWeight: 700 }} />}</Stack><Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>{label}</Typography><Typography sx={{ fontSize: 27, lineHeight: 1.2, fontWeight: 750, letterSpacing: "-.035em", mt: .45 }}>{value}</Typography>{detail && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .65 }}>{detail}</Typography>}</CardContent></Card>;
}

export function StatusChip({ status }: { status: string }) {
  const normalized = status.toLowerCase().replaceAll("_", " ");
  const color = ["verified", "confirmed", "completed", "active", "synced", "delivered"].includes(normalized) ? "success"
    : ["not answered", "critical", "failed", "exception", "unreachable"].includes(normalized) ? "error"
      : ["late", "retrying", "pending", "queued", "in progress", "high"].includes(normalized) ? "warning" : "default";
  return <Chip size="small" color={color} variant={color === "default" ? "outlined" : "filled"} label={normalized} sx={{ textTransform: "capitalize", fontWeight: 650 }} />;
}

export function SectionCard({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <Card sx={{ height: "100%" }}><CardContent sx={{ p: { xs: 2, sm: 2.75 } }}><Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2} sx={{ mb: 2.25 }}><Box><Typography variant="h6" sx={{ fontSize: 17 }}>{title}</Typography>{subtitle && <Typography variant="body2" color="text.secondary" sx={{ mt: .4 }}>{subtitle}</Typography>}</Box>{action}</Stack>{children}</CardContent></Card>;
}
