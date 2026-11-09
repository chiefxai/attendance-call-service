import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { BrowserRouter } from "react-router-dom";
import App from "./App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

const theme = createTheme({
  palette: {
    mode: "light", primary: { main: "#1557c0", dark: "#103f91", light: "#e9efff" },
    secondary: { main: "#117aa8" }, background: { default: "#f6f8fc", paper: "#fff" },
    text: { primary: "#17253b", secondary: "#69778d" }, success: { main: "#178264" },
    warning: { main: "#c07b24" }, error: { main: "#c44747" },
  },
  shape: { borderRadius: 14 },
  typography: {
    fontFamily: 'Inter, "Segoe UI", sans-serif', h4: { fontWeight: 700, letterSpacing: "-.04em" },
    h5: { fontWeight: 700, letterSpacing: "-.03em" }, h6: { fontWeight: 650, letterSpacing: "-.02em" },
    button: { textTransform: "none", fontWeight: 650 },
  },
  components: {
    MuiCard: { styleOverrides: { root: { border: "1px solid #e8eeeb", boxShadow: "0 8px 24px rgba(31,57,48,.035)" } } },
    MuiButton: { defaultProps: { disableElevation: true } },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}><CssBaseline /><QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></ThemeProvider>
  </React.StrictMode>,
);
