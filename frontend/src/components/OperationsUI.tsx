import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, Box, Button, Card, CardContent, Chip, InputAdornment, Popover, Stack, TableContainer, TextField, Typography } from "@mui/material";
import type { TableContainerProps } from "@mui/material/TableContainer";
import FilterListRoundedIcon from "@mui/icons-material/FilterListRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";

export function DemoDataNotice({ children = "Illustrative preview data — live feeds will appear when the backend list and analytics APIs are connected." }: { children?: string }) {
  return <Alert severity="info" icon={false} sx={{ py: 0, border: "1px solid #dbe6ff", bgcolor: "#f2f6ff", color: "#49618a", "& .MuiAlert-message": { py: 0.85, fontSize: 12 } }}>{children}</Alert>;
}

export const PageHeaderTargetContext = createContext<HTMLElement | null>(null);

export function PageHeader({ title, actions, showOutboundOnly = false }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode; showOutboundOnly?: boolean }) {
  const target = useContext(PageHeaderTargetContext);
  if (!target) return null;
  return createPortal(
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} spacing={{ xs: 1, sm: 2 }} sx={{ width: "100%", minWidth: 0 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, flex: 1, flexWrap: "wrap" }}>
        <Typography variant="h5" sx={{ fontWeight: 750 }} noWrap>{title}</Typography>
        {showOutboundOnly && <Chip label="Outbound only" size="small" sx={{ bgcolor: "#edf6f2", color: "#246b59", fontWeight: 650 }} />}
      </Stack>
      {actions && <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ width: { xs: "100%", sm: "auto" }, justifyContent: { xs: "flex-start", sm: "flex-end" }, flexShrink: 0 }}>{actions}</Stack>}
    </Stack>,
    target,
  );
}

export function OperationsTable({ children, sx, ...props }: TableContainerProps) {
  return <TableContainer
    {...props}
    sx={[
      {
        width: "100%",
        overflowX: "auto",
        "& .MuiTableHead-root .MuiTableCell-root": {
          bgcolor: "#f7f9fc",
          fontWeight: 750,
          whiteSpace: "nowrap",
        },
        "& .MuiTableBody-root .MuiTableRow-root:hover": { bgcolor: "action.hover" },
      },
      ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
    ]}
  >{children}</TableContainer>;
}

export function MetricCard({ label, value, detail, icon, tint = "#e9efff", accent = "#1557c0", tag, onClick, compact = false }: { label: string; value: string; detail?: string; icon: ReactNode; tint?: string; accent?: string; tag?: string; onClick?: () => void; compact?: boolean }) {
  return <Card onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } } : undefined} sx={{ height: "100%", minWidth: 0, cursor: onClick ? "pointer" : undefined, transition: "box-shadow .18s ease, transform .18s ease", "&:hover": onClick ? { transform: "translateY(-2px)", boxShadow: 4 } : undefined, "&:focus-visible": onClick ? { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 } : undefined }}>
    <CardContent sx={{ p: compact ? { xs: 1.25, sm: 1.5 } : { xs: 1.75, sm: 2.25 }, minWidth: 0, "&:last-child": { pb: compact ? { xs: 1.25, sm: 1.5 } : undefined } }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}><Box sx={{ width: compact ? 30 : 38, height: compact ? 30 : 38, display: "grid", placeItems: "center", borderRadius: 2.5, bgcolor: tint, color: accent, "& .MuiSvgIcon-root": { fontSize: compact ? 18 : 24 } }}>{icon}</Box>{tag && <Chip size="small" label={tag} sx={{ height: 22, bgcolor: tint, color: accent, fontSize: 10, fontWeight: 700 }} />}</Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: compact ? 1 : 2, fontSize: compact ? 12 : undefined }}>{label}</Typography>
      <Typography sx={{ fontSize: compact ? 23 : 27, lineHeight: 1.15, fontWeight: 750, letterSpacing: "-.035em", mt: .25 }}>{value}</Typography>
      {detail && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: compact ? .35 : .65, lineHeight: compact ? 1.25 : undefined }}>{detail}</Typography>}
    </CardContent>
  </Card>;
}

export function StatusChip({ status, compact = false }: { status: string; compact?: boolean }) {
  const normalized = String(status || "unknown").toLowerCase().trim().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");
  const compactLabels: Record<string, string> = {
    "attention required": "Review",
    "needs review": "Review",
    "call not placed": "Not placed",
    "not placed": "Not placed",
    "not answered": "No answer",
    "no answer": "No answer",
    "retry scheduled": "Retry",
    retry: "Retry",
    escalated: "Escalated",
    unresolved: "Follow-up",
    delayed: "Callback",
    completed: "Done",
    confirmed: "Done",
    "checked in": "Done",
    "check in": "Check-in",
    "check out": "Check-out",
    "in progress": "In progress",
    "pending check in": "Pending check-in",
    "missing check out": "Missing check-out",
  };
  const label = compact ? compactLabels[normalized] || normalized : ["not placed", "call not placed"].includes(normalized) ? "Call Not Placed" : normalized === "not answered" ? "Not Answered" : normalized === "unresolved" ? "Needs manual follow-up" : normalized === "check in" ? "Check-in" : normalized === "check out" ? "Check-out" : normalized;
  const color = ["verified", "confirmed", "completed", "checked in", "active", "synced", "delivered", "check in", "check out"].includes(normalized) ? "success"
    : ["not placed", "not answered", "no answer", "call not placed", "missed", "needs review", "attention required", "critical", "failed", "exception", "unreachable", "retry", "retry scheduled", "unresolved", "missing check out"].includes(normalized) ? "error"
      : ["delayed", "late", "retrying", "retry scheduled", "escalated", "pending", "pending check in", "queued", "in progress", "calling", "processing", "high"].includes(normalized) ? "warning" : "default";
  const escalationColors = normalized === "retry" || normalized === "retry scheduled" || normalized === "unresolved"
    ? { bgcolor: "#DC2626", color: "#fff", "&.MuiChip-filled": { bgcolor: "#DC2626" } }
    : normalized === "escalated" ? { bgcolor: "#F59E0B", color: "#1f2937", "&.MuiChip-filled": { bgcolor: "#F59E0B" } } : {};
  return <Chip size="small" color={color} variant={color === "default" ? "outlined" : "filled"} label={label} sx={{ textTransform: "capitalize", fontWeight: 650, ...escalationColors, ...(compact ? { height: 22, fontSize: "0.72rem", "& .MuiChip-label": { px: 0.8 } } : {}) }} />;
}

export function SectionCard({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <Card sx={{ height: "100%", minWidth: 0 }}><CardContent sx={{ p: { xs: 2, sm: 2.75 }, minWidth: 0 }}><Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems="flex-start" spacing={1.5} sx={{ mb: 2.25, minWidth: 0 }}><Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="h6" sx={{ fontSize: 17 }}>{title}</Typography>{subtitle && <Typography variant="body2" color="text.secondary" sx={{ mt: .4 }}>{subtitle}</Typography>}</Box>{action}</Stack>{children}</CardContent></Card>;
}


export function SearchFilterBar({
  search,
  onSearchChange,
  searchLabel,
  filters,
  actions,
  activeFilters = 0,
  onClearFilters,
  resultCount,
  resultLabel = "results",
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  filters: ReactNode;
  actions?: ReactNode;
  activeFilters?: number;
  onClearFilters?: () => void;
  resultCount: number;
  resultLabel?: string;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);
  return <>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} alignItems={{ xs: "stretch", sm: "center" }} sx={{ p: { xs: 1.5, sm: 2 }, borderBottom: "1px solid #e8edf3", minWidth: 0 }}>
      <TextField
        fullWidth
        size="small"
        label={searchLabel}
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        sx={{ flex: 1, minWidth: 0 }}
        InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" color="action" /></InputAdornment> }}
      />
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap">
        {actions}
        <Button
          variant={activeFilters ? "contained" : "outlined"}
          color={activeFilters ? "primary" : "inherit"}
          startIcon={<FilterListRoundedIcon />}
          endIcon={activeFilters ? <Chip size="small" label={activeFilters} sx={{ height: 20, minWidth: 20, bgcolor: activeFilters ? "rgba(255,255,255,.22)" : undefined, color: activeFilters ? "inherit" : undefined }} /> : undefined}
          onClick={(event) => setAnchorEl(event.currentTarget)}
          aria-haspopup="dialog"
          aria-expanded={open}
          sx={{ whiteSpace: "nowrap" }}
        >
          Filters
        </Button>
        <Chip size="small" label={resultCount + " " + resultLabel} variant="outlined" />
      </Stack>
    </Stack>
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={() => setAnchorEl(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
      PaperProps={{ sx: { width: "min(360px, calc(100vw - 32px))", p: 2 } }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="subtitle2" fontWeight={750}>Filter records</Typography>
          {onClearFilters && <Button size="small" onClick={onClearFilters} disabled={!activeFilters}>Clear all</Button>}
        </Stack>
        {filters}
      </Stack>
    </Popover>
  </>;
}
