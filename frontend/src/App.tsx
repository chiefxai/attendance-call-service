import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { AppBar, Avatar, Box, Button, Chip, Divider, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Stack, Toolbar, Typography } from "@mui/material";
import GridViewRoundedIcon from "@mui/icons-material/GridViewRounded";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import NotificationsNoneRoundedIcon from "@mui/icons-material/NotificationsNoneRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import FactCheckRoundedIcon from "@mui/icons-material/FactCheckRounded";
import CalendarMonthRoundedIcon from "@mui/icons-material/CalendarMonthRounded";
import HeadsetMicRoundedIcon from "@mui/icons-material/HeadsetMicRounded";
import PersonSearchRoundedIcon from "@mui/icons-material/PersonSearchRounded";
import ElderlyRoundedIcon from "@mui/icons-material/ElderlyRounded";
import VpnKeyRoundedIcon from "@mui/icons-material/VpnKeyRounded";
import { ApiAccessPage } from "./pages/ApiAccessPage";
import { AttendancePage } from "./pages/AttendancePage";
import { CallCenterPage } from "./pages/CallCenterPage";
import { DutySchedulesPage } from "./pages/DutySchedulesPage";
import { AssignmentStatusPage } from "./pages/AssignmentStatusPage";
import { NewAssignmentPage } from "./pages/NewAssignmentPage";
import { OverviewPage } from "./pages/OverviewPage";
import { StaffRecordsPage } from "./pages/StaffRecordsPage";
import { PatientRecordsPage } from "./pages/PatientRecordsPage";

const drawerWidth = 252;
const navigation = [
  { label: "Overview", path: "/", icon: <GridViewRoundedIcon /> },
  { label: "Staff records", path: "/staff", icon: <PersonSearchRoundedIcon /> },
  { label: "Patient records", path: "/patients", icon: <ElderlyRoundedIcon /> },
  { label: "Duty schedules", path: "/schedules", icon: <CalendarMonthRoundedIcon /> },
  { label: "Attendance", path: "/attendance", icon: <FactCheckRoundedIcon /> },
  { label: "AI call center", path: "/call-center", icon: <HeadsetMicRoundedIcon /> },
  { label: "API keys & docs", path: "/api-access", icon: <VpnKeyRoundedIcon /> },
];

function App() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const activeNav = navigation.find((item) => item.path === location.pathname);
  const title = activeNav?.label || (location.pathname.startsWith("/sessions/") ? "Session status" : "Operations");

  const drawer = (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", px: 2, py: 2.5, overflowY: "auto" }}>
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 1, mb: 4 }}>
        <Box sx={{ width: 38, height: 38, borderRadius: 2.5, display: "grid", placeItems: "center", bgcolor: "primary.main", color: "white", fontWeight: 800, fontSize: 18 }}>A</Box>
        <Box><Typography fontWeight={750} lineHeight={1.15}>ATHULYA AI <Typography component="span" variant="caption" color="text.secondary">v2.4</Typography></Typography><Typography variant="caption" color="text.secondary">Workforce intelligence</Typography></Box>
      </Stack>
      <Typography variant="overline" color="text.secondary" sx={{ px: 1.5, letterSpacing: ".12em", fontWeight: 700 }}>WORKSPACE</Typography>
      <List sx={{ mt: 1, p: 0 }}>
        {navigation.map((item) => (
          <ListItemButton key={item.path} component={NavLink} to={item.path} onClick={() => setMobileOpen(false)}
            sx={{ borderRadius: 2.5, mb: 0.5, py: 1.15, color: "text.secondary", "&.active": { color: "primary.dark", bgcolor: "#eaf3ef", "& .MuiListItemIcon-root": { color: "primary.main" } } }}>
            <ListItemIcon sx={{ minWidth: 38, color: "inherit" }}>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14, fontWeight: 650 }} />
          </ListItemButton>
        ))}
      </List>
      <Box sx={{ flexGrow: 1 }} />
      <Box sx={{ bgcolor: "#f5f8f6", border: "1px solid #e7eeea", borderRadius: 3, p: 2 }}>
        <Chip size="small" label="VOICE GATEWAY" sx={{ height: 22, fontSize: 9, letterSpacing: ".08em", fontWeight: 800, bgcolor: "#e9efff", color: "primary.dark" }} />
        <Typography variant="body2" fontWeight={650} sx={{ mt: 1.25 }}>Outbound attendance</Typography>
        <Typography variant="caption" color="text.secondary">Vobiz · Vertex AI · PostgreSQL</Typography>
      </Box>
      <Divider sx={{ my: 2 }} />
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 1 }}>
        <Avatar sx={{ width: 34, height: 34, bgcolor: "#dcebe5", color: "primary.dark", fontSize: 13, fontWeight: 700 }}>OP</Avatar>
        <Box><Typography variant="body2" fontWeight={650}>Operations team</Typography><Typography variant="caption" color="text.secondary">Workspace admin</Typography></Box>
      </Stack>
    </Box>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar position="fixed" elevation={0} color="inherit" sx={{ borderBottom: "1px solid #e8eeeb", bgcolor: "rgba(255,255,255,.9)", backdropFilter: "blur(10px)", width: { md: `calc(100% - ${drawerWidth}px)` }, ml: { md: `${drawerWidth}px` } }}>
        <Toolbar sx={{ minHeight: "72px !important", px: { xs: 2, md: 4 } }}>
          <IconButton onClick={() => setMobileOpen(true)} sx={{ display: { md: "none" }, mr: 1 }} aria-label="Open navigation"><MenuRoundedIcon /></IconButton>
          <Box sx={{ flexGrow: 1 }}><Typography variant="body2" color="text.secondary">Athulya Senior Care / Operations</Typography><Typography fontWeight={700}>{title}</Typography></Box>
          <Chip label="Outbound only" size="small" sx={{ bgcolor: "#edf6f2", color: "#246b59", fontWeight: 650, display: { xs: "none", sm: "inline-flex" } }} />
          <IconButton sx={{ ml: 1 }} aria-label="Notifications"><NotificationsNoneRoundedIcon /></IconButton>
          <Button component={NavLink} to="/assignments/new" variant="contained" startIcon={<AddRoundedIcon />} sx={{ ml: 1.5, display: { xs: "none", sm: "inline-flex" } }}>New assignment</Button>
        </Toolbar>
      </AppBar>
      <Box component="nav" sx={{ width: { md: drawerWidth }, flexShrink: { md: 0 } }} aria-label="Primary navigation">
        <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }} sx={{ display: { xs: "block", md: "none" }, "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box" } }}>{drawer}</Drawer>
        <Drawer variant="permanent" open sx={{ display: { xs: "none", md: "block" }, "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box", borderRight: "1px solid #e8eeeb" } }}>{drawer}</Drawer>
      </Box>
      <Box component="main" sx={{ flexGrow: 1, width: { md: `calc(100% - ${drawerWidth}px)` }, px: { xs: 2, sm: 3, lg: 5 }, pt: "104px", pb: 6 }}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/schedules" element={<DutySchedulesPage />} />
          <Route path="/call-center" element={<CallCenterPage />} />
          <Route path="/staff" element={<StaffRecordsPage />} />
          <Route path="/patients" element={<PatientRecordsPage />} />
          <Route path="/assignments/new" element={<NewAssignmentPage />} />
          <Route path="/api-access" element={<ApiAccessPage />} />
          <Route path="/sessions/:sessionId" element={<AssignmentStatusPage />} />
          <Route path="*" element={<OverviewPage />} />
        </Routes>
      </Box>
    </Box>
  );
}

export default App;
