import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button } from "@mui/material";
import { fetchCallRecording } from "../api/client";

export function CallRecording({ sessionId, attemptId }: { sessionId: string; attemptId: string }) {
  const [requested, setRequested] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const recording = useQuery({
    queryKey: ["call-recording", sessionId, attemptId],
    queryFn: () => fetchCallRecording(sessionId, attemptId),
    enabled: requested,
    retry: false,
  });

  useEffect(() => {
    if (!recording.data) return;
    const url = URL.createObjectURL(recording.data);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recording.data]);

  if (recording.isError) return <Alert severity="error">Could not load this recording. Try again after refreshing the call details.</Alert>;
  if (audioUrl) return <Box component="audio" controls preload="none" src={audioUrl} sx={{ display: "block", width: "100%", mt: 1 }} />;
  return <Button size="small" variant="outlined" disabled={recording.isFetching} onClick={() => setRequested(true)}>
    {recording.isFetching ? "Loading recording…" : "Play recording"}
  </Button>;
}
