import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, Box, Button, Card, CardContent, Chip, InputAdornment, Popover, Stack, TextField, Typography } from "@mui/material";
import FilterListRoundedIcon from "@mui/icons-material/FilterListRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";

export function DemoDataNotice({ children = "Illustrative preview data — live feeds will appear when the backend list and analytics APIs are connected." }: { children?: string }) {
  return <Alert severity="info" icon={false} sx={{ py: 0, border: "1px solid #dbe6ff", bgcolor: "#f2f6ff", color: "#49618a", "& .MuiAlert-message": { py: 0.85, fontSize: 12 } }}>{children}</Alert>;
}

export const PageHeaderTargetContext = createContext<HTMLElement | null>(null);

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  const target = useContext(PageHeaderTargetContext);
  if (!target) return null;
  return createPortal(
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} spacing={{ xs: 1, sm: 2 }} sx={{ width: "100%", minWidth: 0 }}>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        {eyebrow && <Typography variant="overline" color="primary.main" fontWeight={750} letterSpacing=".12em" noWrap>{eyebrow}</Typography>}
        <Typography variant="h5" sx={{ mt: eyebrow ? .1 : 0, fontWeight: 750 }} noWrap>{title}</Typography>
        {description && <Typography variant="body2" color="text.secondary" sx={{ mt: .25, maxWidth: 760 }}>{description}</Typography>}
      </Box>
      {actions && <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ width: { xs: "100%", sm: "auto" }, justifyContent: { xs: "flex-start", sm: "flex-end" }, flexShrink: 0 }}>{actions}</Stack>}
    </Stack>,
    target,
  );
}

export function MetricCard({ label, value, detail, icon, tint = "#e9efff", accent = "#1557c0", tag }: { label: string; value: string; detail?: string; icon: ReactNode; tint?: string; accent?: string; tag?: string }) {
  return <Card sx={{ height: "100%", minWidth: 0 }}><CardContent sx={{ p: { xs: 1.75, sm: 2.25 }, minWidth: 0 }}><Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}><Box sx={{ width: 38, height: 38, display: "grid", placeItems: "center", borderRadius: 2.5, bgcolor: tint, color: accent }}>{icon}</Box>{tag && <Chip size="small" label={tag} sx={{ height: 22, bgcolor: tint, color: accent, fontSize: 10, fontWeight: 700 }} />}</Stack><Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>{label}</Typography><Typography sx={{ fontSize: 27, lineHeight: 1.2, fontWeight: 750, letterSpacing: "-.035em", mt: .45 }}>{value}</Typography>{detail && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .65 }}>{detail}</Typography>}</CardContent></Card>;
}

export function StatusChip({ status }: { status: string }) {
  const normalized = status.toLowerCase().replaceAll("_", " ");
  const color = ["verified", "confirmed", "completed", "active", "synced", "delivered"].includes(normalized) ? "success"
    : ["not answered", "critical", "failed", "exception", "unreachable"].includes(normalized) ? "error"
      : ["late", "retrying", "pending", "queued", "in progress", "processing", "high"].includes(normalized) ? "warning" : "default";
  return <Chip size="small" color={color} variant={color === "default" ? "outlined" : "filled"} label={normalized} sx={{ textTransform: "capitalize", fontWeight: 650 }} />;
}

export function SectionCard({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <Card sx={{ height: "100%", minWidth: 0 }}><CardContent sx={{ p: { xs: 2, sm: 2.75 }, minWidth: 0 }}><Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems="flex-start" spacing={1.5} sx={{ mb: 2.25, minWidth: 0 }}><Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="h6" sx={{ fontSize: 17 }}>{title}</Typography>{subtitle && <Typography variant="body2" color="text.secondary" sx={{ mt: .4 }}>{subtitle}</Typography>}</Box>{action}</Stack>{children}</CardContent></Card>;
}


export function SearchFilterBar({
  search,
  onSearchChange,
  searchLabel,
  filters,
  activeFilters = 0,
  onClearFilters,
  resultCount,
  resultLabel = "results",
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  filters: ReactNode;
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
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
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
