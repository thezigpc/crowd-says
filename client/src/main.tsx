import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { basePath, ErrorBoundary, OnScreenKeyboard, VenueAnnouncement } from "@bargames/gamekit/client";
import { AdminPage } from "./pages/AdminPage";
import { HomePage } from "./pages/HomePage";
import { RoomPage } from "./pages/RoomPage";
import { useVenue } from "./venue";
import "./index.css";

/**
 * Bar Games: keeps the venue theme applied everywhere, and shows the staff's announcement on
 * phone pages. TV screens mark themselves shared (tableMode / markSharedScreen) and the strip
 * hides itself there; a ?as=table link about to join as one is hidden here. Standalone it
 * renders nothing.
 */
function Venue() {
  const venue = useVenue();
  const { search } = useLocation();
  const tableLink = new URLSearchParams(search).get("as") === "table";
  return <VenueAnnouncement ctx={venue} hidden={tableLink} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter basename={basePath()}>
        <Venue />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/join/:code" element={<HomePage />} />
          <Route path="/room/:code" element={<RoomPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {/* Kit 0.10.0: big keys under a focused field on touchscreens with no keyboard of their own
            (box 0.21.0's touch screens). Hidden on phones, tablets and PCs. ?bg_keyboard=1 to test. */}
        <OnScreenKeyboard />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
