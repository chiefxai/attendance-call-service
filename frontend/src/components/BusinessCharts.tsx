import { Box, Stack, Typography } from "@mui/material";

export type AttendanceChartStatus = "pending" | "checkin" | "checkout" | "processing" | "delayed";
export interface TrendPoint { label: string; checkIns: number; checkOuts: number }
export interface StatusSlice { status: AttendanceChartStatus; value: number }
export interface RetryBucket { label: string; value: number }
export interface LanguageStack { label: string; values: Record<AttendanceChartStatus, number> }

const statusColors: Record<AttendanceChartStatus, string> = {
  pending: "#9aa6b2",
  checkin: "#19866a",
  checkout: "#356bd1",
  processing: "#e0a12e",
  delayed: "#d85454",
};
const statusLabels: Record<AttendanceChartStatus, string> = {
  pending: "Pending",
  checkin: "Check-in",
  checkout: "Check-out",
  processing: "Processing",
  delayed: "Delayed",
};

function EmptyChart({ message = "No attendance data yet" }: { message?: string }) {
  return <Box sx={{ height: 245, display: "grid", placeItems: "center" }}><Typography variant="body2" color="text.secondary">{message}</Typography></Box>;
}

export function AttendanceTrendChart({ points }: { points: TrendPoint[] }) {
  if (!points.some((point) => point.checkIns || point.checkOuts)) return <EmptyChart message="No confirmed attendance in the last 7 days" />;
  const width = 640, height = 260, left = 42, right = 20, top = 20, bottom = 42;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const max = Math.max(1, ...points.flatMap((point) => [point.checkIns, point.checkOuts]));
  const coordinates = (value: number, index: number) => ({
    x: left + (points.length > 1 ? index * plotWidth / (points.length - 1) : plotWidth / 2),
    y: top + plotHeight - value / max * plotHeight,
  });
  const checkInLine = points.map((point, index) => coordinates(point.checkIns, index));
  const checkOutLine = points.map((point, index) => coordinates(point.checkOuts, index));
  return <Box sx={{ width: "100%", minWidth: 0 }}>
    <svg role="img" aria-label="Confirmed check-ins and check-outs over the last seven days" viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", height: "auto" }}>
      {[0, .5, 1].map((fraction) => {
        const y = top + plotHeight - fraction * plotHeight;
        return <g key={fraction}><line x1={left} x2={width - right} y1={y} y2={y} stroke="#e9edf2" /><text x={left - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#758194">{Math.round(max * fraction)}</text></g>;
      })}
      <polyline points={checkInLine.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={statusColors.checkin} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={checkOutLine.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={statusColors.checkout} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point, index) => {
        const checkIn = coordinates(point.checkIns, index), checkOut = coordinates(point.checkOuts, index);
        return <g key={point.label}><circle cx={checkIn.x} cy={checkIn.y} r="4" fill={statusColors.checkin} /><circle cx={checkOut.x} cy={checkOut.y} r="4" fill={statusColors.checkout} /><text x={checkIn.x} y={height - 14} textAnchor="middle" fontSize="11" fill="#758194">{point.label}</text></g>;
      })}
    </svg>
    <Stack direction="row" spacing={2.5} justifyContent="center" sx={{ mt: .5 }}>
      {(["checkin", "checkout"] as const).map((status) => <Stack key={status} direction="row" spacing={.75} alignItems="center"><Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: statusColors[status] }} /><Typography variant="caption" color="text.secondary">{statusLabels[status]}</Typography></Stack>)}
    </Stack>
  </Box>;
}

export function AttendanceStatusChart({ slices }: { slices: StatusSlice[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (!total) return <EmptyChart />;
  const radius = 72, circumference = 2 * Math.PI * radius;
  let offset = 0;
  return <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center" justifyContent="center" sx={{ minHeight: 245 }}>
    <svg role="img" aria-label="Attendance status distribution" viewBox="0 0 200 200" style={{ width: 200, maxWidth: "100%", flex: "0 0 auto" }}>
      <circle cx="100" cy="100" r={radius} fill="none" stroke="#edf0f4" strokeWidth="24" />
      {slices.filter((slice) => slice.value > 0).map((slice) => {
        const segment = slice.value / total * circumference;
        const circle = <circle key={slice.status} cx="100" cy="100" r={radius} fill="none" stroke={statusColors[slice.status]} strokeWidth="24" strokeDasharray={`${segment} ${circumference - segment}`} strokeDashoffset={-offset} transform="rotate(-90 100 100)" />;
        offset += segment;
        return circle;
      })}
      <text x="100" y="96" textAnchor="middle" fontSize="29" fontWeight="700" fill="#182230">{total}</text>
      <text x="100" y="117" textAnchor="middle" fontSize="11" fill="#758194">sessions</text>
    </svg>
    <Stack spacing={1} sx={{ minWidth: 145 }}>
      {slices.map((slice) => <Stack key={slice.status} direction="row" spacing={1} alignItems="center">
        <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: statusColors[slice.status], flexShrink: 0 }} />
        <Typography variant="body2" sx={{ flex: 1 }}>{statusLabels[slice.status]}</Typography>
        <Typography variant="body2" fontWeight={700}>{slice.value}</Typography>
      </Stack>)}
    </Stack>
  </Stack>;
}

export function RetryVolumeChart({ buckets }: { buckets: RetryBucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.value));
  if (!buckets.some((bucket) => bucket.value)) return <EmptyChart message="No call attempts are recorded yet" />;
  const width = 640, height = 260, left = 42, right = 20, top = 18, bottom = 48;
  const plotHeight = height - top - bottom, plotWidth = width - left - right;
  const slot = plotWidth / buckets.length, barWidth = Math.min(76, slot * .54);
  return <svg role="img" aria-label="Sessions grouped by number of outbound call attempts" viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", height: "auto" }}>
    {[0, .5, 1].map((fraction) => {
      const y = top + plotHeight - fraction * plotHeight;
      return <g key={fraction}><line x1={left} x2={width - right} y1={y} y2={y} stroke="#e9edf2" /><text x={left - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#758194">{Math.round(max * fraction)}</text></g>;
    })}
    {buckets.map((bucket, index) => {
      const barHeight = bucket.value / max * plotHeight, x = left + slot * index + (slot - barWidth) / 2, y = top + plotHeight - barHeight;
      return <g key={bucket.label}><rect x={x} y={y} width={barWidth} height={barHeight} rx="7" fill={["#356bd1", "#4d81dd", "#e0a12e", "#d85454"][index]} /><text x={x + barWidth / 2} y={Math.max(top + 12, y - 7)} textAnchor="middle" fontSize="12" fontWeight="700" fill="#354052">{bucket.value}</text><text x={x + barWidth / 2} y={height - 18} textAnchor="middle" fontSize="11" fill="#758194">{bucket.label}</text></g>;
    })}
  </svg>;
}

const stackOrder: AttendanceChartStatus[] = ["checkout", "checkin", "processing", "delayed", "pending"];

export function LanguageOutcomeChart({ rows }: { rows: LanguageStack[] }) {
  if (!rows.some((row) => stackOrder.some((status) => row.values[status] > 0))) return <EmptyChart message="No language breakdown is available yet" />;
  const width = 680, height = 250, left = 108, right = 16, top = 18, rowGap = 45, trackWidth = width - left - right;
  const max = Math.max(1, ...rows.map((row) => stackOrder.reduce((sum, status) => sum + row.values[status], 0)));
  return <Box sx={{ width: "100%", minWidth: 0 }}>
    <svg role="img" aria-label="Attendance status by employee calling language" viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", height: "auto" }}>
      {rows.map((row, rowIndex) => {
        let x = left;
        const y = top + rowIndex * rowGap;
        const total = stackOrder.reduce((sum, status) => sum + row.values[status], 0);
        return <g key={row.label}>
          <text x={left - 10} y={y + 19} textAnchor="end" fontSize="12" fill="#596579">{row.label}</text>
          {stackOrder.map((status) => {
            const segmentWidth = row.values[status] / max * trackWidth;
            const node = segmentWidth > 0 ? <rect key={status} x={x} y={y} width={segmentWidth} height="26" fill={statusColors[status]} /> : null;
            x += segmentWidth;
            return node;
          })}
          <text x={Math.min(width - 14, left + total / max * trackWidth + 8)} y={y + 18} fontSize="11" fill="#758194">{total}</text>
        </g>;
      })}
    </svg>
    <Stack direction="row" spacing={{ xs: 1, sm: 1.75 }} useFlexGap flexWrap="wrap" justifyContent="center" sx={{ mt: 1 }}>
      {stackOrder.map((status) => <Stack key={status} direction="row" spacing={.6} alignItems="center"><Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: statusColors[status] }} /><Typography variant="caption" color="text.secondary">{statusLabels[status]}</Typography></Stack>)}
    </Stack>
  </Box>;
}
