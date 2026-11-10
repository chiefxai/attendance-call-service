import { Box, Card, CardContent, Stack, Typography } from "@mui/material";
import ContactSupportRoundedIcon from "@mui/icons-material/ContactSupportRounded";
import { PageHeader } from "../components/OperationsUI";

export function EnquiriesPage() {
  return <Stack spacing={2.5}>
    <PageHeader eyebrow="PATIENTS" title="Enquiries" description="A dedicated space for patient enquiries." />
    <Card>
      <CardContent sx={{ minHeight: 300, display: "grid", placeItems: "center", textAlign: "center", p: 4 }}>
        <Stack spacing={1.25} alignItems="center" maxWidth={420}>
          <Box sx={{ width: 56, height: 56, borderRadius: 3, display: "grid", placeItems: "center", bgcolor: "#edf4f1", color: "primary.main" }}>
            <ContactSupportRoundedIcon fontSize="large" />
          </Box>
          <Typography variant="h6" fontWeight={700}>Patient enquiries</Typography>
          <Typography variant="body2" color="text.secondary">This page is ready for the patient enquiry workflow. Its functionality can be added when the requirements are defined.</Typography>
        </Stack>
      </CardContent>
    </Card>
  </Stack>;
}
