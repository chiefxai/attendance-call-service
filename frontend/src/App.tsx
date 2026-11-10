import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AppBar, Avatar, Box, Divider, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Stack, Toolbar, Typography } from "@mui/material";
import GridViewRoundedIcon from "@mui/icons-material/GridViewRounded";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import FactCheckRoundedIcon from "@mui/icons-material/FactCheckRounded";
import CalendarMonthRoundedIcon from "@mui/icons-material/CalendarMonthRounded";
import HeadsetMicRoundedIcon from "@mui/icons-material/HeadsetMicRounded";
import PersonSearchRoundedIcon from "@mui/icons-material/PersonSearchRounded";
import ElderlyRoundedIcon from "@mui/icons-material/ElderlyRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import MenuBookRoundedIcon from "@mui/icons-material/MenuBookRounded";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import { ApiAccessPage } from "./pages/ApiAccessPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AttendancePage } from "./pages/AttendancePage";
import { CallCenterPage } from "./pages/CallCenterPage";
import { DutySchedulesPage } from "./pages/DutySchedulesPage";
import { AssignmentStatusPage } from "./pages/AssignmentStatusPage";
import { NewAssignmentPage } from "./pages/NewAssignmentPage";
import { OverviewPage } from "./pages/OverviewPage";
import { StaffRecordsPage } from "./pages/StaffRecordsPage";
import { PatientRecordsPage } from "./pages/PatientRecordsPage";
import { PageHeaderTargetContext } from "./components/OperationsUI";
import { LoginPage } from "./pages/LoginPage";
import { fetchCurrentUser, signOut, type WebUser } from "./api/client";

const drawerWidth = 252;
const navigation = [
  { label: "Overview", path: "/", icon: <GridViewRoundedIcon /> },
  { label: "Staff records", path: "/staff", icon: <PersonSearchRoundedIcon /> },
  { label: "Patient records", path: "/patients", icon: <ElderlyRoundedIcon /> },
  { label: "Duty schedules", path: "/schedules", icon: <CalendarMonthRoundedIcon /> },
  { label: "Attendance", path: "/attendance", icon: <FactCheckRoundedIcon /> },
  { label: "AI call center", path: "/call-center", icon: <HeadsetMicRoundedIcon /> },
  { label: "Settings", path: "/settings", icon: <SettingsRoundedIcon /> },
  { label: "API documentation", path: "/api-access", icon: <MenuBookRoundedIcon /> },
];

function App() {
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<WebUser | null>(null);
  useEffect(() => {
    fetchCurrentUser().then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setAuthChecked(true));
  }, []);
  const logout = async () => {
    try { await signOut(); } finally { setUser(null); queryClient.clear(); }
  };
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
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
      <Divider sx={{ my: 2 }} />
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 1 }}>
        <Avatar sx={{ width: 34, height: 34, bgcolor: "#dcebe5", color: "primary.dark", fontSize: 13, fontWeight: 700 }}>{(user?.displayName || user?.email || "U").slice(0, 2).toUpperCase()}</Avatar>
        <Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="body2" fontWeight={650} noWrap>{user?.displayName || "Operations user"}</Typography><Typography variant="caption" color="text.secondary" noWrap>{user?.email}</Typography></Box>
        <IconButton aria-label="Sign out" title="Sign out" onClick={() => void logout()} size="small"><LogoutRoundedIcon fontSize="small" /></IconButton>
      </Stack>
    </Box>
  );

  if (!authChecked) return <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center" }}><Typography color="text.secondary">Checking sign-in…</Typography></Box>;
  if (!user) return <LoginPage onSignedIn={setUser} />;

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", width: "100%", overflowX: "hidden" }}>
      <AppBar position="fixed" elevation={0} color="inherit" sx={{ borderBottom: "1px solid #e8eeeb", bgcolor: "rgba(255,255,255,.9)", backdropFilter: "blur(10px)", width: { md: `calc(100% - ${drawerWidth}px)` }, ml: { md: `${drawerWidth}px` } }}>
        <Toolbar sx={{ minHeight: "72px !important", px: { xs: 2, md: 4 } }}>
          <IconButton onClick={() => setMobileOpen(true)} sx={{ display: { md: "none" }, mr: 1 }} aria-label="Open navigation"><MenuRoundedIcon /></IconButton>
          <Box ref={setHeaderTarget} sx={{ flex: 1, minWidth: 0 }} />
        </Toolbar>
      </AppBar>
      <Box component="nav" sx={{ width: { xs: 0, md: drawerWidth }, flex: { xs: "0 0 0px", md: `0 0 ${drawerWidth}px` }, minWidth: 0 }} aria-label="Primary navigation">
        <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }} sx={{ display: { xs: "block", md: "none" }, "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box" } }}>{drawer}</Drawer>
        <Drawer variant="permanent" open sx={{ display: { xs: "none", md: "block" }, "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box", borderRight: "1px solid #e8eeeb" } }}>{drawer}</Drawer>
      </Box>
      <Box component="main" sx={{ flex: "1 1 auto", minWidth: 0, maxWidth: { xs: "100%", md: `calc(100% - ${drawerWidth}px)` }, boxSizing: "border-box", px: { xs: 1.5, sm: 3, lg: 5 }, pt: { xs: "128px", sm: "104px" }, pb: 6 }}>
        <PageHeaderTargetContext.Provider value={headerTarget}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/schedules" element={<DutySchedulesPage />} />
          <Route path="/call-center" element={<CallCenterPage />} />
          <Route path="/staff" element={<StaffRecordsPage />} />
          <Route path="/patients" element={<PatientRecordsPage />} />
          <Route path="/assignments/new" element={<NewAssignmentPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/api-access" element={<ApiAccessPage section="docs" />} />
          <Route path="/sessions/:sessionId" element={<AssignmentStatusPage />} />
          <Route path="*" element={<OverviewPage />} />
        </Routes>
        </PageHeaderTargetContext.Provider>
      </Box>
    </Box>
  );
}

export default App;
